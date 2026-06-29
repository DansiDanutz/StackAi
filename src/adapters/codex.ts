/**
 * Codex adapter (codex-cli).
 *
 * Capability matrix row:
 *   headless:  `exec` subcommand (prefixArgs) + PROMPT positional
 *   model:     `-m <id>`
 *   json:      `--json` (JSONL events)
 *   full-auto: `--dangerously-bypass-approvals-and-sandbox`
 *   mcp:       `--mcp-config`-style via config; mcp-server via `mcp-server`
 *   resume:    `exec resume` (Phase 1+)
 *
 * Codex gates headless behind `exec`, which is in prefixArgs.
 */
import { BaseAdapter, resolveWithDefault } from "./base.js";
import type {
  AdapterCapabilities,
  AgentEvent,
  AgentName,
  ModelRouter,
  RunRequest,
} from "../types.js";

export class CodexAdapter extends BaseAdapter {
  readonly name: AgentName = "codex";
  readonly capabilities: AdapterCapabilities = {
    jsonStream: true,
    modelSelection: true,
    mcpClient: true,
    mcpServer: true,
    sessionResume: true,
    fullAuto: true,
    acpServer: false,
  };

  get displayName(): string {
    return "Codex";
  }

  resolveModel(alias: string, router: ModelRouter): string | undefined {
    return resolveWithDefault(this.name, alias, router, this.cfg.defaultModel);
  }

  buildCommand(req: RunRequest, router: ModelRouter) {
    const args: string[] = [...(this.cfg.prefixArgs ?? [])];

    // Verbosity: --json emits JSONL events; otherwise plain text.
    if (req.verbosity !== "text") args.push("--json");

    const model = this.resolveModel(req.model ?? "auto", router);
    // Only pass -m when a specific model is requested. Codex in ChatGPT-login
    // mode rejects model ids like gpt-5-codex ("not supported with a ChatGPT
    // account"); omitting -m lets codex pick its own model. Skip on "auto".
    if (model && model !== "auto" && this.capabilities.modelSelection) {
      args.push("-m", model);
    }

    // Safety: codex's nuclear flag is the cleanest full-auto toggle.
    if (req.posture === "full-auto") {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    }

    // MCP config files (codex reads TOML by default; JSON files via -c accepted in
    // some builds — pass as -c mcp_servers path; keep simple: append if present).
    if (req.mcpConfig?.length) {
      for (const f of req.mcpConfig) args.push("-c", `mcp_servers_config="${f}"`);
    }

    if (req.extraArgs?.length) args.push(...req.extraArgs);

    // Positional prompt last. `-` reads from stdin; a literal arg is fine too.
    args.push(req.prompt);

    return { cmd: this.cfg.command, args, env: {} };
  }

  /**
   * Parse codex JSONL events. Codex emits one JSON object per line with a
   * `type` field (e.g. message, function_call, reasoning, item_completed,
   * session_created). We map the common ones.
   */
  parseEvent(raw: unknown): AgentEvent | null {
    if (typeof raw !== "object" || raw === null) return null;
    const e = raw as Record<string, any>;
    const t = e.type ?? e.msg_type;

    switch (t) {
      case "thread.started":
        return { type: "system", subtype: "init", message: `thread ${e.thread_id ?? ""}` };

      case "turn.started":
        return null;

      case "session_created":
        return {
          type: "system",
          subtype: "init",
          message: `session ${e.session_id ?? ""}`,
        };

      case "message":
      case "response_message": {
        const text = e.payload?.text ?? e.text ?? e.content ?? "";
        if (text) return { type: "assistant", subtype: "text", text: String(text) };
        return null;
      }

      case "reasoning":
        return {
          type: "assistant",
          subtype: "thinking",
          text: String(e.payload?.text ?? e.text ?? ""),
        };

      case "function_call":
        return {
          type: "tool_use",
          id: String(e.id ?? e.call_id ?? ""),
          name: String(e.payload?.name ?? e.name ?? ""),
          input: e.payload?.arguments ?? e.arguments,
        };

      case "function_call_output": {
        if (e.payload?.output != null) {
          return {
            type: "tool_result",
            id: String(e.id ?? ""),
            content: String(e.payload.output).slice(0, 4000),
          };
        }
        return null;
      }

      // Codex stream-json: {"type":"item.completed","item":{...}}
      case "item.completed":
      case "item_completed": {
        const item = e.item ?? e.payload;
        if (!item) return null;
        if (item.type === "agent_message" && item.text) {
          return { type: "assistant", subtype: "text", text: String(item.text) };
        }
        if (item.type === "tool_call" || item.type === "function_call") {
          return { type: "tool_use", id: String(item.id ?? ""), name: String(item.name ?? ""), input: item.arguments ?? item.input };
        }
        if (item.type === "tool_call_output" || item.output != null) {
          return { type: "tool_result", id: String(item.id ?? ""), content: String(item.output ?? "").slice(0, 4000) };
        }
        if (item.type === "error") {
          return { type: "error", message: String(item.message ?? "codex error"), recoverable: false };
        }
        return null;
      }

      case "turn.completed":
      case "turn_completed":
        return { type: "done", exitCode: 0, finalText: "" };

      case "token_count":
        return {
          type: "cost",
          inputTokens: e.input_tokens,
          outputTokens: e.output_tokens,
        };

      case "completed":
      case "turn_completed":
        return {
          type: "done",
          exitCode: 0,
          finalText: String(e.payload?.text ?? e.text ?? ""),
          sessionId: e.session_id,
        };

      default:
        return null;
    }
  }
}

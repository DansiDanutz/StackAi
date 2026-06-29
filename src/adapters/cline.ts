/**
 * Cline adapter (open-source edit-format agent, ACP-native).
 *
 * Encodes the verified cline flag matrix:
 *   headless:  positional prompt (default mode runs it)
 *   plan:      -p/--plan (plan mode)
 *   model:     -P/--provider <id>, -m/--model <id>, -k/--key
 *   json:      --json (output messages as JSON)
 *   full-auto: --auto-approve true
 *   mcp:       `cline mcp` subcommand (client)
 *   ACP:       --acp (native — bypasses stream-json via the ACP client)
 *   background:-z/--zen (background hub session)
 *
 * Cline is a genuinely distinct agent (its own edit-format loop), so it adds
 * diversity to an ensemble beyond Claude/Codex.
 */
import { BaseAdapter, resolveWithDefault } from "./base.js";
import type {
  AdapterCapabilities, AgentEvent, AgentName, ModelRouter, RunRequest,
} from "../types.js";

export class ClineAdapter extends BaseAdapter {
  readonly name: AgentName = "cline";
  readonly capabilities: AdapterCapabilities = {
    jsonStream: true,
    modelSelection: true,
    mcpClient: true,
    mcpServer: false,
    sessionResume: false,
    fullAuto: true,
    acpServer: true, // --acp
  };

  get displayName(): string { return "Cline"; }

  resolveModel(alias: string, router: ModelRouter): string | undefined {
    return resolveWithDefault(this.name, alias, router, this.cfg.defaultModel);
  }

  /** ACP: `cline --acp` — structured events via the JSON-RPC client. */
  acpCommand(): { cmd: string; args: string[] } | null {
    return { cmd: this.cfg.command, args: ["--acp"] };
  }

  buildCommand(req: RunRequest, router: ModelRouter) {
    const args: string[] = [];
    if (req.verbosity !== "text") args.push("--json");

    const model = this.resolveModel(req.model ?? "auto", router);
    if (model && this.capabilities.modelSelection) {
      args.push("-m", model);
    }
    if (this.cfg.defaultProvider) args.push("-P", this.cfg.defaultProvider);

    if (req.posture === "full-auto") args.push("--auto-approve", "true");
    if (req.extraArgs?.length) args.push(...req.extraArgs);

    // Positional prompt last.
    args.push(req.prompt);
    return { cmd: this.cfg.command, args, env: {} };
  }

  /**
   * Parse cline --json events. Cline emits JSON message objects; we map the
   * common shapes. On the ACP path this parser is bypassed (base delegates to
   * the ACP client), so this is the stream-json fallback.
   */
  parseEvent(raw: unknown): AgentEvent | null {
    if (typeof raw !== "object" || raw === null) return null;
    const e = raw as Record<string, any>;
    const t = e.type ?? e.kind ?? e.role;

    if (t === "assistant" || e.say === "text") {
      return { type: "assistant", subtype: "text", text: String(e.text ?? e.content ?? e.message ?? "") };
    }
    if (t === "tool" || t === "tool_use" || e.say === "tool") {
      return {
        type: "tool_use",
        id: String(e.id ?? e.toolCallId ?? ""),
        name: String(e.name ?? e.tool ?? ""),
        input: e.input ?? e.args,
      };
    }
    if (t === "tool_result" || e.say === "tool_result") {
      return {
        type: "tool_result",
        id: String(e.id ?? ""),
        content: String(e.content ?? e.output ?? "").slice(0, 4000),
        isError: Boolean(e.error),
      };
    }
    if (t === "reasoning" || e.say === "reasoning" || e.thinking) {
      return { type: "assistant", subtype: "thinking", text: String(e.text ?? e.content ?? e.thinking ?? "") };
    }
    if (t === "done" || t === "end" || t === "result" || e.done === true) {
      return {
        type: "done",
        exitCode: 0,
        finalText: String(e.text ?? e.content ?? e.result ?? ""),
        sessionId: e.sessionId ?? e.session_id,
      };
    }
    return null;
  }
}

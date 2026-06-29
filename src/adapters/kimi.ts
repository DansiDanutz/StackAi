/**
 * Kimi CLI adapter.
 *
 * Capability matrix row (gotchas encoded):
 *   headless:  ⚠️ needs BOTH `--prompt` and `--print`
 *   model:     `-m <id>`
 *   json:      `--output-format stream-json` (requires --print)
 *   full-auto: `--afk` (auto-dismiss prompts + approve tools) / `--yolo`
 *   mcp:       client via `--mcp-config`; server via ACP `acp`
 *   resume:    `-S/--session <id>`, `-C/--continue`
 */
import { BaseAdapter, resolveWithDefault } from "./base.js";
import type {
  AdapterCapabilities,
  AgentEvent,
  AgentName,
  ModelRouter,
  RunRequest,
} from "../types.js";

export class KimiAdapter extends BaseAdapter {
  readonly name: AgentName = "kimi";
  readonly capabilities: AdapterCapabilities = {
    jsonStream: true,
    modelSelection: true,
    mcpClient: true,
    mcpServer: true, // via ACP
    sessionResume: true,
    fullAuto: true,
    acpServer: true,
  };

  get displayName(): string {
    return "Kimi";
  }

  resolveModel(alias: string, router: ModelRouter): string | undefined {
    return resolveWithDefault(this.name, alias, router, this.cfg.defaultModel);
  }

  /** Launch kimi as an ACP server: `kimi acp`. */
  acpCommand(): { cmd: string; args: string[] } | null {
    return { cmd: this.cfg.command, args: ["acp"] };
  }

  buildCommand(req: RunRequest, router: ModelRouter) {
    const args: string[] = [];

    // ⚠️ kimi requires BOTH --prompt and --print for headless.
    args.push("--prompt", req.prompt, "--print");

    const verbosity = req.verbosity ?? "stream-json";
    if (verbosity === "stream-json") {
      args.push("--output-format", "stream-json");
    } else if (verbosity === "text") {
      args.push("--output-format", "text");
    }

    const model = this.resolveModel(req.model ?? "auto", router);
    if (model && this.capabilities.modelSelection) args.push("-m", model);

    // Safety: --afk is the dedicated unattended mode.
    if (req.posture === "full-auto") args.push("--afk");

    if (req.mcpConfig?.length) args.push("--mcp-config-file", req.mcpConfig[0]!);

    if (req.sessionId) args.push("--session", req.sessionId);

    if (req.extraArgs?.length) args.push(...req.extraArgs);

    return { cmd: this.cfg.command, args, env: {} };
  }

  /**
   * Parse kimi stream-json. Kimi is Claude-Code-compatible in its stream shape,
   * so this mirrors the claude parser's cases (system/assistant/user/result).
   */
  parseEvent(raw: unknown): AgentEvent | null {
    if (typeof raw !== "object" || raw === null) return null;
    const e = raw as Record<string, any>;

    switch (e.type) {
      case "system":
        if (e.subtype === "init" && e.session_id)
          return { type: "system", subtype: "init", message: `session ${e.session_id}` };
        return { type: "system", subtype: e.subtype, message: e.message ?? "" };

      case "assistant": {
        const content = Array.isArray(e.message?.content) ? e.message.content : [];
        for (const block of content) {
          if (block.type === "text" && block.text)
            return { type: "assistant", subtype: "text", text: block.text };
          if (block.type === "thinking" && block.thinking)
            return { type: "assistant", subtype: "thinking", text: block.thinking };
          if (block.type === "tool_use")
            return {
              type: "tool_use",
              id: String(block.id ?? ""),
              name: String(block.name ?? ""),
              input: block.input,
            };
        }
        return null;
      }

      case "user": {
        const content = Array.isArray(e.message?.content) ? e.message.content : [];
        for (const block of content) {
          if (block.type === "tool_result") {
            const text =
              typeof block.content === "string"
                ? block.content
                : Array.isArray(block.content)
                  ? block.content.map((c: any) => c.text ?? "").join("")
                  : "";
            return {
              type: "tool_result",
              id: String(block.tool_use_id ?? ""),
              content: text,
              isError: Boolean(block.is_error),
            };
          }
        }
        return null;
      }

      case "result":
        return {
          type: "done",
          exitCode: 0,
          finalText: e.result ?? "",
          sessionId: e.session_id,
        };

      default:
        return null;
    }
  }
}

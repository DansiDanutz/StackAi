/**
 * DeepSeek adapter (DeepSeek model family agent, MCP-capable).
 *
 * Encodes the verified deepseek flag matrix:
 *   headless:  `exec` subcommand + positional prompt
 *   model:     resolved via provider config (no per-run flag surfaced; uses
 *              the deepseek provider's default — `deepseek model` to list)
 *   json:      --output-format stream-json  (or --json for a summary blob)
 *   full-auto: --auto (agentic mode with tool access)
 *   mcp:       `deepseek mcp` (client) + `deepseek mcp-server` (serve over stdio)
 *   resume:    --resume <id>, --continue
 *
 * Adds genuine model diversity: DeepSeek-R1/V3 reasoning, which the fleet lacks.
 */
import { BaseAdapter, resolveWithDefault } from "./base.js";
import type {
  AdapterCapabilities, AgentEvent, AgentName, ModelRouter, RunRequest,
} from "../types.js";

export class DeepseekAdapter extends BaseAdapter {
  readonly name: AgentName = "deepseek";
  readonly capabilities: AdapterCapabilities = {
    jsonStream: true,
    modelSelection: false, // deepselect resolves via provider config, no per-run flag
    mcpClient: true,
    mcpServer: true, // mcp-server subcommand
    sessionResume: true,
    fullAuto: true,
    acpServer: false,
  };

  get displayName(): string { return "DeepSeek"; }

  resolveModel(_alias: string, _router: ModelRouter): string | undefined {
    return undefined; // deepselect uses provider default
  }

  buildCommand(req: RunRequest, _router: ModelRouter) {
    const args: string[] = ["exec"]; // headless gated behind exec

    const verbosity = req.verbosity ?? "stream-json";
    if (verbosity === "stream-json") {
      args.push("--output-format", "stream-json");
    } else if (verbosity === "json") {
      args.push("--json");
    }

    if (req.posture === "full-auto") args.push("--auto");
    if (req.sessionId) args.push("--resume", req.sessionId);

    if (req.extraArgs?.length) args.push(...req.extraArgs);

    // Positional prompt last.
    args.push(req.prompt);
    return { cmd: this.cfg.command, args, env: {} };
  }

  /**
   * Parse deepseek --output-format stream-json events. Deepseek's TUI is a
   * Claude-Code-compatible agent, so events mirror the system/assistant/user/
   * result shape. We handle it defensively.
   */
  parseEvent(raw: unknown): AgentEvent | null {
    if (typeof raw !== "object" || raw === null) return null;
    const e = raw as Record<string, any>;
    const t = e.type ?? e.kind;

    switch (t) {
      case "system":
        if (e.subtype === "init" && e.session_id)
          return { type: "system", subtype: "init", message: `session ${e.session_id}` };
        return { type: "system", subtype: e.subtype, message: e.message ?? "" };

      case "assistant": {
        const content = Array.isArray(e.message?.content) ? e.message.content : [];
        for (const block of content) {
          if (block.type === "text" && block.text)
            return { type: "assistant", subtype: "text", text: block.text };
          if (block.type === "tool_use")
            return { type: "tool_use", id: String(block.id ?? ""), name: String(block.name ?? ""), input: block.input };
        }
        return null;
      }

      case "user": {
        const content = Array.isArray(e.message?.content) ? e.message.content : [];
        for (const block of content) {
          if (block.type === "tool_result") {
            const text = typeof block.content === "string"
              ? block.content
              : Array.isArray(block.content) ? block.content.map((c: any) => c.text ?? "").join("") : "";
            return { type: "tool_result", id: String(block.tool_use_id ?? ""), content: text, isError: Boolean(block.is_error) };
          }
        }
        return null;
      }

      case "result":
        return { type: "done", exitCode: 0, finalText: e.result ?? "", sessionId: e.session_id };

      default:
        return null;
    }
  }
}

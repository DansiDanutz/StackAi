/**
 * OpenCode adapter.
 *
 * Capability matrix row:
 *   headless:  `run` subcommand (prefixArgs) + message positional
 *   model:     `-m provider/model` (strict format)
 *   json:      `--format json` (raw JSON events)
 *   full-auto: none (run is inherently non-interactive; use auth)
 *   mcp:       client via `mcp`; server via ACP `acp`
 *   resume:    `-c/--continue`, `-s/--session <id>`
 */
import { BaseAdapter, resolveWithDefault } from "./base.js";
import type {
  AdapterCapabilities,
  AgentEvent,
  AgentName,
  ModelRouter,
  RunRequest,
} from "../types.js";

export class OpencodeAdapter extends BaseAdapter {
  readonly name: AgentName = "opencode";
  readonly capabilities: AdapterCapabilities = {
    jsonStream: true,
    modelSelection: true,
    mcpClient: true,
    mcpServer: true, // via ACP
    sessionResume: true,
    fullAuto: false,
    acpServer: true,
  };

  get displayName(): string {
    return "OpenCode";
  }

  resolveModel(alias: string, router: ModelRouter): string | undefined {
    return resolveWithDefault(this.name, alias, router, this.cfg.defaultModel);
  }

  /** Launch opencode as an ACP server: `opencode acp`. */
  acpCommand(): { cmd: string; args: string[] } | null {
    return { cmd: this.cfg.command, args: ["acp"] };
  }

  buildCommand(req: RunRequest, router: ModelRouter) {
    const args: string[] = [...(this.cfg.prefixArgs ?? [])];

    if (req.verbosity !== "text") args.push("--format", "json");

    const model = this.resolveModel(req.model ?? "auto", router);
    if (model && this.capabilities.modelSelection) args.push("-m", model);

    if (req.sessionId) args.push("--session", req.sessionId);

    if (req.extraArgs?.length) args.push(...req.extraArgs);

    args.push(req.prompt);

    return { cmd: this.cfg.command, args, env: {} };
  }

  /**
   * Parse opencode JSON events. With `--format json`, opencode emits JSON
   * objects per event with `type` (session, message, tool, part, finish).
   */
  parseEvent(raw: unknown): AgentEvent | null {
    if (typeof raw !== "object" || raw === null) return null;
    const e = raw as Record<string, any>;

    switch (e.type) {
      case "session":
        return { type: "system", subtype: "init", message: `session ${e.id ?? ""}` };

      case "message": {
        const text = String(e.content ?? "");
        if (e.role === "assistant") {
          return { type: "assistant", subtype: "text", text };
        }
        return { type: "system", message: text };
      }

      case "part": {
        if (e.part?.type === "text")
          return { type: "assistant", subtype: "text", text: String(e.part.text ?? "") };
        if (e.part?.type === "tool")
          return {
            type: "tool_use",
            id: String(e.part.id ?? ""),
            name: String(e.part.name ?? ""),
            input: e.part.input,
          };
        return null;
      }

      case "tool":
        return {
          type: e.output != null ? "tool_result" : "tool_use",
          id: String(e.id ?? ""),
          name: String(e.name ?? ""),
          content: e.output != null ? String(e.output).slice(0, 4000) : "",
        };

      case "finish":
        return {
          type: "done",
          exitCode: 0,
          finalText: String(e.content ?? ""),
          sessionId: e.session_id,
        };

      default:
        return null;
    }
  }
}

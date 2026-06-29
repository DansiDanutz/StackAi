/**
 * Pi adapter (Earendil pi-coding-agent).
 *
 * Capability matrix row (gotchas encoded):
 *   headless:  `-p/--print <prompt>`
 *   model:     `--model <pattern>` / `--provider <name>`
 *   json:      `--mode json`
 *   full-auto: NONE (tool allowlist only; no global yolo flag)
 *   mcp:       ✗ none — pi uses its own extension system. NOT on the MCP bus.
 *   resume:    `-r/--resume`, `--session <id>`
 *
 * pi is executor-only. Capability gating keeps it out of any MCP routing.
 */
import { BaseAdapter, resolveWithDefault } from "./base.js";
import type {
  AdapterCapabilities,
  AgentEvent,
  AgentName,
  ModelRouter,
  RunRequest,
} from "../types.js";

export class PiAdapter extends BaseAdapter {
  readonly name: AgentName = "pi";
  readonly capabilities: AdapterCapabilities = {
    jsonStream: true,
    modelSelection: true,
    mcpClient: false, // pi has no MCP
    mcpServer: false,
    sessionResume: true,
    fullAuto: false, // no global skip-permissions flag
    acpServer: false,
  };

  get displayName(): string {
    return "Pi";
  }

  resolveModel(alias: string, router: ModelRouter): string | undefined {
    return resolveWithDefault(this.name, alias, router, this.cfg.defaultModel);
  }

  buildCommand(req: RunRequest, router: ModelRouter) {
    const args: string[] = ["-p", req.prompt];

    // pi uses --mode json (not --output-format).
    if (req.verbosity !== "text") args.push("--mode", "json");

    const model = this.resolveModel(req.model ?? "auto", router);
    if (model && this.capabilities.modelSelection) args.push("--model", model);

    if (req.sessionId) args.push("--session", req.sessionId);

    // pi has no full-auto flag; posture is a no-op here (tool allowlist only).
    if (req.extraArgs?.length) args.push(...req.extraArgs);

    return { cmd: this.cfg.command, args, env: {} };
  }

  /**
   * Parse pi --mode json events. Pi emits a stream of JSON objects describing
   * turns; the final object carries the assistant message. Shapes vary, so we
   * handle the common keys defensively.
   */
  parseEvent(raw: unknown): AgentEvent | null {
    if (typeof raw !== "object" || raw === null) return null;
    const e = raw as Record<string, any>;
    const t = e.type ?? e.kind;

    if (e.role === "assistant" || t === "message" || t === "assistant") {
      const text = e.content ?? e.text ?? e.message ?? "";
      if (text) return { type: "assistant", subtype: "text", text: String(text) };
    }
    if (e.role === "user" && e.content) {
      return null; // user echo — skip
    }
    if (t === "tool_use" || t === "function_call" || e.tool) {
      return {
        type: "tool_use",
        id: String(e.id ?? e.call_id ?? ""),
        name: String(e.name ?? e.tool ?? ""),
        input: e.input ?? e.arguments,
      };
    }
    if (t === "tool_result" || t === "function_call_output") {
      return {
        type: "tool_result",
        id: String(e.id ?? ""),
        content: String(e.content ?? e.output ?? "").slice(0, 4000),
      };
    }
    if (t === "done" || t === "end" || t === "finish" || e.done === true) {
      return {
        type: "done",
        exitCode: 0,
        finalText: String(e.content ?? e.text ?? ""),
        sessionId: e.session ?? e.session_id,
      };
    }
    return null;
  }
}

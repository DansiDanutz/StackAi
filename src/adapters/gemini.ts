/**
 * Gemini CLI adapter.
 *
 * Capability matrix row (gotchas encoded):
 *   headless:  `-p/--prompt <prompt>`  ⚠️ here -p means PROMPT, not print!
 *   model:     `-m <id>`
 *   json:      `-o/--output-format json|stream-json`
 *   full-auto: `-y/--yolo`, `--approval-mode yolo`
 *   mcp:       client via `mcp`; server via ACP `--acp` (no stdio serve)
 *   resume:    `-r/--resume <index|latest>`
 */
import { BaseAdapter, resolveWithDefault } from "./base.js";
import type {
  AdapterCapabilities,
  AgentEvent,
  AgentName,
  ModelRouter,
  RunRequest,
} from "../types.js";

export class GeminiAdapter extends BaseAdapter {
  readonly name: AgentName = "gemini";
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
    return "Gemini";
  }

  resolveModel(alias: string, router: ModelRouter): string | undefined {
    return resolveWithDefault(this.name, alias, router, this.cfg.defaultModel);
  }

  // NOTE: gemini --acp starts a session but the ACP event stream isn't reliably
  // consumable across builds; the stream-json path (-p + -o) is proven live, so
  // we return null to disable ACP routing and use buildCommand() instead.
  acpCommand(): { cmd: string; args: string[] } | null {
    return null;
  }

  buildCommand(req: RunRequest, router: ModelRouter) {
    const args: string[] = [];

    // ⚠️ gemini's -p IS the prompt, not "print". Output format is separate.
    args.push("-p", req.prompt);

    const verbosity = req.verbosity ?? "stream-json";
    if (verbosity === "stream-json") args.push("-o", "stream-json");
    else if (verbosity === "json") args.push("-o", "json");

    const model = this.resolveModel(req.model ?? "auto", router);
    if (model && this.capabilities.modelSelection) args.push("-m", model);

    // Safety: -y/--yolo is the full-auto equivalent.
    if (req.posture === "full-auto") args.push("--yolo");

    if (req.sessionId) args.push("--session-id", req.sessionId);

    if (req.extraArgs?.length) args.push(...req.extraArgs);

    return { cmd: this.cfg.command, args, env: {} };
  }

  /**
   * Parse gemini stream-json events. Gemini emits JSON objects keyed by event
   * type (e.g. {text: ...}, {toolCall: ...}, {turnComplete: true}). The exact
   * schema varies by build; we handle the documented shapes defensively.
   */
  parseEvent(raw: unknown): AgentEvent | null {
    if (typeof raw !== "object" || raw === null) return null;
    const e = raw as Record<string, any>;

    if (typeof e.text === "string") {
      return { type: "assistant", subtype: "text", text: e.text };
    }
    if (e.thought === true && typeof e.text === "string") {
      return { type: "assistant", subtype: "thinking", text: e.text };
    }
    if (e.toolCall) {
      return {
        type: "tool_use",
        id: String(e.toolCall.id ?? ""),
        name: String(e.toolCall.name ?? ""),
        input: e.toolCall.input ?? e.toolCall.args,
      };
    }
    if (e.toolResult) {
      return {
        type: "tool_result",
        id: String(e.toolResult.id ?? ""),
        content: String(e.toolResult.output ?? e.toolResult.content ?? "").slice(0, 4000),
        isError: Boolean(e.toolResult.error),
      };
    }
    if (e.turnComplete === true || e.finishReason) {
      return {
        type: "done",
        exitCode: 0,
        finalText: typeof e.text === "string" ? e.text : "",
      };
    }
    if (e.usageMetadata) {
      return {
        type: "cost",
        inputTokens: e.usageMetadata.promptTokenCount,
        outputTokens: e.usageMetadata.candidatesTokenCount,
      };
    }
    return null;
  }
}

/**
 * Claude Code adapter (reference implementation).
 *
 * Encodes the claude row of the capability matrix:
 *   headless:  `-p` / `--print`
 *   model:     `--model <id>`
 *   json:      `--output-format stream-json`
 *   full-auto: `--dangerously-skip-permissions`
 *   mcp:       `--mcp-config <file>`
 *   resume:    `--resume <id>` / `--continue`
 *
 * The other 8 adapters follow this same shape; only buildCommand + parseEvent differ.
 */
import { BaseAdapter, resolveWithDefault } from "./base.js";
import type {
  AdapterCapabilities,
  AgentEvent,
  AgentName,
  ModelRouter,
  RunRequest,
} from "../types.js";

export class ClaudeAdapter extends BaseAdapter {
  readonly name: AgentName = "claude";
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
    return "Claude Code";
  }

  resolveModel(alias: string, router: ModelRouter): string | undefined {
    return resolveWithDefault(this.name, alias, router, this.cfg.defaultModel);
  }

  buildCommand(req: RunRequest, router: ModelRouter) {
    const args: string[] = ["-p", req.prompt];

    // Verbosity → output format. stream-json requires -p (always set above).
    const verbosity = req.verbosity ?? "stream-json";
    if (verbosity === "stream-json") {
      args.push("--output-format", "stream-json", "--verbose");
    } else if (verbosity === "json") {
      args.push("--output-format", "json");
    }

    // Model: alias → claude model id via router.
    const model = this.resolveModel(req.model ?? "auto", router);
    if (model && this.capabilities.modelSelection) {
      args.push("--model", model);
    }

    // MCP servers (claude is a capable MCP client).
    if (req.mcpConfig?.length) {
      args.push("--mcp-config", req.mcpConfig.join(","));
    }

    // Session resume.
    if (req.sessionId) {
      args.push("--resume", req.sessionId);
    }

    // Safety posture → claude's vocabulary.
    if (req.posture === "full-auto") {
      args.push("--dangerously-skip-permissions");
    }

    if (req.extraArgs?.length) args.push(...req.extraArgs);

    return { cmd: this.cfg.command, args, env: {} };
  }

  /**
   * Parse one claude stream-json object into an AgentEvent.
   * Claude's stream-json emits objects with a `type` field; the shapes we care
   * about: system, assistant (text/thinking/tool_use), user (tool_result),
   * result (final message + cost + session_id).
   */
  parseEvent(raw: unknown): AgentEvent | null {
    if (typeof raw !== "object" || raw === null) return null;
    const e = raw as Record<string, any>;

    switch (e.type) {
      case "system": {
        if (e.subtype === "init" && e.session_id) {
          return { type: "system", subtype: "init", message: `session ${e.session_id}` };
        }
        return { type: "system", subtype: e.subtype, message: e.message ?? "" };
      }

      case "assistant": {
        // assistant message carries a content array (text / thinking / tool_use)
        const content = Array.isArray(e.message?.content) ? e.message.content : [];
        // Yield the first meaningful block; multi-block messages are rare in -p mode.
        for (const block of content) {
          if (block.type === "text" && block.text) {
            return { type: "assistant", subtype: "text", text: block.text };
          }
          if (block.type === "thinking" && block.thinking) {
            return { type: "assistant", subtype: "thinking", text: block.thinking };
          }
          if (block.type === "tool_use") {
            return {
              type: "tool_use",
              id: String(block.id ?? ""),
              name: String(block.name ?? ""),
              input: block.input,
            };
          }
        }
        return null;
      }

      case "user": {
        // user turns in -p mode are tool_result echoes.
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

      case "result": {
        // Final result: carries text, cost, session id, duration.
        return {
          type: "done",
          exitCode: 0,
          finalText: e.result ?? "",
          sessionId: e.session_id,
        };
      }

      default:
        return null;
    }
  }
}

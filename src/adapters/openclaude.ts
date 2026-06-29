/**
 * OpenClaude adapter (Claude-Code-compatible reimplementation).
 *
 * Capability matrix row:
 *   headless:  `-p` (dist/cli.mjs, invoked via `node`)
 *   model:     `--model <id>` / `--provider <p>`
 *   json:      `--output-format stream-json`
 *   full-auto: `--dangerously-skip-permissions`
 *   mcp:       client `--mcp-config`; server via `mcp`
 *   resume:    `--resume`, `--continue`
 *
 * ⚠️ openclaude's command is a zsh function in interactive shells; here we call
 * the dist .mjs directly via `node`, so buildCommand returns cmd="node".
 */
import { BaseAdapter, resolveWithDefault } from "./base.js";
import type {
  AdapterCapabilities,
  AgentEvent,
  AgentName,
  ModelRouter,
  RunRequest,
} from "../types.js";
import type { AgentConfig } from "../config.js";

export class OpenclaudeAdapter extends BaseAdapter {
  readonly name: AgentName = "openclaude";
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
    return "OpenClaude";
  }

  resolveModel(alias: string, router: ModelRouter): string | undefined {
    return resolveWithDefault(this.name, alias, router, this.cfg.defaultModel);
  }

  buildCommand(req: RunRequest, router: ModelRouter) {
    const verbosity = req.verbosity ?? "stream-json";
    const model = this.resolveModel(req.model ?? "auto", router);

    // openclaude is Claude-Code-compatible, so flags mirror the claude adapter.
    const args: string[] = [
      this.cfg.command, // the .mjs path, first arg to `node`
      "-p",
      req.prompt,
    ];

    if (verbosity === "stream-json") {
      args.push("--output-format", "stream-json", "--verbose");
    } else if (verbosity === "json") {
      args.push("--output-format", "json");
    }

    if (model && this.capabilities.modelSelection) args.push("--model", model);
    if (this.cfg.defaultProvider) args.push("--provider", this.cfg.defaultProvider);

    if (req.mcpConfig?.length) args.push("--mcp-config", req.mcpConfig.join(","));

    if (req.posture === "full-auto") args.push("--dangerously-skip-permissions");

    if (req.sessionId) args.push("--resume", req.sessionId);

    if (req.extraArgs?.length) args.push(...req.extraArgs);

    return { cmd: "node", args, env: {} };
  }

  // Claude-Code-compatible stream-json — reuse the claude parser logic inline.
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

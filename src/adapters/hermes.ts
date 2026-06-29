/**
 * Hermes adapter (Hermes Agent, Python runtime).
 *
 * Capability matrix row:
 *   headless:  `-z <prompt>` one-shot (or `chat -q <query>`)
 *   model:     `-m <id>` / `--provider <p>`
 *   json:      `-Q/--quiet` programmatic mode (no explicit --json)
 *   full-auto: `--yolo`, `--accept-hooks`
 *   mcp:       client via `mcp`; server via `mcp serve`
 *   resume:    sessions/checkpoints subsystem
 *
 * Hermes is an agent runtime + gateway; its quiet mode is the headless pipe.
 */
import { BaseAdapter, resolveWithDefault } from "./base.js";
import type {
  AdapterCapabilities,
  AgentEvent,
  AgentName,
  ModelRouter,
  RunRequest,
} from "../types.js";

export class HermesAdapter extends BaseAdapter {
  readonly name: AgentName = "hermes";
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
    return "Hermes";
  }

  resolveModel(alias: string, router: ModelRouter): string | undefined {
    return resolveWithDefault(this.name, alias, router, this.cfg.defaultModel);
  }

  buildCommand(req: RunRequest, router: ModelRouter) {
    const args: string[] = ["-z", req.prompt, "-Q"];

    const model = this.resolveModel(req.model ?? "auto", router);
    if (model && this.capabilities.modelSelection) args.push("-m", model);
    if (this.cfg.defaultProvider) args.push("--provider", this.cfg.defaultProvider);

    if (req.posture === "full-auto") {
      args.push("--yolo", "--accept-hooks");
    }

    if (req.sessionId) args.push("--session", req.sessionId);

    if (req.extraArgs?.length) args.push(...req.extraArgs);

    return { cmd: this.cfg.command, args, env: {} };
  }

  /**
   * Parse hermes -Q output. In quiet mode hermes prints the final response plus
   * optional `session: <id>` / cost lines. JSON event streaming is partial, so
   * we handle both JSON lines and plain-text accumulation.
   */
  parseEvent(raw: unknown): AgentEvent | null {
    if (typeof raw === "object" && raw !== null) {
      const e = raw as Record<string, any>;
      if (e.type === "assistant" || e.role === "assistant") {
        return {
          type: "assistant",
          subtype: "text",
          text: String(e.text ?? e.content ?? e.message ?? ""),
        };
      }
      if (e.type === "tool" || e.tool) {
        return {
          type: "tool_use",
          id: String(e.id ?? ""),
          name: String(e.name ?? e.tool ?? ""),
          input: e.input ?? e.args,
        };
      }
      if (e.type === "done" || e.type === "end") {
        return {
          type: "done",
          exitCode: 0,
          finalText: String(e.text ?? e.content ?? ""),
          sessionId: e.session ?? e.session_id,
        };
      }
      return null;
    }
    return null; // plain text lines handled by base as `system` messages
  }
}

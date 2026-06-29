/**
 * ZCode adapter (bundled in ZCode.app, off-PATH).
 *
 * Capability matrix row (gotchas encoded):
 *   headless:  `--prompt <text>` (default --mode yolo in headless)
 *   model:     ⚠️ config-only — NO --model flag. Set via ~/.zcode/v2/config.json.
 *   json:      `--json` (partial coverage)
 *   full-auto: `--mode yolo` (already the headless default)
 *   mcp:       client `/mcp` is TUI-only → effectively false in headless; server via `app-server`
 *   resume:    `--resume <sess_id>`, `-c/--continue`
 *
 * Invoked as `node /Applications/ZCode.app/…/zcode.cjs <args>` since the binary
 * is not on PATH and has no standalone launcher.
 */
import { BaseAdapter, resolveWithDefault } from "./base.js";
import type {
  AdapterCapabilities,
  AgentEvent,
  AgentName,
  ModelRouter,
  RunRequest,
} from "../types.js";

export class ZcodeAdapter extends BaseAdapter {
  readonly name: AgentName = "zcode";
  readonly capabilities: AdapterCapabilities = {
    jsonStream: true,
    modelSelection: false, // ⚠️ no flag; config-only
    mcpClient: false, // /mcp is TUI-only in headless
    mcpServer: true, // app-server
    sessionResume: true,
    fullAuto: true,
    acpServer: true,
  };

  get displayName(): string {
    return "ZCode";
  }

  // resolveModel returns undefined (config-only); included for interface parity.
  resolveModel(_alias: string, _router: ModelRouter): string | undefined {
    return undefined;
  }

  /** Launch zcode's app-server (MCP/JSON-RPC stdio) — off-PATH, via node. */
  acpCommand(): { cmd: string; args: string[] } | null {
    return { cmd: "node", args: [this.cfg.command, "app-server"] };
  }

  buildCommand(req: RunRequest, _router: ModelRouter) {
    // zcode is off-PATH → invoke via node.
    const args: string[] = [this.cfg.command, "--prompt", req.prompt];

    if (req.verbosity !== "text") args.push("--json");

    // No --model flag exists; `--mode yolo` is the full-auto posture AND the
    // headless default, so we only set it explicitly for clarity.
    if (req.posture === "full-auto") args.push("--mode", "yolo");

    if (req.sessionId) args.push("--resume", req.sessionId);

    if (req.extraArgs?.length) args.push(...req.extraArgs);

    return { cmd: "node", args, env: {} };
  }

  /**
   * Parse zcode --json events. Coverage is partial across commands; we handle
   * the documented assistant/message/done shapes defensively and fall back to
   * letting the base treat non-JSON lines as `system` messages.
   */
  parseEvent(raw: unknown): AgentEvent | null {
    if (typeof raw !== "object" || raw === null) return null;
    const e = raw as Record<string, any>;
    const t = e.type ?? e.kind;

    if (t === "assistant" || e.role === "assistant") {
      return {
        type: "assistant",
        subtype: e.subtype === "thinking" ? "thinking" : "text",
        text: String(e.text ?? e.content ?? e.message ?? ""),
      };
    }
    if (t === "tool" || t === "tool_use" || e.tool) {
      return {
        type: "tool_use",
        id: String(e.id ?? ""),
        name: String(e.name ?? e.tool ?? ""),
        input: e.input ?? e.args,
      };
    }
    if (t === "tool_result") {
      return {
        type: "tool_result",
        id: String(e.id ?? ""),
        content: String(e.content ?? e.output ?? "").slice(0, 4000),
      };
    }
    if (t === "done" || t === "end" || t === "result" || e.done === true) {
      return {
        type: "done",
        exitCode: 0,
        finalText: String(e.text ?? e.result ?? e.content ?? ""),
        sessionId: e.sessionId ?? e.session_id,
      };
    }
    if (e.usage || e.cost) {
      return {
        type: "cost",
        inputTokens: e.usage?.input ?? e.inputTokens,
        outputTokens: e.usage?.output ?? e.outputTokens,
        costUsd: e.usage?.cost ?? e.cost,
      };
    }
    return null;
  }
}

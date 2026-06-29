/**
 * Jcode adapter (ACP agent daemon; routes via Claude Max / ChatGPT subscriptions).
 *
 * Encodes the verified jcode flag matrix:
 *   headless:  `run <MESSAGE>` (single-shot) + `serve` (background daemon)
 *   model:     -p/--provider <id> (claude, openai, openrouter, ollama, deepseek, …)
 *   json:      --json (result blob) or --ndjson (streaming events)
 *   cwd:       -C/--cwd
 *   ACP:       `jcode acp` adapter (native — backed by the jcode daemon)
 *
 * Jcode's distinctive value: it routes via Claude Max / ChatGPT Pro SUBSCRIPTIONS
 * rather than API metering — a different cost axis from every other fleet member.
 */
import { BaseAdapter, resolveWithDefault } from "./base.js";
import type {
  AdapterCapabilities, AgentEvent, AgentName, ModelRouter, RunRequest,
} from "../types.js";

export class JcodeAdapter extends BaseAdapter {
  readonly name: AgentName = "jcode";
  readonly capabilities: AdapterCapabilities = {
    jsonStream: true,
    modelSelection: true,
    mcpClient: false, // routes via provider daemon; MCP via the daemon, not a flag here
    mcpServer: false,
    sessionResume: true,
    fullAuto: true, // runs unattended by default
    acpServer: true, // jcode acp adapter
  };

  get displayName(): string { return "Jcode"; }

  resolveModel(alias: string, router: ModelRouter): string | undefined {
    return resolveWithDefault(this.name, alias, router, this.cfg.defaultModel);
  }

  /** ACP: `jcode acp` — backed by the jcode daemon. */
  acpCommand(): { cmd: string; args: string[] } | null {
    const args = ["acp"];
    if (this.cfg.defaultProvider) args.push("-p", this.cfg.defaultProvider);
    return { cmd: this.cfg.command, args };
  }

  buildCommand(req: RunRequest, router: ModelRouter) {
    const args: string[] = ["run"];

    const verbosity = req.verbosity ?? "stream-json";
    if (verbosity === "stream-json") args.push("--ndjson");
    else if (verbosity === "json") args.push("--json");

    const provider = this.cfg.defaultProvider;
    const model = this.resolveModel(req.model ?? "auto", router);
    if (provider) args.push("-p", provider);
    if (model && this.capabilities.modelSelection) {
      // jcode takes provider + model together; -p sets the provider family.
      // Model selection within a provider is via config, not a run flag, so we
      // pass the provider and let the daemon pick the model.
    }
    if (req.cwd) args.push("-C", req.cwd);

    if (req.extraArgs?.length) args.push(...req.extraArgs);

    // Positional message last.
    args.push(req.prompt);
    return { cmd: this.cfg.command, args, env: {} };
  }

  /**
   * Parse jcode --ndjson events. jcode emits JSON event objects as it streams;
   * we map the common shapes. On the ACP path this is bypassed.
   */
  parseEvent(raw: unknown): AgentEvent | null {
    if (typeof raw !== "object" || raw === null) return null;
    const e = raw as Record<string, any>;
    const t = e.type ?? e.kind ?? e.role;

    if (t === "assistant" || t === "message") {
      const text = e.content ?? e.text ?? e.delta ?? "";
      if (text) return { type: "assistant", subtype: "text", text: String(text) };
    }
    if (t === "tool_use" || t === "tool_call" || e.tool_calls) {
      return { type: "tool_use", id: String(e.id ?? ""), name: String(e.name ?? e.function?.name ?? ""), input: e.input ?? e.arguments };
    }
    if (t === "tool_result") {
      return { type: "tool_result", id: String(e.id ?? ""), content: String(e.content ?? e.output ?? "").slice(0, 4000) };
    }
    if (t === "done" || t === "end" || t === "complete" || e.done === true) {
      return { type: "done", exitCode: 0, finalText: String(e.content ?? e.text ?? ""), sessionId: e.session_id ?? e.session };
    }
    return null;
  }
}

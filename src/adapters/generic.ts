/**
 * Stack Ai OS — Generic (dynamic) adapter
 *
 * Powers the "add any CLI to the fleet" feature. Unlike the 9 built-in
 * adapters (which hardcode their flag vocabularies), GenericAdapter builds its
 * command entirely from a CommandTemplate stored in agents.yaml — so a CLI
 * added via `stackai adapters add` needs no new code.
 *
 * Event parsing is heuristic: it tries JSON-per-line and maps common shapes;
 * non-JSON lines become `system` messages, and the whole run's text is still
 * recoverable from the final `done` event (base adapter accumulates stdout).
 */
import { BaseAdapter, resolveWithDefault } from "./base.js";
import type {
  AdapterCapabilities,
  AgentEvent,
  AgentName,
  ModelRouter,
  RunRequest,
} from "../types.js";
import type { CommandTemplate } from "../config.js";

export class GenericAdapter extends BaseAdapter {
  readonly dynamic = true;
  private readonly _capabilities: AdapterCapabilities;
  private readonly template: CommandTemplate;
  private readonly _label: string;

  constructor(cfg: any) {
    super(cfg);
    this._capabilities = cfg.capabilities ?? {
      jsonStream: true,
      modelSelection: Boolean(cfg.template?.flags?.model),
      mcpClient: Boolean(cfg.template?.flags?.mcp),
      mcpServer: false,
      sessionResume: Boolean(cfg.template?.flags?.resume),
      fullAuto: Boolean(cfg.template?.flags?.fullAuto),
      acpServer: false,
    };
    this.template = cfg.template ?? {};
    this._label = cfg.label ?? cfg.name;
  }

  get name(): AgentName {
    return this.cfg.name;
  }
  get capabilities(): AdapterCapabilities {
    return this._capabilities;
  }
  get displayName(): string {
    return this._label;
  }

  resolveModel(alias: string, router: ModelRouter): string | undefined {
    return resolveWithDefault(this.name, alias, router, this.cfg.defaultModel);
  }

  buildCommand(req: RunRequest, router: ModelRouter) {
    const t = this.template;
    const flags = t.flags ?? {};
    const model = this.resolveModel(req.model ?? "auto", router);

    // Resolve placeholders against a values map.
    const vals: Record<string, string> = {
      prompt: req.prompt,
      model: model ?? "",
      mcp_config: req.mcpConfig?.join(",") ?? "",
      session: req.sessionId ?? "",
      cwd: req.cwd ?? process.cwd(),
    };

    const expand = (parts: string[] | undefined): string[] =>
      (parts ?? []).map((p) => substitute(p, vals)).filter((p) => p !== "" || true);

    const args: string[] = expand(t.prefixArgs);

    // JSON/verbosity flag (emitted unless text mode).
    if (req.verbosity !== "text" && flags.json) args.push(...expand(flags.json));

    // Model flag — only if resolved and the template supports it.
    if (vals.model && flags.model) args.push(...expand(flags.model));

    // MCP.
    if (vals.mcp_config && flags.mcp) args.push(...expand(flags.mcp));

    // Resume.
    if (vals.session && flags.resume) args.push(...expand(flags.resume));

    // Full-auto posture.
    if (req.posture === "full-auto" && flags.fullAuto) args.push(...expand(flags.fullAuto));

    // Prompt: positional (end) or via flag.
    if (t.promptPositional !== false && !flags.prompt) {
      args.push(substitute("{{prompt}}", vals));
    } else if (flags.prompt) {
      args.push(...expand(flags.prompt));
    }

    if (req.extraArgs?.length) args.push(...req.extraArgs);

    const cmd = t.nodeRun ? "node" : t.command;
    const finalArgs = t.nodeRun ? [t.command, ...args] : args;
    return { cmd, args: finalArgs, env: {} };
  }

  /**
   * Heuristic event parser for unknown CLIs. Maps the common JSON shapes
   * (claude/codex/kimi/opencode/gemini-style) and otherwise yields null so the
   * base adapter treats the line as a system message.
   */
  parseEvent(raw: unknown): AgentEvent | null {
    if (typeof raw !== "object" || raw === null) return null;
    const e = raw as Record<string, any>;
    const t = e.type ?? e.kind ?? e.event;

    // assistant text — many shapes
    if (t === "assistant" || e.role === "assistant") {
      const text = e.text ?? e.content ?? e.message?.content ?? e.message;
      if (typeof text === "string" && text)
        return { type: "assistant", subtype: "text", text };
    }
    // tool use
    if (t === "tool_use" || t === "tool" || t === "function_call" || e.tool_use) {
      return {
        type: "tool_use",
        id: String(e.id ?? e.call_id ?? ""),
        name: String(e.name ?? e.tool ?? e.tool_use?.name ?? ""),
        input: e.input ?? e.arguments ?? e.tool_use?.input,
      };
    }
    // tool result
    if (t === "tool_result" || t === "function_call_output") {
      return {
        type: "tool_result",
        id: String(e.id ?? ""),
        content: String(e.content ?? e.output ?? "").slice(0, 4000),
        isError: Boolean(e.is_error ?? e.error),
      };
    }
    // done
    if (t === "done" || t === "end" || t === "finish" || t === "result" || e.done === true) {
      return {
        type: "done",
        exitCode: 0,
        finalText: String(e.text ?? e.result ?? e.content ?? ""),
        sessionId: e.session_id ?? e.sessionId ?? e.session,
      };
    }
    // cost/usage
    if (e.usage || e.cost) {
      return {
        type: "cost",
        inputTokens: e.usage?.input ?? e.input_tokens,
        outputTokens: e.usage?.output ?? e.output_tokens,
        costUsd: e.usage?.cost ?? e.cost,
      };
    }
    return null;
  }
}

/** Replace {{key}} placeholders in a template string. */
function substitute(tpl: string, vals: Record<string, string>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => vals[k] ?? "");
}

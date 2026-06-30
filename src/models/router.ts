/**
 * Stack Ai OS — Model router
 *
 * Maps friendly aliases (sonnet, opus, gpt5, qwen-local, ...) to per-CLI model
 * ids using config/models.yaml. `auto` resolves to each agent's defaultModel.
 *
 * Supports `agent:model` pins (e.g. `codex:gpt5`) via the adapters themselves.
 */
import type { AgentName, ModelRouter } from "../types.js";
import type { ModelsConfig } from "../config.js";

export class ModelRouterImpl implements ModelRouter {
  private byAlias = new Map<string, Partial<Record<AgentName, string>>>();

  constructor(cfg: ModelsConfig) {
    for (const m of cfg.models ?? []) {
      this.byAlias.set(m.alias, m.providers ?? {});
    }
  }

  /** Resolve an alias to a model id for a specific agent, or undefined. */
  resolve(agent: AgentName, alias: string): string | undefined {
    if (alias === "auto") return undefined;
    // Direct `agent:model` pin.
    if (alias.includes(":")) {
      const [a, model] = alias.split(":");
      if (a === agent) return model;
      return undefined;
    }
    return this.byAlias.get(alias)?.[agent];
  }

  /** All known aliases. */
  aliases(): string[] {
    return [...this.byAlias.keys()];
  }

  /** Human-readable resolution map (for `stackai models` + dashboard). */
  describe(agent?: AgentName): Array<{ alias: string; resolved?: string; providers: Partial<Record<AgentName, string>> }> {
    return [...this.byAlias.entries()].map(([alias, providers]) => ({
      alias,
      resolved: agent ? providers[agent] : undefined,
      providers,
    }));
  }
}

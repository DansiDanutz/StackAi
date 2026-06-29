/**
 * Stack Ai OS — Adapter registry
 *
 * Holds both the 9 built-in adapters (hardcoded flag vocabularies) AND any
 * dynamically-added CLIs (GenericAdapter, driven by agents.yaml templates).
 * `addAdapter()` persists a new entry to config so it survives restarts.
 */
import { existsSync } from "node:fs";
import type { AgentAdapter, AgentName } from "../types.js";
import {
  loadConfig,
  saveAgentsConfig,
  getAgentConfig,
  type StackAiConfig,
  type AgentConfig,
} from "../config.js";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import { OpencodeAdapter } from "./opencode.js";
import { GeminiAdapter } from "./gemini.js";
import { KimiAdapter } from "./kimi.js";
import { OpenclaudeAdapter } from "./openclaude.js";
import { PiAdapter } from "./pi.js";
import { HermesAdapter } from "./hermes.js";
import { ZcodeAdapter } from "./zcode.js";
import { GenericAdapter } from "./generic.js";
import { FuguAdapter } from "./fugu.js";
import { ClineAdapter } from "./cline.js";
import { DeepseekAdapter } from "./deepseek.js";
import { JcodeAdapter } from "./jcode.js";

/** Built-in factories. Anything not here falls through to GenericAdapter. */
const BUILTIN_FACTORIES: Record<string, (cfg: AgentConfig) => AgentAdapter> = {
  claude: (cfg) => new ClaudeAdapter(cfg),
  codex: (cfg) => new CodexAdapter(cfg),
  opencode: (cfg) => new OpencodeAdapter(cfg),
  gemini: (cfg) => new GeminiAdapter(cfg),
  kimi: (cfg) => new KimiAdapter(cfg),
  openclaude: (cfg) => new OpenclaudeAdapter(cfg),
  pi: (cfg) => new PiAdapter(cfg),
  hermes: (cfg) => new HermesAdapter(cfg),
  zcode: (cfg) => new ZcodeAdapter(cfg),
  // Cloud meta-orchestrator — registered even without a config entry, opt-in.
  fugu: () => new FuguAdapter(),
  // Fleet peers discovered on this Mac Studio:
  cline: (cfg) => new ClineAdapter(cfg),
  deepseek: (cfg) => new DeepseekAdapter(cfg),
  jcode: (cfg) => new JcodeAdapter(cfg),
};

export class AdapterRegistry {
  private adapters = new Map<AgentName, AgentAdapter>();
  private disabled = new Set<AgentName>();

  constructor(private cfg: StackAiConfig) {
    this.load();
  }

  private load() {
    // Built-in cloud adapters that have no config entry are always available
    // (they're opt-in via --judge fugu / --agent fugu). They appear in the fleet
    // but only fire when explicitly invoked.
    const CLOUD_BUILTINS = new Set(["fugu"]);

    for (const agentCfg of this.cfg.agents.agents) {
      if (!agentCfg.enabled) {
        this.disabled.add(agentCfg.name);
        continue;
      }
      const factory = BUILTIN_FACTORIES[agentCfg.name];
      const adapter = factory
        ? factory(agentCfg)
        : agentCfg.template
          ? new GenericAdapter(agentCfg)
          : null;
      if (adapter) this.adapters.set(agentCfg.name, adapter);
    }

    // Register cloud built-ins not present in config.
    for (const name of CLOUD_BUILTINS) {
      if (!this.adapters.has(name as AgentName) && !this.disabled.has(name as AgentName)) {
        const factory = BUILTIN_FACTORIES[name];
        if (factory) this.adapters.set(name as AgentName, factory({} as AgentConfig));
      }
    }
  }

  get(name: AgentName): AgentAdapter | undefined {
    return this.adapters.get(name);
  }

  require(name: AgentName): AgentAdapter {
    const a = this.adapters.get(name);
    if (!a) {
      if (this.disabled.has(name)) throw new Error(`Agent '${name}' is disabled in config`);
      throw new Error(`No adapter registered for '${name}'`);
    }
    return a;
  }

  enabled(): AgentAdapter[] {
    return [...this.adapters.values()];
  }

  isDisabled(name: AgentName): boolean {
    return this.disabled.has(name);
  }

  /**
   * Register a new dynamic adapter and persist it to agents.yaml.
   * Throws if the name is already taken by a built-in or existing adapter.
   */
  addAdapter(agentCfg: AgentConfig): AgentAdapter {
    if (BUILTIN_FACTORIES[agentCfg.name]) {
      throw new Error(
        `'${agentCfg.name}' is a built-in adapter. Edit config/agents.yaml to reconfigure it.`
      );
    }
    if (this.adapters.has(agentCfg.name)) {
      throw new Error(`Adapter '${agentCfg.name}' already exists. Remove it first.`);
    }
    if (!agentCfg.template) {
      throw new Error(`Dynamic adapter '${agentCfg.name}' requires a command template.`);
    }
    const adapter = new GenericAdapter(agentCfg);
    this.adapters.set(agentCfg.name, adapter);

    // Persist to config.
    this.cfg.agents.agents.push({ ...agentCfg, dynamic: true });
    saveAgentsConfig(this.cfg.agents);
    return adapter;
  }

  /** Remove a dynamic adapter (built-ins cannot be removed, only disabled). */
  removeAdapter(name: AgentName): boolean {
    if (BUILTIN_FACTORIES[name]) return false;
    if (!this.adapters.delete(name)) return false;
    this.cfg.agents.agents = this.cfg.agents.agents.filter((a) => a.name !== name);
    saveAgentsConfig(this.cfg.agents);
    return true;
  }

  /** Re-read config from disk (after external edits) and rebuild. */
  reload(): void {
    this.adapters.clear();
    this.disabled.clear();
    this.cfg = loadConfig();
    this.load();
  }
}

export function createRegistry(cfg?: StackAiConfig): AdapterRegistry {
  return new AdapterRegistry(cfg ?? loadConfig());
}

export { getAgentConfig, BUILTIN_FACTORIES };

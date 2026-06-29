/**
 * Stack Ai OS — Configuration schema & loader.
 *
 * Three YAML files live in config/ (overridable via STACKAI_CONFIG_DIR):
 *   agents.yaml   — per-CLI binary paths, defaults, enable flags
 *   models.yaml   — alias → per-CLI model ids + per-pattern defaults
 *   patterns.yaml — named pattern presets (ensemble size, agents, caps)
 *
 * Dynamic adapters (added via `stackai adapters add`) are persisted back into
 * agents.yaml with a commandTemplate so they survive restarts.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { stringify, parse } from "yaml";
import type { AgentName, AdapterCapabilities, SafetyPosture } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the config directory. Under tsx (src/) and the built dist/ layout the
 * relative offset differs, so walk up from this file until we find a `config/`
 * dir containing agents.yaml. STACKAI_CONFIG_DIR always wins.
 */
function resolveConfigDir(): string {
  if (process.env.STACKAI_CONFIG_DIR) return process.env.STACKAI_CONFIG_DIR;
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "config", "agents.yaml");
    if (existsSync(candidate)) return path.join(dir, "config");
    dir = path.dirname(dir);
  }
  // Fallback: assume repo root two levels above src/ or dist/.
  return path.resolve(__dirname, "..", "..", "config");
}

export const CONFIG_DIR = resolveConfigDir();

/**
 * Command template for dynamic adapters. Placeholders are substituted at
 * buildCommand time:
 *   {{prompt}}       — the task prompt (shell-escaped)
 *   {{model}}        — resolved model id
 *   {{mcp_config}}   — joined MCP config paths
 *   {{session}}      — session id to resume
 *   {{cwd}}          — working directory
 * Flags are only emitted when the placeholder resolves to a non-empty value.
 */
export interface CommandTemplate {
  /** The binary to invoke (or "node" if nodeRun). */
  command: string;
  /** Whether to invoke via `node <command>` (openclaude/zcode-style). */
  nodeRun?: boolean;
  /**
   * Prefix args prepended before everything (e.g. ["exec"] for codex).
   * May contain placeholders.
   */
  prefixArgs?: string[];
  /**
   * Flag templates. Each is emitted verbatim if its placeholder is set.
   * Example: { model: ["--model", "{{model}}"], json: ["--output-format", "stream-json"] }
   */
  flags?: {
    prompt?: string[];     // how to pass the prompt, default ["-p","{{prompt}}"] or positional
    model?: string[];
    json?: string[];       // emitted when verbosity != text
    fullAuto?: string[];   // emitted in full-auto posture
    mcp?: string[];
    resume?: string[];
  };
  /** Whether the prompt is a positional arg at the end (true) or via a flag. */
  promptPositional?: boolean;
}

export interface AgentConfig {
  name: AgentName;
  command: string;
  prefixArgs?: string[];
  nodeRun?: boolean;
  defaultModel?: string;
  defaultProvider?: string;
  enabled: boolean;
  /** Marker that this entry was created via `stackai adapters add`. */
  dynamic?: boolean;
  /** Human label for the TUI/web. */
  label?: string;
  /** Capabilities override (dynamic adapters declare their own). */
  capabilities?: AdapterCapabilities;
  /** Command template (dynamic adapters). Built-ins ignore this. */
  template?: CommandTemplate;
}

export interface AgentsConfig {
  agents: AgentConfig[];
}

export interface ModelAlias {
  alias: string;
  providers: Partial<Record<string, string>>;
}

export interface ModelsConfig {
  models: ModelAlias[];
  defaults: Record<
    string,
    { agents?: AgentName[]; model?: string; judge?: AgentName }
  >;
}

export interface PatternPreset {
  name: string;
  kind: string;
  agents?: AgentName[];
  judge?: AgentName;
  model?: string;
  width?: number;
  maxIterations?: number;
  budgetUsd?: number;
  timeoutSec?: number;
  posture?: SafetyPosture;
}

export interface PatternsConfig {
  patterns: PatternPreset[];
}

function readYaml<T>(file: string, fallback: T): T {
  try {
    const raw = readFileSync(file, "utf8");
    return parse(raw) as T;
  } catch {
    return fallback;
  }
}

export interface StackAiConfig {
  agents: AgentsConfig;
  models: ModelsConfig;
  patterns: PatternsConfig;
}

export function loadConfig(dir: string = CONFIG_DIR): StackAiConfig {
  return {
    agents: readYaml<AgentsConfig>(path.join(dir, "agents.yaml"), { agents: [] }),
    models: readYaml<ModelsConfig>(path.join(dir, "models.yaml"), { models: [], defaults: {} }),
    patterns: readYaml<PatternsConfig>(path.join(dir, "patterns.yaml"), { patterns: [] }),
  };
}

/** Persist the agents config back to agents.yaml (used by `stackai adapters add`). */
export function saveAgentsConfig(cfg: AgentsConfig, dir: string = CONFIG_DIR): void {
  const file = path.join(dir, "agents.yaml");
  writeFileSync(file, stringify(cfg, { lineWidth: 100 }), "utf8");
}

export function getAgentConfig(cfg: StackAiConfig, name: AgentName): AgentConfig | null {
  return cfg.agents.agents.find((a) => a.name === name) ?? null;
}

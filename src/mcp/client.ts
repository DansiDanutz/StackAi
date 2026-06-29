/**
 * Stack Ai OS — MCP client (inject shared servers into agent runs)
 *
 * The "OS as MCP client" half. Defines a curated set of shared MCP servers
 * (your context7, playwright, claude-mem:mcp-search, github, etc.) and emits
 * the per-CLI mcp-config blob so any MCP-capable agent gets the same tools.
 *
 * Capability gating: only agents with capabilities.mcpClient receive the
 * injected config (pi has no MCP → skipped; zcode is TUI-only → skipped).
 *
 * Also emits the Stack Ai OS server itself as an injectable entry, so a CLI
 * running under Stack Ai OS can call back into the OS (sao.ensemble etc.).
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "../config.js";
import type { AgentName } from "../types.js";

export interface McpServerEntry {
  /** stdio command form. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** HTTP/SSE URL form. */
  url?: string;
  /** Whether this server requires auth (we can't provide it → skip on inject). */
  needsAuth?: boolean;
  enabled?: boolean;
}

/** Shared MCP server catalog — the tools every MCP-capable agent may use. */
export const SHARED_MCP_SERVERS: Record<string, McpServerEntry> = {
  // Stack Ai OS itself — lets an agent call back for ensemble/judge/recall.
  "stack-ai-os": {
    command: "node",
    args: [path.resolve(CONFIG_DIR, "..", "dist", "cli", "index.js"), "mcp", "serve"],
    enabled: true,
  },
  context7: {
    command: "npx",
    args: ["-y", "@upstash/context7-mcp"],
    enabled: true,
  },
  playwright: {
    command: "npx",
    args: ["@playwright/mcp@latest"],
    enabled: true,
  },
  "claude-mem-search": {
    command: "node",
    enabled: true,
  },
};

/**
 * Resolve which servers to inject for a given agent. Skips servers needing
 * auth and respects the `enabled` flag. Returns the mcp-config object the
 * CLI consumes via --mcp-config.
 */
export function resolveInjectableServers(
  agent: AgentName,
  capabilities: { mcpClient: boolean },
  opts?: { includeSelf?: boolean }
): Record<string, McpServerEntry> {
  if (!capabilities.mcpClient) return {}; // pi, zcode → no injection

  const out: Record<string, McpServerEntry> = {};
  for (const [name, entry] of Object.entries(SHARED_MCP_SERVERS)) {
    if (entry.enabled === false) continue;
    if (entry.needsAuth) continue; // can't satisfy auth automatically
    if (name === "stack-ai-os" && opts?.includeSelf === false) continue;
    out[name] = entry;
  }
  return out;
}

/**
 * Write the injectable servers to a temp mcp-config JSON file and return its
 * path. This is what adapters pass as --mcp-config / --mcp-config-file.
 */
export function writeMcpConfig(
  agent: AgentName,
  capabilities: { mcpClient: boolean },
  opts?: { includeSelf?: boolean }
): string | undefined {
  const servers = resolveInjectableServers(agent, capabilities, opts);
  if (Object.keys(servers).length === 0) return undefined;

  const dir = path.resolve(CONFIG_DIR, "..", "data", "mcp");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `inject-${agent}.json`);
  writeFileSync(file, JSON.stringify({ mcpServers: servers }, null, 2));
  return file;
}

/** Emit a standalone config snippet pointing at the Stack Ai OS MCP server. */
export function stackAiOsMcpSnippet(): Record<string, { command: string; args: string[] }> {
  return {
    "stack-ai-os": {
      command: "stackai",
      args: ["mcp", "serve"],
    },
  };
}

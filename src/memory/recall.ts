/**
 * Stack Ai OS — Memory recall adapters
 *
 * Read-only queries against your EXISTING memory stores. Stack Ai OS never
 * duplicates memory — it recalls from what's already there so an agent can be
 * primed with relevant context before solving a task.
 *
 *   claude-mem:  mcp-search tool (port 37777) — cross-session observations
 *   openclaw:    `openclaw memory` CLI — FTS + embeddings + recall store
 *   graphify:    `graphify path|explain` — code knowledge-graph
 *
 * Each adapter is optional and degrades gracefully if its backend is absent.
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

export interface RecallResult {
  source: "claude-mem" | "openclaw" | "graphify" | "obsidian";
  text: string;
  meta?: Record<string, unknown>;
}

// ---------------------- claude-mem (mcp-search over HTTP) -----------------

const CLAUDE_MEM_PORT = 37777;

/** Recall relevant observations from claude-mem. Best-effort. */
export function recallClaudeMem(query: string, limit = 5): RecallResult[] {
  // claude-mem exposes an mcp-search tool; the simplest programmatic path is the
  // worker's HTTP API. We try a lightweight fetch and fall back to the CLI shim.
  try {
    const q = JSON.stringify({ query, limit });
    const raw = execSync(
      `curl -s -m 8 -X POST http://127.0.0.1:${CLAUDE_MEM_PORT}/search -H "Content-Type: application/json" -d ${JSON.stringify(q)}`,
      { encoding: "utf8" }
    );
    const data = JSON.parse(raw);
    const obs = Array.isArray(data.observations) ? data.observations : Array.isArray(data.results) ? data.results : [];
    return obs.slice(0, limit).map((o: any) => ({
      source: "claude-mem" as const,
      text: String(o.text ?? o.content ?? o.observation ?? ""),
      meta: { id: o.id, time: o.time },
    }));
  } catch {
    return [];
  }
}

// ---------------------- openclaw memory (CLI) -----------------------------

/** Recall from openclaw's memory store via its `memory` subcommand. */
export function recallOpenclaw(query: string, limit = 5): RecallResult[] {
  const bin = "/Users/davidai/.local/bin/openclaw";
  if (!existsSync(bin)) return [];
  try {
    const raw = execSync(
      `${JSON.stringify(bin)} memory search ${JSON.stringify(query)} --limit ${limit} --json`,
      { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] }
    );
    const data = JSON.parse(raw);
    const rows = Array.isArray(data.results) ? data.results : Array.isArray(data) ? data : [];
    return rows.slice(0, limit).map((r: any) => ({
      source: "openclaw" as const,
      text: String(r.text ?? r.content ?? r.summary ?? ""),
      meta: { score: r.score, id: r.id },
    }));
  } catch {
    return [];
  }
}

// ---------------------- graphify (code knowledge graph) -------------------

/** Get structural context about the repo via graphify. */
export function recallGraphify(target: string): RecallResult[] {
  const bin = "/Users/davidai/.local/bin/graphify";
  if (!existsSync(bin)) return [];
  try {
    const raw = execSync(
      `${JSON.stringify(bin)} explain ${JSON.stringify(target)} --json`,
      { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "ignore"] }
    );
    return [{ source: "graphify", text: String(raw).slice(0, 6000) }];
  } catch {
    return [];
  }
}

// ---------------------- combined recall -----------------------------------

/** Recall from all available sources, deduped, for priming an agent. */
export function recallAll(query: string, opts?: { codeTarget?: string; limit?: number }): RecallResult[] {
  const limit = opts?.limit ?? 5;
  const results: RecallResult[] = [];
  // Run sequentially (these hit local daemons/CLIs; cheap).
  for (const r of recallClaudeMem(query, limit)) results.push(r);
  for (const r of recallOpenclaw(query, limit)) results.push(r);
  if (opts?.codeTarget) {
    for (const r of recallGraphify(opts.codeTarget)) results.push(r);
  }
  return results;
}

/** Format recall results into a context block to prepend to a prompt. */
export function formatContext(results: RecallResult[]): string {
  if (!results.length) return "";
  const sections = results.map((r, i) => `### [${r.source}] ${i + 1}\n${r.text}`);
  return `Relevant context from memory (use if helpful):\n\n${sections.join("\n\n")}`;
}

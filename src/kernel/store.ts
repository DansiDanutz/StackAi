/**
 * Stack Ai OS — Run store (SQLite)
 *
 * Persists every run, candidate, judge verdict, and rating. This is the OS's
 * own state — browsable in the web dashboard. (Obsidian/memory backends are a
 * separate layer; this is the fast structured store.)
 *
 * Uses node:sqlite (built into Node 24+) — no native dependency to compile.
 * The import is dynamic + vite-ignored so it loads via Node at runtime only
 * (vite/vitest can't transform experimental `node:` builtins).
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "../config.js";

type DatabaseSync = import("node:sqlite").DatabaseSync;
const SQLiteCtor: Promise<any> = import(/* @vite-ignore */ "node:sqlite").then((m) => m.DatabaseSync);
import type { AgentName, RunResult } from "../types.js";

const DATA_DIR = process.env.STACKAI_DATA_DIR ?? path.resolve(CONFIG_DIR, "..", "data");
const DB_PATH = path.join(DATA_DIR, "run-store.sqlite");

let _db: DatabaseSync | null = null;

async function db(): Promise<DatabaseSync> {
  if (_db) return _db;
  const DatabaseSync = await SQLiteCtor;
  mkdirSync(DATA_DIR, { recursive: true });
  const d = new DatabaseSync(DB_PATH);
  d.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      ts TEXT NOT NULL,
      pattern TEXT NOT NULL,
      task TEXT NOT NULL,
      status TEXT NOT NULL,           -- running | done | failed | cancelled
      winner_agent TEXT,
      winner_text TEXT,
      budget_usd REAL,
      spent_usd REAL,
      iterations INTEGER DEFAULT 0,
      cwd TEXT,
      meta TEXT                       -- JSON blob for extra pattern data
    );
    CREATE TABLE IF NOT EXISTS candidates (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      iteration INTEGER NOT NULL,
      agent TEXT NOT NULL,
      model TEXT,
      exit_code INTEGER,
      final_text TEXT,
      score REAL,
      cost_usd REAL,
      duration_ms INTEGER,
      timed_out INTEGER,
      session_id TEXT,
      ts TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES runs(id)
    );
    CREATE TABLE IF NOT EXISTS ratings (
      run_id TEXT,
      candidate_id TEXT,
      rating INTEGER,                 -- 1-5 user rating
      note TEXT,
      ts TEXT NOT NULL,
      PRIMARY KEY (run_id, candidate_id)
    );
    CREATE INDEX IF NOT EXISTS idx_candidates_run ON candidates(run_id);
    CREATE INDEX IF NOT EXISTS idx_runs_ts ON runs(ts);
  `);
  _db = d;
  return d;
}

export interface RunRecord {
  id: string;
  ts: string;
  pattern: string;
  task: string;
  status: string;
  winnerAgent?: string;
  winnerText?: string;
  budgetUsd?: number;
  spentUsd?: number;
  iterations?: number;
  cwd?: string;
  meta?: Record<string, unknown>;
}

export interface CandidateRecord {
  id: string;
  runId: string;
  iteration: number;
  agent: AgentName;
  model?: string;
  exitCode: number;
  finalText: string;
  score?: number;
  costUsd?: number;
  durationMs: number;
  timedOut: boolean;
  sessionId?: string;
  ts: string;
}

function uuid(): string {
  return "xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function now(): string {
  return new Date().toISOString();
}

export async function createRun(
  pattern: string,
  task: string,
  opts?: { budgetUsd?: number; cwd?: string; id?: string }
): Promise<string> {
  const id = opts?.id ?? uuid();
  (await db()).prepare(
    "INSERT INTO runs (id, ts, pattern, task, status, budget_usd, spent_usd, iterations, cwd) VALUES (?,?,?,?,?,?,?,?,?)"
  ).run(id, now(), pattern, task, "running", opts?.budgetUsd ?? null, 0, 0, opts?.cwd ?? null);
  return id;
}

export async function updateRun(id: string, patch: Partial<RunRecord>): Promise<void> {
  const d = await db();
  const cur = d.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Record<string, any> | undefined;
  if (!cur) return;
  const merged = { ...cur, ...stripUndefined(patch), ts: cur.ts };
  d.prepare(
    `UPDATE runs SET status=?, winner_agent=?, winner_text=?, budget_usd=?, spent_usd=?, iterations=?, cwd=?, meta=? WHERE id=?`
  ).run(
    merged.status ?? cur.status,
    merged.winnerAgent ?? null,
    merged.winnerText ?? null,
    merged.budgetUsd ?? cur.budget_usd,
    merged.spentUsd ?? cur.spent_usd,
    merged.iterations ?? cur.iterations,
    merged.cwd ?? cur.cwd,
    merged.meta ? JSON.stringify(merged.meta) : cur.meta,
    id
  );
}

export async function recordCandidate(runId: string, iteration: number, result: RunResult, model?: string, score?: number): Promise<string> {
  const id = uuid();
  const d = await db();
  d.prepare(
    `INSERT INTO candidates (id, run_id, iteration, agent, model, exit_code, final_text, score, cost_usd, duration_ms, timed_out, session_id, ts)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id, runId, iteration, result.agent, model ?? null, result.exitCode,
    result.finalText, score ?? null, result.costUsd ?? null, result.durationMs,
    result.timedOut ? 1 : 0, result.sessionId ?? null, now()
  );
  // bump spent
  if (result.costUsd) {
    d.prepare("UPDATE runs SET spent_usd = spent_usd + ? WHERE id = ?").run(result.costUsd, runId);
  }
  return id;
}

export async function getRun(id: string): Promise<RunRecord | undefined> {
  const row = (await db()).prepare("SELECT * FROM runs WHERE id = ?").get(id) as Record<string, any> | undefined;
  if (!row) return undefined;
  return rowToRun(row);
}

export async function listRuns(limit = 50): Promise<RunRecord[]> {
  const rows = (await db()).prepare("SELECT * FROM runs ORDER BY ts DESC LIMIT ?").all(limit) as Record<string, any>[];
  return rows.map(rowToRun);
}

export async function listCandidates(runId: string): Promise<CandidateRecord[]> {
  const rows = (await db()).prepare("SELECT * FROM candidates WHERE run_id = ? ORDER BY iteration, score DESC").all(runId) as Record<string, any>[];
  return rows.map((r) => ({
    id: r.id, runId: r.run_id, iteration: r.iteration, agent: r.agent,
    model: r.model ?? undefined, exitCode: r.exit_code, finalText: r.final_text,
    score: r.score ?? undefined, costUsd: r.cost_usd ?? undefined, durationMs: r.duration_ms,
    timedOut: Boolean(r.timed_out), sessionId: r.session_id ?? undefined, ts: r.ts,
  }));
}

export async function rateCandidate(runId: string, candidateId: string, rating: number, note?: string): Promise<void> {
  (await db()).prepare(
    "INSERT OR REPLACE INTO ratings (run_id, candidate_id, rating, note, ts) VALUES (?,?,?,?,?)"
  ).run(runId, candidateId, Math.max(1, Math.min(5, rating)), note ?? null, now());
}

function rowToRun(r: Record<string, any>): RunRecord {
  return {
    id: r.id, ts: r.ts, pattern: r.pattern, task: r.task, status: r.status,
    winnerAgent: r.winner_agent ?? undefined, winnerText: r.winner_text ?? undefined,
    budgetUsd: r.budget_usd ?? undefined, spentUsd: r.spent_usd ?? undefined,
    iterations: r.iterations, cwd: r.cwd ?? undefined,
    meta: r.meta ? JSON.parse(r.meta) : undefined,
  };
}

function stripUndefined<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}

/**
 * Stack Ai OS — Run store INTEGRATION test (runs via tsx, not vitest).
 *
 * vitest can't load the experimental `node:sqlite` builtin (vite transforms
 * it), so the store test runs standalone through tsx which uses Node natively.
 * Invoked by `pnpm test:integration`.
 *
 * Run: pnpm test:integration
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "sao-store-int-"));
process.env.STACKAI_DATA_DIR = TMP;
process.env.STACKAI_CONFIG_DIR = TMP;

const store = await import("../src/kernel/store.js");
let passed = 0, failed = 0;

async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
}

console.log("run store (integration, via tsx):");

await test("creates a run and reads it back", async () => {
  const id = await store.createRun("ensemble", "refactor auth.ts", { budgetUsd: 1 });
  const run = await store.getRun(id);
  assert.ok(run, "run should exist");
  assert.equal(run!.pattern, "ensemble");
  assert.equal(run!.task, "refactor auth.ts");
  assert.equal(run!.status, "running");
  assert.equal(run!.budgetUsd, 1);
});

await test("records candidates and accumulates spend", async () => {
  const id = await store.createRun("ensemble", "task");
  const result = { agent: "claude", exitCode: 0, finalText: "solution", events: [], durationMs: 1500, costUsd: 0.05, timedOut: false };
  await store.recordCandidate(id, 0, result, "sonnet", 88);
  await store.recordCandidate(id, 0, { ...result, agent: "codex", costUsd: 0.03 }, "gpt5", 72);
  const run = await store.getRun(id);
  assert.ok(Math.abs((run!.spentUsd ?? 0) - 0.08) < 1e-5, `spent should be 0.08, got ${run!.spentUsd}`);
  const cands = await store.listCandidates(id);
  assert.equal(cands.length, 2);
  assert.equal(cands[0]!.score, 88); // highest score first
  assert.equal(cands[0]!.agent, "claude");
});

await test("updates run status and winner", async () => {
  const id = await store.createRun("ensemble", "task");
  await store.updateRun(id, { status: "done", winnerAgent: "claude", winnerText: "best", iterations: 2 });
  const run = await store.getRun(id);
  assert.equal(run!.status, "done");
  assert.equal(run!.winnerAgent, "claude");
  assert.equal(run!.iterations, 2);
});

await test("lists runs newest-first", async () => {
  const a = await store.createRun("ensemble", "a");
  const b = await store.createRun("solo", "b");
  const runs = await store.listRuns(50);
  assert.ok(runs.findIndex((r) => r.id === b) < runs.findIndex((r) => r.id === a));
});

await test("stores ratings keyed by run+candidate", async () => {
  const runId = await store.createRun("ensemble", "task");
  const candId = await store.recordCandidate(runId, 0, { agent: "claude", exitCode: 0, finalText: "x", events: [], durationMs: 1, timedOut: false });
  await store.rateCandidate(runId, candId, 5, "great");
  await store.rateCandidate(runId, candId, 4); // idempotent replace
});

try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

/**
 * Stack Ai OS — Pattern flow tests with mock adapters.
 *
 * Validates that ensemble/pipeline actually capture agent output (finalText)
 * correctly — the exact thing the scheduler bug broke. With mock agents these
 * are deterministic and CI-safe.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSolo } from "../src/patterns/solo.js";
import { runPipeline } from "../src/patterns/pipeline.js";
import { runEnsemble } from "../src/patterns/ensemble.js";
import { Scheduler } from "../src/kernel/scheduler.js";
import { defaultPolicy } from "../src/safety/policy.js";
import { MockAdapter, streamedTextEvents, mockRouter } from "./_mock.js";

const TMP = mkdtempSync(join(tmpdir(), "sao-patterns-"));
process.env.STACKAI_DATA_DIR = TMP;
process.env.STACKAI_CONFIG_DIR = TMP;
afterAll(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

describe("solo pattern (mock adapter)", () => {
  it("captures streamed text as finalText", async () => {
    const adapter = new MockAdapter({ events: streamedTextEvents("the answer is 42") });
    const result = await runSolo(adapter, mockRouter, {
      agent: "mock" as any, prompt: "what is the answer", verbosity: "stream-json",
    }, defaultPolicy());
    expect(result.finalText).toBe("the answer is 42");
    expect(result.exitCode).toBe(0);
  });

  it("returns empty finalText when agent produces nothing", async () => {
    const adapter = new MockAdapter({ events: [{ type: "done", exitCode: 1, finalText: "" }] });
    const result = await runSolo(adapter, mockRouter, {
      agent: "mock" as any, prompt: "x", verbosity: "stream-json",
    }, defaultPolicy());
    expect(result.finalText).toBe("");
    expect(result.exitCode).toBe(1);
  });
});

describe("pipeline pattern (mock adapters)", () => {
  it("chains stages: each output feeds the next", async () => {
    // Each stage mock returns a distinct, deterministic output.
    const planAdapter = new MockAdapter({ events: streamedTextEvents("PLAN: step 1, step 2") });
    const codeAdapter = new MockAdapter({ events: streamedTextEvents("CODE: def f(): pass") });
    const reviewAdapter = new MockAdapter({ events: streamedTextEvents("REVIEW: looks good") });

    const registry = {
      enabled: () => [planAdapter, codeAdapter, reviewAdapter],
      get: (name: string) => name === "planner" ? planAdapter : name === "coder" ? codeAdapter : reviewAdapter,
      require: (name: string) => name === "planner" ? planAdapter : name === "coder" ? codeAdapter : reviewAdapter,
      isDisabled: () => false,
    } as any;

    const scheduler = new Scheduler(defaultPolicy(), { concurrency: 2 });
    const result = await runPipeline(registry, mockRouter, scheduler, defaultPolicy(), {
      task: "write a function",
      agents: ["planner", "coder", "reviewer", "coder"] as any,
      timeoutSec: 10,
    });

    expect(result.status).toBe("done");
    expect(result.stages.length).toBe(4); // plan, code, review, fix
    // The final output should be the last stage's output (the fix stage).
    expect(result.finalOutput).toContain("CODE");
  });
});

describe("ensemble pattern (mock adapters)", () => {
  it("fans out multiple agents and captures each candidate's finalText", async () => {
    const agentA = new MockAdapter({ events: streamedTextEvents("solution A") });
    const agentB = new MockAdapter({ events: streamedTextEvents("solution B") });

    const registry = {
      enabled: () => [agentA, agentB],
      get: (name: string) => name === "agentA" ? agentA : agentB,
      require: (name: string) => name === "agentA" ? agentA : agentB,
      isDisabled: () => false,
    } as any;

    const scheduler = new Scheduler(defaultPolicy(), { concurrency: 4 });
    const result = await runEnsemble(registry, mockRouter, scheduler, defaultPolicy(), {
      task: "solve this",
      agents: ["agentA", "agentB"] as any,
      judgeAgent: "agentA" as any,
      maxIterations: 0,
      budgetUsd: 1,
      timeoutSec: 10,
    });

    // Both candidates should have been captured with their finalText.
    expect(result.allCandidates.length).toBe(2);
    const texts = result.allCandidates.map((c) => c.result.finalText);
    expect(texts).toContain("solution A");
    expect(texts).toContain("solution B");
    // A winner should be picked.
    expect(result.winner).toBeDefined();
    expect(result.winner?.result.finalText.length).toBeGreaterThan(0);
  });

  it("handles a candidate that produces empty output (no crash)", async () => {
    const good = new MockAdapter({ events: streamedTextEvents("real solution") });
    const empty = new MockAdapter({ events: [{ type: "done", exitCode: 1, finalText: "" }] });

    const registry = {
      enabled: () => [good, empty],
      get: (name: string) => name === "good" ? good : empty,
      require: (name: string) => name === "good" ? good : empty,
      isDisabled: () => false,
    } as any;

    const scheduler = new Scheduler(defaultPolicy(), { concurrency: 2 });
    const result = await runEnsemble(registry, mockRouter, scheduler, defaultPolicy(), {
      task: "solve",
      agents: ["good", "empty"] as any,
      judgeAgent: "good" as any,
      maxIterations: 0,
      budgetUsd: 1,
      timeoutSec: 10,
    });

    // The empty candidate is filtered (no finalText), but the good one wins.
    expect(result.allCandidates.length).toBeGreaterThanOrEqual(1);
    const winnerText = result.winner?.result.finalText;
    expect(winnerText).toBeDefined();
  });
});

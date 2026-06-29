/**
 * Stack Ai OS — Orchestrator end-to-end test (with mock adapter).
 *
 * Runs the full 6-phase TaskOrchestrator against mock agents (no real CLIs)
 * and verifies: phase sequencing, agent handoffs, conversation messages, and
 * --out file writing. This is the deterministic, CI-safe validation of the
 * orchestrator that the live codex test complements (but can't be relied on
 * for CI due to auth flakiness).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskOrchestrator, PHASE_LABELS } from "../src/orchestrator/task.js";
import { MockAdapter, streamedTextEvents, mockRouter } from "./_mock.js";
import { defaultPolicy } from "../src/safety/policy.js";
import { Scheduler } from "../src/kernel/scheduler.js";

const TMP = mkdtempSync(join(tmpdir(), "sao-orch-"));
process.env.STACKAI_DATA_DIR = TMP;
process.env.STACKAI_CONFIG_DIR = TMP;

afterAll(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

// Build a mock registry that returns a mock adapter for every agent name.
function makeMockRegistry() {
  // Each phase gets a distinct, deterministic output via a per-call mock.
  const planner = new MockAdapter({
    events: () => streamedTextEvents("1. Define function\n2. Handle edge cases\n3. Add type hints"),
  });
  const orchestrator = new MockAdapter({
    events: () => streamedTextEvents("coder implements, reviewer tests"),
  });
  const coder = new MockAdapter({
    events: () => streamedTextEvents("```python\ndef is_prime(n: int) -> bool:\n    return n > 1\n```"),
  });
  const reviewer = new MockAdapter({
    events: () => streamedTextEvents("VERDICT: PASS — implementation is correct"),
  });

  const map: Record<string, MockAdapter> = { codex: coder, gemini: orchestrator, claude: reviewer };
  // For the planner we override codex's behavior on the first call... simpler:
  // just make a unified mock that returns phase-appropriate text.
  return {
    enabled: () => Object.values(map),
    get: (name: string) => map[name] ?? coder,
    require: (name: string) => map[name] ?? coder,
    isDisabled: () => false,
    addAdapter: () => { throw new Error("not in mock"); },
    removeAdapter: () => false,
    reload: () => {},
  };
}

describe("TaskOrchestrator 6-phase flow (mock agents)", () => {
  it("runs all phases and delivers", async () => {
    const registry = makeMockRegistry() as any;
    const scheduler = new Scheduler(defaultPolicy(), { concurrency: 2 });
    const events: any[] = [];

    const result = await new TaskOrchestrator(registry as any, mockRouter, scheduler, defaultPolicy(), {
      task: "write is_prime(n)",
      agents: ["codex", "gemini", "codex", "claude"],
      maxLoops: 0,
      timeoutSec: 10,
      cwd: TMP,
      onEvent: (e) => events.push(e),
    }).run();

    // Should complete (mock agents always produce output).
    expect(result.status).toBe("delivered");
    // Should have emitted phase events.
    const phaseEvents = events.filter((e) => e.kind === "phase");
    expect(phaseEvents.length).toBeGreaterThanOrEqual(3); // at least planning + running + delivered
    // Should have conversation messages.
    expect(result.conversation.length).toBeGreaterThan(0);
    // The final output should contain the code.
    expect(result.finalOutput).toContain("is_prime");
  });

  it("writes the delivered output to --out file", async () => {
    const registry = makeMockRegistry() as any;
    const scheduler = new Scheduler(defaultPolicy(), { concurrency: 2 });
    const outFile = join(TMP, "solution.py");

    const result = await new TaskOrchestrator(registry as any, mockRouter, scheduler, defaultPolicy(), {
      task: "write is_prime(n)",
      agents: ["codex", "gemini", "codex", "claude"],
      maxLoops: 0,
      timeoutSec: 10,
      cwd: TMP,
      out: "solution.py",
      extractCode: true,
    }).run();

    expect(result.status).toBe("delivered");
    // The file MUST exist with the extracted code.
    expect(existsSync(outFile)).toBe(true);
    const content = readFileSync(outFile, "utf8");
    expect(content).toContain("def is_prime");
    expect(content).not.toContain("```"); // code block stripped
  });

  it("emits phase transition events in order", async () => {
    const registry = makeMockRegistry() as any;
    const scheduler = new Scheduler(defaultPolicy(), { concurrency: 2 });
    const phases: string[] = [];

    await new TaskOrchestrator(registry as any, mockRouter, scheduler, defaultPolicy(), {
      task: "test",
      agents: ["codex", "gemini", "codex", "claude"],
      maxLoops: 0,
      timeoutSec: 10,
      cwd: TMP,
      onEvent: (e) => { if (e.kind === "phase") phases.push(e.phase); },
    }).run();

    // Planning must come before running, running before delivered.
    expect(phases).toContain("planning");
    expect(phases).toContain("running");
    expect(phases).toContain("delivered");
    expect(phases.indexOf("planning")).toBeLessThan(phases.indexOf("running"));
    expect(phases.indexOf("running")).toBeLessThan(phases.indexOf("delivered"));
  });

  it("conversation messages show agent handoffs (fromAgent → toAgent)", async () => {
    const registry = makeMockRegistry() as any;
    const scheduler = new Scheduler(defaultPolicy(), { concurrency: 2 });

    const result = await new TaskOrchestrator(registry as any, mockRouter, scheduler, defaultPolicy(), {
      task: "test",
      agents: ["codex", "gemini", "codex", "claude"],
      maxLoops: 0,
      timeoutSec: 10,
      cwd: TMP,
    }).run();

    // At least the planning message should have a handoff target.
    const planningMsg = result.conversation.find((m) => m.phase === "planning");
    expect(planningMsg).toBeDefined();
    expect(planningMsg!.fromAgent).toBe("codex");
    expect(planningMsg!.toAgent).toBeDefined(); // handed off to next phase's agent
    expect(planningMsg!.content.length).toBeGreaterThan(0);
  });
});

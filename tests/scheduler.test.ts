/**
 * Stack Ai OS — Scheduler regression tests.
 *
 * CRITICAL: the scheduler previously never accumulated streamed assistant text
 * into finalText (it only read done.finalText, which is empty for codex/gemini).
 * This broke EVERY pattern — empty candidates, empty orchestration phases.
 * These tests lock the fix: assistant text events MUST accumulate into finalText,
 * and a non-empty done.finalText MUST override the accumulation.
 */
import { describe, it, expect } from "vitest";
import { Scheduler } from "../src/kernel/scheduler.js";
import { defaultPolicy } from "../src/safety/policy.js";
import { MockAdapter, streamedTextEvents, doneTextEvents, mockRouter } from "./_mock.js";

function scheduler() {
  return new Scheduler(defaultPolicy(), { concurrency: 2 });
}

describe("scheduler finalText accumulation (regression: the critical bug)", () => {
  it("accumulates streamed assistant text events into finalText", async () => {
    // codex/gemini shape: text arrives via assistant events, done.finalText is EMPTY.
    const adapter = new MockAdapter({
      events: streamedTextEvents("def hello(): return 'world'"),
    });
    const handle = scheduler().submit(adapter, mockRouter, {
      agent: "mock", prompt: "x", verbosity: "stream-json",
    });
    const result = await handle.done;
    // MUST be the streamed text, NOT empty.
    expect(result.finalText).toBe("def hello(): return 'world'");
    expect(result.finalText.length).toBeGreaterThan(0);
  });

  it("accumulates MULTIPLE streamed text events (concatenation)", async () => {
    const adapter = new MockAdapter({
      events: [
        { type: "assistant", subtype: "text", text: "part1 " },
        { type: "assistant", subtype: "text", text: "part2 " },
        { type: "assistant", subtype: "text", text: "part3" },
        { type: "done", exitCode: 0, finalText: "" },
      ],
    });
    const result = await scheduler().submit(adapter, mockRouter, {
      agent: "mock", prompt: "x", verbosity: "stream-json",
    }).done;
    expect(result.finalText).toBe("part1 part2 part3");
  });

  it("uses done.finalText when it's NON-empty (overrides accumulation)", async () => {
    // Some adapters put the full text only in done.finalText.
    const adapter = new MockAdapter({ events: doneTextEvents("the real output") });
    const result = await scheduler().submit(adapter, mockRouter, {
      agent: "mock", prompt: "x", verbosity: "stream-json",
    }).done;
    expect(result.finalText).toBe("the real output");
  });

  it("does NOT overwrite with empty done.finalText when text was streamed", async () => {
    // The exact bug: assistant text streamed, then done with empty finalText.
    const adapter = new MockAdapter({
      events: [
        { type: "assistant", subtype: "text", text: "streamed content" },
        { type: "done", exitCode: 0, finalText: "" }, // empty — must NOT clear
      ],
    });
    const result = await scheduler().submit(adapter, mockRouter, {
      agent: "mock", prompt: "x", verbosity: "stream-json",
    }).done;
    expect(result.finalText).toBe("streamed content"); // not ""
  });

  it("ignores thinking events for finalText (only text accumulates)", async () => {
    const adapter = new MockAdapter({
      events: [
        { type: "assistant", subtype: "thinking", text: "let me think" },
        { type: "assistant", subtype: "text", text: "actual answer" },
        { type: "done", exitCode: 0, finalText: "" },
      ],
    });
    const result = await scheduler().submit(adapter, mockRouter, {
      agent: "mock", prompt: "x", verbosity: "stream-json",
    }).done;
    expect(result.finalText).toBe("actual answer");
    expect(result.finalText).not.toContain("think");
  });

  it("reports exitCode and sessionId from the done event", async () => {
    const adapter = new MockAdapter({
      events: [
        { type: "assistant", subtype: "text", text: "hi" },
        { type: "done", exitCode: 0, finalText: "", sessionId: "sess-123" },
      ],
    });
    const result = await scheduler().submit(adapter, mockRouter, {
      agent: "mock", prompt: "x", verbosity: "stream-json",
    }).done;
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("sess-123");
  });

  it("accumulates cost across multiple cost events", async () => {
    const adapter = new MockAdapter({
      events: [
        { type: "cost", costUsd: 0.01 },
        { type: "cost", costUsd: 0.02 },
        { type: "done", exitCode: 0, finalText: "" },
      ],
    });
    const result = await scheduler().submit(adapter, mockRouter, {
      agent: "mock", prompt: "x", verbosity: "stream-json",
    }).done;
    expect(result.costUsd).toBeCloseTo(0.03, 5);
  });
});

describe("scheduler error capture (regression: failures were invisible)", () => {
  it("captures an agent error event into result.error", async () => {
    // codex/gemini shape: agent exits 0 but emits an error in its JSON stream
    // (e.g. auth failure, rate limit). The scheduler MUST surface this so the
    // orchestrator + dashboard can explain the failure.
    const adapter = new MockAdapter({
      events: [
        { type: "error", message: "401 Unauthorized: invalid API key", recoverable: false },
        { type: "done", exitCode: 0, finalText: "" },
      ],
    });
    const result = await scheduler().submit(adapter, mockRouter, {
      agent: "mock", prompt: "x", verbosity: "stream-json",
    }).done;
    expect(result.error).toBe("401 Unauthorized: invalid API key");
    expect(result.finalText).toBe("");
  });

  it("keeps the first error when multiple are emitted", async () => {
    const adapter = new MockAdapter({
      events: [
        { type: "error", message: "first error", recoverable: false },
        { type: "error", message: "second error", recoverable: false },
        { type: "done", exitCode: 1, finalText: "" },
      ],
    });
    const result = await scheduler().submit(adapter, mockRouter, {
      agent: "mock", prompt: "x", verbosity: "stream-json",
    }).done;
    expect(result.error).toBe("first error");
  });

  it("leaves result.error undefined when no error event fires", async () => {
    const adapter = new MockAdapter({ events: streamedTextEvents("all good") });
    const result = await scheduler().submit(adapter, mockRouter, {
      agent: "mock", prompt: "x", verbosity: "stream-json",
    }).done;
    expect(result.error).toBeUndefined();
    expect(result.finalText).toBe("all good");
  });
});

describe("scheduler concurrency + cancellation", () => {
  it("runs multiple jobs (within concurrency limit)", async () => {
    const sched = scheduler();
    const a = new MockAdapter({ events: streamedTextEvents("a") });
    const b = new MockAdapter({ events: streamedTextEvents("b") });
    const [ra, rb] = await Promise.all([
      sched.submit(a, mockRouter, { agent: "mock", prompt: "x" }).done,
      sched.submit(b, mockRouter, { agent: "mock", prompt: "x" }).done,
    ]);
    expect(ra.finalText).toBe("a");
    expect(rb.finalText).toBe("b");
  });

  it("cancel() marks the job as timed out", async () => {
    const adapter = new MockAdapter({
      events: streamedTextEvents("never"),
      delayMs: 100, // slow so cancel fires mid-stream
    });
    const handle = scheduler().submit(adapter, mockRouter, {
      agent: "mock", prompt: "x", verbosity: "stream-json",
    });
    handle.cancel();
    const result = await handle.done;
    expect(result.timedOut).toBe(true);
  });
});

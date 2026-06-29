/**
 * Stack Ai OS — TaskOrchestrator logic tests.
 *
 * Tests the deterministic pieces: phase sequencing, PHASE_PROMPTS templates,
 * team resolution, PHASE ordering. The full 6-phase run (which spawns real
 * agents) is validated via the end-to-end `stackai task` test.
 */
import { describe, it, expect } from "vitest";
import { PHASES, PHASE_LABELS, PHASE_PROMPTS, extractCodeBlock } from "../src/orchestrator/task.js";

describe("Phase definitions", () => {
  it("has exactly 6 phases in the right order", () => {
    expect(PHASES).toEqual(["planning", "orchestrating", "running", "testing", "looping", "delivered"]);
    expect(PHASES.length).toBe(6);
  });

  it("labels every phase in uppercase", () => {
    for (const p of PHASES) {
      expect(PHASE_LABELS[p]).toBe(p.toUpperCase());
    }
  });
});

describe("PHASE_PROMPTS", () => {
  it("defines the 4 core role prompts (planning/orchestrating/running/testing)", () => {
    expect(PHASE_PROMPTS.planning).toBeDefined();
    expect(PHASE_PROMPTS.orchestrating).toBeDefined();
    expect(PHASE_PROMPTS.running).toBeDefined();
    expect(PHASE_PROMPTS.testing).toBeDefined();
  });

  it("planning prompt references {{task}} but not {{prior}}", () => {
    expect(PHASE_PROMPTS.planning).toContain("{{task}}");
    expect(PHASE_PROMPTS.planning).not.toContain("{{prior}}");
  });

  it("running/testing prompts chain via {{prior}} (sequential handoff)", () => {
    expect(PHASE_PROMPTS.running).toContain("{{prior}}");
    expect(PHASE_PROMPTS.testing).toContain("{{prior}}");
    expect(PHASE_PROMPTS.orchestrating).toContain("{{prior}}");
  });

  it("testing prompt includes a VERDICT directive (PASS/FAIL)", () => {
    expect(PHASE_PROMPTS.testing).toMatch(/VERDICT:\s*PASS/i);
    expect(PHASE_PROMPTS.testing).toMatch(/VERDICT:\s*FAIL/i);
  });

  it("prompt substitution works (task + prior)", () => {
    const filled = PHASE_PROMPTS.running
      .replace(/\{\{task\}\}/g, "build a rate limiter")
      .replace(/\{\{prior\}\}/g, "PLAN: step 1...");
    expect(filled).toContain("build a rate limiter");
    expect(filled).toContain("PLAN: step 1...");
    expect(filled).not.toContain("{{");
  });
});

describe("phase sequence invariant", () => {
  it("delivered is always the last phase", () => {
    expect(PHASES[PHASES.length - 1]).toBe("delivered");
  });
  it("planning is always the first phase", () => {
    expect(PHASES[0]).toBe("planning");
  });
  it("running comes before testing (implement then review)", () => {
    expect(PHASES.indexOf("running")).toBeLessThan(PHASES.indexOf("testing"));
  });
  it("looping comes after testing (review triggers loop)", () => {
    expect(PHASES.indexOf("testing")).toBeLessThan(PHASES.indexOf("looping"));
  });
});

describe("extractCodeBlock", () => {
  it("extracts a fenced code block", () => {
    const text = "Here's the solution:\n```python\ndef f(): return 42\n```\nDone.";
    expect(extractCodeBlock(text)).toBe("def f(): return 42");
  });

  it("handles language-tagged fences", () => {
    const text = "```ts\nconst x = 1;\n```";
    expect(extractCodeBlock(text)).toBe("const x = 1;");
  });

  it("returns the LONGEST block when multiple present", () => {
    const text = "```\nshort\n```\n```python\n# this is the real solution\ndef is_prime(n):\n    return n > 1\n```";
    const result = extractCodeBlock(text);
    expect(result).toContain("is_prime");
    expect(result).not.toContain("short");
  });

  it("returns null when no code block present", () => {
    expect(extractCodeBlock("just plain text, no code")).toBeNull();
  });

  it("handles multi-line blocks with blank lines", () => {
    const text = "```\nline1\n\nline3\n```";
    expect(extractCodeBlock(text)).toBe("line1\n\nline3");
  });
});

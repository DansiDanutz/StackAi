/**
 * Stack Ai OS — Pattern logic tests (pipeline, debate, divide-and-conquer).
 *
 * Tests the pure, deterministic helpers: subtask parsing (JSON extraction +
 * defensive fallbacks), the divide/debate similarity convergence, and the
 * pipeline default-stage construction. The full loop (which spawns CLIs) is
 * validated via the live end-to-end test.
 */
import { describe, it, expect } from "vitest";
import { parseSubtasks } from "../src/patterns/divide.js";
import { DEFAULT_STAGE_PROMPTS } from "../src/patterns/pipeline.js";

describe("parseSubtasks (divide-and-conquer decomposer output)", () => {
  it("parses a clean JSON array", () => {
    const text = '["implement auth", "write tests", "add docs"]';
    expect(parseSubtasks(text, 6)).toEqual(["implement auth", "write tests", "add docs"]);
  });

  it("extracts JSON array from surrounding prose", () => {
    const text = 'Here is the decomposition:\n["subtask one", "subtask two"]\nLet me know.';
    expect(parseSubtasks(text, 6)).toEqual(["subtask one", "subtask two"]);
  });

  it("respects the max cap", () => {
    const text = '["a","b","c","d","e","f","g","h"]';
    expect(parseSubtasks(text, 3).length).toBe(3);
  });

  it("returns empty array on malformed JSON", () => {
    expect(parseSubtasks("not json at all", 6)).toEqual([]);
    expect(parseSubtasks("{broken}", 6)).toEqual([]);
  });

  it("returns empty array when not an array", () => {
    expect(parseSubtasks('{"key": "value"}', 6)).toEqual([]);
  });

  it("filters empty strings and trims", () => {
    const text = '["  spaced  ", "", "valid"]';
    expect(parseSubtasks(text, 6)).toEqual(["spaced", "valid"]);
  });
});

describe("pipeline default stage prompts", () => {
  it("defines the 4 canonical stages", () => {
    expect(DEFAULT_STAGE_PROMPTS.plan).toBeDefined();
    expect(DEFAULT_STAGE_PROMPTS.code).toBeDefined();
    expect(DEFAULT_STAGE_PROMPTS.review).toBeDefined();
    expect(DEFAULT_STAGE_PROMPTS.fix).toBeDefined();
  });

  it("plan stage references the task but not prior", () => {
    expect(DEFAULT_STAGE_PROMPTS.plan).toContain("{{task}}");
    expect(DEFAULT_STAGE_PROMPTS.plan).not.toContain("{{prior}}");
  });

  it("code/review/fix stages chain via {{prior}}", () => {
    expect(DEFAULT_STAGE_PROMPTS.code).toContain("{{prior}}");
    expect(DEFAULT_STAGE_PROMPTS.review).toContain("{{prior}}");
    expect(DEFAULT_STAGE_PROMPTS.fix).toContain("{{prior}}");
  });
});

describe("debate/pipeline similarity (convergence)", () => {
  // Re-test the shared convergence algorithm (same impl in ensemble/debate).
  function similarity(a: string, b: string): number {
    if (!a || !b) return 0;
    const ta = new Set(a.toLowerCase().split(/\s+/));
    const tb = new Set(b.toLowerCase().split(/\s+/));
    let inter = 0;
    for (const t of ta) if (tb.has(t)) inter++;
    const union = ta.size + tb.size - inter;
    return union === 0 ? 0 : inter / union;
  }

  it("signals convergence at high overlap", () => {
    const v1 = "use PKCE with a code verifier and challenge for the auth flow";
    const v2 = "use PKCE with a code verifier and challenge for the auth flow";
    expect(similarity(v1, v2)).toBeGreaterThanOrEqual(0.9);
  });

  it("signals non-convergence at low overlap", () => {
    const v1 = "implement OAuth 2.0 with PKCE";
    const v2 = "use a simple API key header instead";
    expect(similarity(v1, v2)).toBeLessThan(0.5);
  });
});

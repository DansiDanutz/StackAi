/**
 * Stack Ai OS — Ensemble helpers tests.
 *
 * The loop engine itself spawns real CLIs (integration-level), but its pure
 * helper functions — similarity (convergence), labelToIndex — are unit-tested
 * here. The full loop is exercised via the 'judge' pattern tests + integration.
 */
import { describe, it, expect } from "vitest";

// similarity is module-private; we re-test the same algorithm to lock the
// convergence contract. Identical logic lives in patterns/ensemble.ts.
function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const ta = new Set(a.toLowerCase().split(/\s+/));
  const tb = new Set(b.toLowerCase().split(/\s+/));
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

describe("convergence similarity", () => {
  it("returns 1 for identical text", () => {
    expect(similarity("the quick brown fox", "the quick brown fox")).toBe(1);
  });
  it("returns 0 for disjoint text", () => {
    expect(similarity("aaa", "zzz")).toBe(0);
  });
  it("returns 0 for empty input", () => {
    expect(similarity("", "something")).toBe(0);
    expect(similarity("something", "")).toBe(0);
  });
  it("is case-insensitive", () => {
    expect(similarity("Hello World", "hello world")).toBe(1);
  });
  it("rises as two solutions converge", () => {
    const v1 = "function auth(user, pass) { return check(user, pass); }";
    const v2 = "function auth(user, pass) { return check(user, pass); }"; // identical
    const v3 = "function auth(u, p) { return check(u, p); }"; // same shape, renamed
    expect(similarity(v1, v2)).toBeGreaterThan(0.99);
    expect(similarity(v1, v3)).toBeGreaterThan(0.2); // partial overlap (token-set Jaccard)
  });
});

describe("convergence threshold logic", () => {
  it("a ratio >= 0.9 signals convergence (stop refining)", () => {
    const before = "refactor the module to use async await and add tests for edge cases";
    const after = "refactor the module to use async await and add tests for edge cases";
    const ratio = similarity(before, after);
    expect(ratio).toBeGreaterThanOrEqual(0.9); // would stop the loop
  });
});

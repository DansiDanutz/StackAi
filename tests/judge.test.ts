/**
 * Stack Ai OS — Judge verdict parser tests.
 *
 * Pure-logic tests: parseVerdict must handle well-formed JSON, judge text with
 * surrounding prose, malformed JSON, and empty/missing fields. No agents spawn.
 */
import { describe, it, expect } from "vitest";
import { parseVerdict, labelToIndex } from "../src/patterns/judge.js";

describe("parseVerdict", () => {
  it("parses a clean accept verdict", () => {
    const text = `{
      "scores": { "A": 92, "B": 78 },
      "ranking": ["A", "B"],
      "winner": "A",
      "notes": { "A": "complete", "B": "missing tests" },
      "action": "accept"
    }`;
    const v = parseVerdict(text, ["A", "B"], 2);
    expect(v.scores.A).toBe(92);
    expect(v.scores.B).toBe(78);
    expect(v.winner).toBe("A");
    expect(v.action).toBe("accept");
    expect(v.ranking).toEqual(["A", "B"]);
  });

  it("parses a refine verdict with a target + feedback", () => {
    const text = JSON.stringify({
      scores: { A: 65, B: 71 },
      ranking: ["B", "A"],
      winner: "B",
      notes: { A: "weak", B: "close" },
      action: "refine",
      refineTarget: "A",
      refineFeedback: "Add edge case for empty input",
    });
    const v = parseVerdict(text, ["A", "B"], 2);
    expect(v.action).toBe("refine");
    expect(v.refineTarget).toBe("A");
    expect(v.refineFeedback).toContain("empty input");
  });

  it("extracts JSON from surrounding prose", () => {
    const text = `Here is my verdict:\n{"scores":{"A":90,"B":60},"ranking":["A","B"],"winner":"A","notes":{},"action":"accept"}\nDone.`;
    const v = parseVerdict(text, ["A", "B"], 2);
    expect(v.winner).toBe("A");
    expect(v.scores.A).toBe(90);
  });

  it("clamps out-of-range scores", () => {
    const v = parseVerdict('{"scores":{"A":150,"B":-10},"action":"accept","ranking":["A"],"winner":"A","notes":{}}', ["A", "B"], 2);
    expect(v.scores.A).toBe(100);
    expect(v.scores.B).toBe(0);
  });

  it("falls back to reject verdict on unparseable text", () => {
    const v = parseVerdict("not json at all", ["A", "B"], 2);
    expect(v.action).toBe("reject");
    expect(v.scores.A).toBe(0);
  });

  it("falls back to reject verdict on malformed JSON", () => {
    const v = parseVerdict("{ broken json }", ["A"], 1);
    expect(v.action).toBe("reject");
  });

  it("computes ranking from scores when ranking missing/invalid", () => {
    const v = parseVerdict('{"scores":{"A":40,"B":80},"action":"refine","winner":"","notes":{}}', ["A", "B"], 2);
    expect(v.ranking[0]).toBe("B"); // higher score first
    expect(v.ranking[1]).toBe("A");
  });
});

describe("labelToIndex", () => {
  it("maps labels to indices", () => {
    expect(labelToIndex("A")).toBe(0);
    expect(labelToIndex("B")).toBe(1);
    expect(labelToIndex("D")).toBe(3);
    expect(labelToIndex("Z")).toBe(-1); // out of range
  });
});

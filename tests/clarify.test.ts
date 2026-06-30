/**
 * Stack Ai OS — Clarification layer tests.
 *
 * Tests the GSD-ported ambiguity model (spec-phase) + response parsing
 * (discuss-phase). The ambiguity scoring + JSON parsing are pure functions,
 * so we test them deterministically without spawning agents.
 */
import { describe, it, expect } from "vitest";
import {
  ambiguityScore,
  isClearEnough,
  parseClarifyResponse,
  extractJson,
} from "../src/orchestrator/clarify.js";

describe("ambiguity model (GSD spec-phase)", () => {
  it("scores 0 (perfectly clear) when all dimensions are 1.0", () => {
    const score = ambiguityScore({ goal: 1, boundary: 1, constraint: 1, acceptance: 1 });
    expect(score).toBe(0);
    expect(isClearEnough({ goal: 1, boundary: 1, constraint: 1, acceptance: 1 })).toBe(true);
  });

  it("scores high ambiguity when all dimensions are low", () => {
    const score = ambiguityScore({ goal: 0.2, boundary: 0.2, constraint: 0.2, acceptance: 0.2 });
    expect(score).toBeGreaterThan(0.7);
    expect(isClearEnough({ goal: 0.2, boundary: 0.2, constraint: 0.2, acceptance: 0.2 })).toBe(false);
  });

  it("respects the GSD gate: ambiguity ≤ 0.20 AND all dims ≥ minimums", () => {
    // High scores across all dims → ambiguity well below 0.20 → clear.
    expect(isClearEnough({ goal: 0.95, boundary: 0.9, constraint: 0.85, acceptance: 0.9 })).toBe(true);
    // Goal below its 0.75 minimum → NOT clear even if overall ambiguity is low.
    expect(isClearEnough({ goal: 0.6, boundary: 1, constraint: 1, acceptance: 1 })).toBe(false);
    // Boundary below its 0.70 minimum.
    expect(isClearEnough({ goal: 1, boundary: 0.5, constraint: 1, acceptance: 1 })).toBe(false);
  });

  it("uses GSD's weighted formula (goal 35%, boundary 25%, constraint 20%, acceptance 20%)", () => {
    // Verify the weights: dropping only goal (weight 0.35) from 1.0 to 0.0
    // should increase ambiguity by exactly 0.35.
    const full = ambiguityScore({ goal: 1, boundary: 1, constraint: 1, acceptance: 1 });
    const noGoal = ambiguityScore({ goal: 0, boundary: 1, constraint: 1, acceptance: 1 });
    expect(noGoal - full).toBeCloseTo(0.35, 5);
  });
});

describe("extractJson", () => {
  it("extracts a fenced ```json block", () => {
    const text = 'Here is my assessment:\n```json\n{"clear": true}\n```\nDone.';
    expect(extractJson(text)).toBe('{"clear": true}');
  });

  it("extracts a fenced ``` block (no json tag)", () => {
    const text = '```\n{"clear": false}\n```';
    expect(extractJson(text)).toBe('{"clear": false}');
  });

  it("extracts a bare JSON object (no fence)", () => {
    const text = 'The answer is {"clear": true, "score": {"goal": 1}} thanks.';
    expect(extractJson(text)).toContain('"clear": true');
  });

  it("returns null when no JSON is present", () => {
    expect(extractJson("just plain text, no json here")).toBeNull();
  });
});

describe("parseClarifyResponse", () => {
  it("parses a clear response", () => {
    const text = '```json\n{"clear": true, "score": {"goal": 0.9, "boundary": 0.85, "constraint": 0.8, "acceptance": 0.85}, "questions": []}\n```';
    const result = parseClarifyResponse(text);
    expect(result.clear).toBe(true);
    if (result.clear) {
      expect(result.score.goal).toBe(0.9);
    }
  });

  it("parses an ambiguous response with questions", () => {
    const text = `\`\`\`json
{
  "clear": false,
  "score": {"goal": 0.4, "boundary": 0.3, "constraint": 0.5, "acceptance": 0.2},
  "questions": [
    {
      "id": "q_output",
      "header": "Output",
      "question": "What should the output be?",
      "options": [
        {"label": "CLI script", "description": "runnable .py", "recommended": true},
        {"label": "Web app", "description": "browser-based"}
      ]
    }
  ]
}
\`\`\``;
    const result = parseClarifyResponse(text);
    expect(result.clear).toBe(false);
    if (!result.clear) {
      expect(result.questions).toHaveLength(1);
      expect(result.questions[0].id).toBe("q_output");
      expect(result.questions[0].options).toHaveLength(2);
      expect(result.questions[0].options[0].recommended).toBe(true);
    }
  });

  it("overrides clear:false with isClearEnough when scores are actually high", () => {
    // An agent says clear:false but gives high scores — the GSD gate should
    // override and mark it clear (the scores are objective, the boolean is not).
    const text = '{"clear": false, "score": {"goal": 1, "boundary": 1, "constraint": 1, "acceptance": 1}, "questions": []}';
    const result = parseClarifyResponse(text);
    expect(result.clear).toBe(true);
  });

  it("returns null on unparseable output (caller decides fallback)", () => {
    const result = parseClarifyResponse("the agent returned prose, no json");
    expect(result).toBeNull();
  });

  it("defaults to clear when clear:false but no valid questions", () => {
    const text = '{"clear": false, "score": {"goal": 0.1}, "questions": []}';
    const result = parseClarifyResponse(text);
    expect(result).not.toBeNull();
    expect(result?.clear).toBe(true);
  });

  it("clamps scores to 0-1 range", () => {
    const text = '{"clear": true, "score": {"goal": 1.5, "boundary": -0.3, "constraint": 0.8, "acceptance": 0.8}}';
    const result = parseClarifyResponse(text);
    if (result.clear) {
      expect(result.score.goal).toBe(1);
      expect(result.score.boundary).toBe(0);
    }
  });
});

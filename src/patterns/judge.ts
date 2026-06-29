/**
 * Stack Ai OS — Judge
 *
 * Ranks candidate solutions by a rubric using a judge agent. The judge sees the
 * original task + all candidates (blind, labeled A/B/C…) and returns a
 * structured verdict: scores, rationale, ranking, and a verdict action
 * (accept / refine / reject).
 *
 * The prompt is engineered to elicit strict JSON so we can parse it reliably.
 */
import type { AgentAdapter, ModelRouter, RunResult } from "../types.js";
import { runSolo } from "./solo.js";
import type { SafetyPolicy } from "../safety/policy.js";

export interface Candidate {
  result: RunResult;
  model?: string;
}

export interface Verdict {
  /** Map of candidate label → score (0-100). */
  scores: Record<string, number>;
  /** Ordered labels best-first. */
  ranking: string[];
  /** Best label. */
  winner: string;
  /** Per-candidate one-line strengths/weaknesses. */
  notes: Record<string, string>;
  /** What the judge recommends. */
  action: "accept" | "refine" | "reject";
  /** If refine: which label to re-run + feedback for it. */
  refineTarget?: string;
  refineFeedback?: string;
  /** Raw judge text (for debugging / display). */
  raw: string;
}

const RUBRIC = `You are a strict senior engineer judging candidate solutions to a coding task.

Score each candidate 0-100 on: correctness, completeness, edge-case handling, code quality, and whether it likely passes tests.

Return ONLY a JSON object with this exact schema, no prose before or after:
{
  "scores": { "A": 0-100, "B": 0-100 },
  "ranking": ["best_label", "next_label"],
  "winner": "best_label",
  "notes": { "A": "one-line strength/weakness", "B": "..." },
  "action": "accept" | "refine" | "reject",
  "refineTarget": "label_if_refine_else_omit",
  "refineFeedback": "specific improvements for the target_if_refine"
}
- action "accept": a candidate is clearly good enough (score >= 85).
- action "refine": close but needs work (best score 60-84); name refineTarget.
- action "reject": all candidates fundamentally wrong (best < 60).
If JSON-only output is impossible, output { "action":"reject", "ranking":[], "winner":"", "scores":{}, "notes":{} }.`;

/** Run the judge over candidates. Returns a parsed Verdict (best-effort). */
export async function judgeCandidates(
  judgeAdapter: AgentAdapter,
  router: ModelRouter,
  policy: SafetyPolicy,
  task: string,
  candidates: Candidate[],
  opts?: { cwd?: string; model?: string; onEvent?: (evt: any) => void }
): Promise<{ verdict: Verdict; result: RunResult }> {
  const labels = "ABCDEFGH".slice(0, candidates.length).split("");
  const presented = candidates.map((c, i) => {
    const head = `=== Candidate ${labels[i]} ===`;
    const body = c.result.finalText || "(empty output)";
    return `${head}\n${body}`;
  }).join("\n\n");

  const prompt = `${RUBRIC}\n\n=== TASK ===\n${task}\n\n=== CANDIDATES ===\n${presented}\n\nReturn the JSON verdict now.`;

  const result = await runSolo(judgeAdapter, router, {
    agent: judgeAdapter.name,
    prompt,
    model: opts?.model,
    posture: "cautious",
    verbosity: "text", // we want the raw JSON text
    cwd: opts?.cwd,
    timeoutSec: 300,
    onEvent: opts?.onEvent ? (_a, e) => opts.onEvent!(e) : undefined,
  }, policy);

  const verdict = parseVerdict(result.finalText, labels, candidates.length);
  return { verdict, result };
}

/** Parse the judge's JSON verdict defensively. Falls back to a reject verdict. */
export function parseVerdict(text: string, labels: string[], count: number): Verdict {
  // Extract the first {...} block (judge may add stray text).
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return rejectVerdict(labels, text);
  let obj: any;
  try {
    obj = JSON.parse(match[0]);
  } catch {
    return rejectVerdict(labels, text);
  }

  const scores: Record<string, number> = {};
  for (const l of labels) scores[l] = clamp(Number(obj.scores?.[l] ?? 0));

  const scoreOf = (l: string) => scores[l] ?? 0;
  const ranking = Array.isArray(obj.ranking) && obj.ranking.length
    ? obj.ranking.filter((l: any) => labels.includes(l))
    : [...labels].sort((a, b) => scoreOf(b) - scoreOf(a));

  const winner = labels.includes(obj.winner) ? obj.winner : (ranking[0] ?? labels[0] ?? "");

  const notes: Record<string, string> = {};
  for (const l of labels) notes[l] = String(obj.notes?.[l] ?? "");

  const action = ["accept", "refine", "reject"].includes(obj.action) ? obj.action : "reject";

  return {
    scores,
    ranking,
    winner,
    notes,
    action,
    refineTarget: labels.includes(obj.refineTarget) ? obj.refineTarget : undefined,
    refineFeedback: obj.refineFeedback ? String(obj.refineFeedback) : undefined,
    raw: text,
  };
}

function rejectVerdict(labels: string[], raw: string): Verdict {
  const scores: Record<string, number> = {};
  for (const l of labels) scores[l] = 0;
  return {
    scores, ranking: [], winner: labels[0] ?? "", notes: {},
    action: "reject", raw,
  };
}

function clamp(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Convert a label back to a candidate index. */
export function labelToIndex(label: string): number {
  return "ABCDEFGH".indexOf(label);
}

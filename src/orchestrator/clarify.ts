/**
 * Stack Ai OS — Clarification layer (ported from GSD's spec-phase + discuss-phase)
 *
 * GSD's autonomous SDK is Claude-locked and has no planOnly() API — its
 * planning/clarification is driven by agent markdown workflows. To get GSD's
 * structuring rigor without that lock-in, we port its two most valuable engines
 * here as a standalone layer that runs on ANY agent in our fleet:
 *
 *   1. The ambiguity model (spec-phase.md:8-23) — a quantitative 4-dimension
 *      clarity score that decides whether the task is clear enough to proceed.
 *   2. The gray-area question generator (discuss-phase.md + domain-probes.md) —
 *      produces the clarifying questions the user sees when a task is ambiguous.
 *
 * The clarifier agent does BOTH in one call: score the task AND, if ambiguous,
 * propose the gray areas + questions. We parse its structured JSON output.
 */
import type { AgentName, AgentAdapter, RunRequest } from "../types.js";
import type { AdapterRegistry } from "../adapters/registry.js";
import type { ModelRouter } from "../types.js";
import type { Scheduler } from "../kernel/scheduler.js";
import type { SafetyPolicy } from "../safety/policy.js";

// ── GSD ambiguity model (spec-phase.md:8-23) ────────────────────────────────

/** The four clarity dimensions + GSD's weights + per-dimension minimums. */
export interface ClarityScore {
  goal: number;        // weight 0.35, min 0.75 — is the outcome specific + measurable?
  boundary: number;    // weight 0.25, min 0.70 — what's in vs out of scope?
  constraint: number;  // weight 0.20, min 0.65 — perf, compatibility, data needs?
  acceptance: number;  // weight 0.20, min 0.70 — how do we know it's done?
}

const WEIGHTS = { goal: 0.35, boundary: 0.25, constraint: 0.20, acceptance: 0.20 };
const MINS = { goal: 0.75, boundary: 0.70, constraint: 0.65, acceptance: 0.70 };
/** GSD gate: ambiguity ≤ 0.20 (i.e. ≥80% weighted clarity) → clear enough. */
const AMBIGUITY_THRESHOLD = 0.20;

/** Compute the GSD ambiguity score from a clarity assessment. */
export function ambiguityScore(s: ClarityScore): number {
  const weighted =
    WEIGHTS.goal * s.goal +
    WEIGHTS.boundary * s.boundary +
    WEIGHTS.constraint * s.constraint +
    WEIGHTS.acceptance * s.acceptance;
  return 1.0 - weighted;
}

/** Is the task clear enough to proceed without clarification? (GSD gate.) */
export function isClearEnough(s: ClarityScore): boolean {
  return (
    ambiguityScore(s) <= AMBIGUITY_THRESHOLD &&
    s.goal >= MINS.goal &&
    s.boundary >= MINS.boundary &&
    s.constraint >= MINS.constraint &&
    s.acceptance >= MINS.acceptance
  );
}

// ── Clarify result + question shapes ────────────────────────────────────────

export interface ClarifyOption {
  label: string;
  description?: string;
  recommended?: boolean;
}

export interface ClarifyQuestion {
  /** Stable id for matching answers (e.g. "q_output_format"). */
  id: string;
  /** Short tag (max ~12 chars) — GSD's "header" concept. */
  header: string;
  question: string;
  options: ClarifyOption[];
}

export type ClarifyResult =
  | { clear: true; score: ClarityScore }
  | { clear: false; score: ClarityScore; questions: ClarifyQuestion[] };

export interface ClarifyOptions {
  /** Agent to use for the clarification assessment. Default: "claude". */
  agent?: AgentName;
  model?: string;
  cwd?: string;
  /** Called when the clarifier emits progress / the question list. */
  onMessage?: (msg: string) => void;
}

/**
 * Assess a task's clarity and, if ambiguous, generate clarifying questions.
 *
 * Runs ONE agent call with a prompt that instructs the agent to:
 *   (1) score the task across GSD's 4 dimensions, and
 *   (2) if ambiguous, list 2-4 gray areas with concrete options.
 *
 * The agent must return a JSON object (we extract it from a fenced block to be
 * robust against agents that wrap their answer in prose). On any parse failure
 * we default to "clear" — never block the user behind a broken clarifier.
 */
export async function clarifyTask(
  registry: AdapterRegistry,
  router: ModelRouter,
  scheduler: Scheduler,
  policy: SafetyPolicy,
  task: string,
  opts?: ClarifyOptions,
): Promise<ClarifyResult> {
  const primary: AgentName = opts?.agent ?? "claude";
  const fleet = pickFleet(registry, primary);
  if (fleet.length === 0) {
    // No clarifier agent available — don't block; proceed as clear.
    return { clear: true, score: { goal: 1, boundary: 1, constraint: 1, acceptance: 1 } };
  }

  const prompt = buildClarifyPrompt(task);

  // Try each agent in the fleet until one produces a parseable, non-error
  // response. Agents may 401, crash, or return prose — we fall through just
  // like the orchestrator's adaptive recovery. Never block the user behind a
  // single broken clarifier agent.
  for (const adapter of fleet) {
    const req: RunRequest = {
      agent: adapter.name,
      prompt,
      model: opts?.model,
      verbosity: "text",
      cwd: opts?.cwd,
      timeoutSec: 90,
      label: "clarify",
    };
    let result;
    try {
      const h = scheduler.submit(adapter, router, req);
      result = await h.done;
    } catch {
      continue; // agent threw — try the next one
    }
    // Skip agents that errored (auth failure, crash) — their finalText is an
    // error string, not a real clarifier assessment.
    if (result.error || !result.finalText) continue;
    const parsed = parseClarifyResponse(result.finalText);
    if (!parsed) continue; // agent didn't return valid JSON — try the next one
    if (parsed.clear) {
      opts?.onMessage?.(`Task is clear enough to proceed (ambiguity ${(ambiguityScore(parsed.score) * 100).toFixed(0)}%). Starting orchestration.`);
    } else {
      opts?.onMessage?.(`This task has some ambiguity. Let me check ${parsed.questions.length} thing(s) before we start.`);
    }
    return parsed;
  }

  // Every agent failed or returned unparseable output — don't block; proceed as clear.
  opts?.onMessage?.(`Clarifier unavailable (all agents failed) — proceeding without clarification.`);
  return { clear: true, score: { goal: 1, boundary: 1, constraint: 1, acceptance: 1 } };
}

/**
 * Build the clarifier fleet: the primary agent first, then the rest of the
 * enabled fleet. The clarifier uses adaptive fallback like the orchestrator —
 * if claude 401s, it falls through to codex, gemini, etc.
 */
function pickFleet(registry: AdapterRegistry, primary: AgentName): AgentAdapter[] {
  const enabled = registry.enabled();
  const first = enabled.find((a) => a.name === primary);
  const rest = enabled.filter((a) => a.name !== primary);
  return first ? [first, ...rest] : enabled;
}

/**
 * The prompt sent to the clarifier agent. Encodes GSD's ambiguity model +
 * gray-area generation rules so any agent (not just Claude) can do the
 * assessment. The agent MUST respond with a JSON block.
 */
function buildClarifyPrompt(task: string): string {
  return `You are a TASK CLARIFIER. Your job: decide whether this task is clear enough to execute without further questions, and if not, propose the specific questions to ask.

=== TASK ===
${task}

=== DECISION RULE (apply strictly) ===
First, classify the task as CLEAR or AMBIGUOUS using these criteria:

CLEAR (set "clear": true, all scores high) — the task names a SPECIFIC deliverable with NO important open decisions:
- "write a Python is_prime function with tests"  → CLEAR (language, output, acceptance all specified)
- "reply with exactly PONG"  → CLEAR
- "explain how async/await works in JavaScript"  → CLEAR
- "refactor this function to use async/await" (with code attached)  → CLEAR

AMBIGUOUS (set "clear": false, scores low) — the task is VAGUE or leaves important decisions to the implementer:
- "make it better"  → AMBIGUOUS (better how? what to improve? what's the metric?)
- "build an app"  → AMBIGUOUS (what app? what platform? what features?)
- "add a feature"  → AMBIGUOUS (which feature? what should it do?)
- "improve the performance"  → AMBIGUOUS (which part? what target?)
- "fix the bug" (no details)  → AMBIGUOUS (which bug? what's the expected behavior?)
- "create a landing page"  → AMBIGUOUS (what product? what style? what sections?)

When in doubt, lean toward AMBIGUOUS — asking is cheaper than building the wrong thing.

=== HOW TO SCORE (only if you classified as AMBIGUOUS) ===
Score each dimension 0.0 (completely unclear) to 1.0 (crystal clear):
- goal: Is the outcome specific and measurable? "make it better" → goal ~0.2
- boundary: What's explicitly in scope vs out of scope? "build an app" → boundary ~0.3
- constraint: Are performance, compatibility, and data requirements known?
- acceptance: How do we know it's done? "make it better" → acceptance ~0.1

=== IF AMBIGUOUS: generate gray areas ===
Identify 2-4 gray areas — implementation DECISIONS the user cares about (what to build, output format, scope, style, key behavior). Do NOT ask about technical internals, architecture patterns, or performance optimization.
For each gray area, give ONE question with 2-3 concrete options. Mark the recommended one with "recommended": true.

=== OUTPUT (required format) ===
Respond with ONLY a JSON code block (no prose before or after):

\`\`\`json
{
  "clear": true,
  "score": { "goal": 1.0, "boundary": 1.0, "constraint": 1.0, "acceptance": 1.0 },
  "questions": []
}
\`\`\`

Or when ambiguous:
\`\`\`json
{
  "clear": false,
  "score": { "goal": 0.2, "boundary": 0.3, "constraint": 0.5, "acceptance": 0.2 },
  "questions": [
    {
      "id": "q_output",
      "header": "Output",
      "question": "What should the deliverable be?",
      "options": [
        { "label": "CLI script", "description": "a runnable .py file", "recommended": true },
        { "label": "Web app", "description": "browser-based" }
      ]
    }
  ]
}
\`\`\``;
}

/**
 * Parse the clarifier agent's response. Extracts the JSON block robustly
 * Returns null when no JSON can be parsed (the agent errored or ignored the
 * format). The caller decides whether to fall back to another agent or default
 * to clear — this function never silently fabricates a result.
 */
export function parseClarifyResponse(text: string): ClarifyResult | null {
  const json = extractJson(text);
  if (!json) return null;

  try {
    const obj = JSON.parse(json) as {
      clear?: boolean;
      score?: Partial<ClarityScore>;
      questions?: Array<Partial<ClarifyQuestion> & { options?: Array<Partial<ClarifyOption>> }>;
    };
    const score: ClarityScore = {
      goal: clamp(obj.score?.goal ?? 1),
      boundary: clamp(obj.score?.boundary ?? 1),
      constraint: clamp(obj.score?.constraint ?? 1),
      acceptance: clamp(obj.score?.acceptance ?? 1),
    };
    if (obj.clear || isClearEnough(score)) {
      return { clear: true, score };
    }
    const questions = (obj.questions ?? [])
      .filter((q) => q.question && q.options && q.options.length > 0)
      .map((q, i) => ({
        id: q.id ?? `q_${i}`,
        header: (q.header ?? `Q${i + 1}`).slice(0, 16),
        question: q.question!,
        options: q.options!.map((o) => ({
          label: String(o.label ?? "option"),
          description: o.description ? String(o.description) : undefined,
          recommended: Boolean(o.recommended),
        })),
      }));
    if (questions.length === 0) return { clear: true, score };
    return { clear: false, score, questions };
  } catch {
    return null;
  }
}

/** Extract the first JSON object or fenced ```json block from text. */
export function extractJson(text: string): string | null {
  // Fenced ```json ... ``` or ``` ... ```
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenced && fenced[1]) return fenced[1].trim();
  // Bare JSON object (greedy first { ... last })
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1).trim();
  return null;
}

function clamp(n: number): number {
  const v = typeof n === "number" && !isNaN(n) ? n : 1;
  return Math.max(0, Math.min(1, v));
}

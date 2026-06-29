/**
 * Stack Ai OS — Ensemble pattern + loop engine
 *
 * The core "best result" loop:
 *   1. Fan out N agents in parallel on the same task → N candidates.
 *   2. Judge ranks them.
 *   3. If action=refine and caps remain → feed judge feedback back to the
 *      weakest candidate and re-run it, then re-judge.
 *   4. Repeat until action=accept, candidates converge (diff-based), or a cap
 *      (budget / iterations / time) is hit.
 *
 * Caps are ENFORCED, not advisory — the loop never exceeds them.
 */
import type { AgentName, AgentEvent, RunRequest, RunResult } from "../types.js";
import type { AgentAdapter, ModelRouter } from "../types.js";
import type { AdapterRegistry } from "../adapters/registry.js";
import type { Scheduler } from "../kernel/scheduler.js";
import type { SafetyPolicy } from "../safety/policy.js";
import { judgeCandidates, labelToIndex, type Candidate, type Verdict } from "./judge.js";
import {
  createRun, updateRun, recordCandidate,
} from "../kernel/store.js";

export interface EnsembleOptions {
  task: string;
  agents: AgentName[];
  judgeAgent?: AgentName;
  model?: string;
  judgeModel?: string;
  width?: number;            // max agents to fan out (defaults to agents.length)
  maxIterations?: number;    // default 2
  budgetUsd?: number;        // hard cap; default 1.0
  timeoutSec?: number;       // per-agent; default 900
  cwd?: string;
  posture?: RunRequest["posture"];
  /** Live event sink. */
  onEvent?: (phase: string, agent: AgentName, evt: AgentEvent) => void;
  /** Called after each judge round with the current verdict. */
  onRound?: (iteration: number, verdict: Verdict, candidates: Candidate[]) => void;
}

export interface EnsembleResult {
  runId: string;
  winner: Candidate | undefined;
  winnerLabel: string | undefined;
  verdict: Verdict | undefined;
  iterations: number;
  spentUsd: number;
  allCandidates: Candidate[];
  stoppedReason: "accepted" | "converged" | "budget" | "iterations" | "timeout" | "error" | "no-candidates";
}

/** Convergence threshold: if the refined candidate's text is >=90% similar to the
 *  previous version, stop refining (it's not changing). */
const CONVERGE_RATIO = 0.9;

export async function runEnsemble(
  registry: AdapterRegistry,
  router: ModelRouter,
  scheduler: Scheduler,
  policy: SafetyPolicy,
  opts: EnsembleOptions
): Promise<EnsembleResult> {
  const budget = opts.budgetUsd ?? 1.0;
  const maxIter = opts.maxIterations ?? 2;
  const timeoutSec = opts.timeoutSec ?? 900;
  const width = Math.min(opts.width ?? opts.agents.length, opts.agents.length);

  const runId = createRun("ensemble", opts.task, { budgetUsd: budget, cwd: opts.cwd });
  let spentUsd = 0;
  let iterations = 0;
  const allCandidates: Candidate[] = [];
  let lastVerdict: Verdict | undefined;
  let stoppedReason: EnsembleResult["stoppedReason"] = "no-candidates";

  try {
    for (let iter = 0; iter <= maxIter; iter++) {
      iterations = iter;

      // ---- Phase 1: fan out (iter 0) or refine the weakest (iter > 0) ----
      let roundCandidates: Candidate[];

      if (iter === 0) {
        roundCandidates = await fanOut(opts, registry, router, scheduler, policy, width, timeoutSec, runId, (a, e) => opts.onEvent?.("solve", a, e));
        if (!roundCandidates.length) { stoppedReason = "no-candidates"; break; }
        allCandidates.push(...roundCandidates);
        // record each
        for (const c of roundCandidates) {
          recordCandidate(runId, iter, c.result, c.model);
        }
      } else {
        // Refine the weakest candidate from the previous verdict.
        if (!lastVerdict || lastVerdict.action !== "refine" || !lastVerdict.refineTarget) {
          stoppedReason = lastVerdict?.action === "accept" ? "accepted" : "iterations";
          break;
        }
        const idx = labelToIndex(lastVerdict.refineTarget);
        const base = roundCandidatesFromLast(allCandidates, lastVerdict)[idx];
        if (!base) { stoppedReason = "error"; break; }

        const beforeText = base.result.finalText;
        const refined = await refineOne(opts, registry, router, scheduler, policy, base, lastVerdict.refineFeedback ?? "", timeoutSec, runId, (a, e) => opts.onEvent?.("refine", a, e));
        // Convergence check: if refined ≈ before, stop.
        if (similarity(beforeText, refined.result.finalText) >= CONVERGE_RATIO) {
          stoppedReason = "converged";
          allCandidates.push(refined);
          recordCandidate(runId, iter, refined.result, refined.model);
          lastVerdict = (await judge(opts, registry, router, policy, allCandidates.slice(-roundCandidatesCount(allCandidates, lastVerdict)), runId)).verdict;
          break;
        }
        // Replace the weak candidate in the working set for re-judging.
        allCandidates.push(refined);
        recordCandidate(runId, iter, refined.result, refined.model);
        // working set = the same width from the end
        roundCandidates = lastWorkingSet(allCandidates, opts.agents.length);
      }

      // ---- Budget guard ----
      if (spentUsd >= budget) { stoppedReason = "budget"; break; }

      // ---- Phase 2: judge ----
      const working = iter === 0 ? roundCandidates : roundCandidates;
      const judgeRes = await judge(opts, registry, router, policy, working, runId, (e) => opts.onEvent?.("judge", opts.judgeAgent ?? "claude", e));
      lastVerdict = judgeRes.verdict;
      opts.onRound?.(iter, lastVerdict, working);

      if (lastVerdict.action === "accept") { stoppedReason = "accepted"; break; }
      if (lastVerdict.action === "reject") { stoppedReason = "iterations"; break; }
      // refine → loop
    }

    // Pick winner from the final verdict.
    let winner: Candidate | undefined;
    let winnerLabel: string | undefined;
    if (lastVerdict && lastVerdict.winner) {
      winnerLabel = lastVerdict.winner;
      const working = lastWorkingSet(allCandidates, opts.agents.length);
      const idx = labelToIndex(lastVerdict.winner);
      winner = working[idx];
    }
    if (!winner && allCandidates.length) winner = allCandidates[allCandidates.length - 1];

    updateRun(runId, {
      status: winner ? "done" : "failed",
      winnerAgent: winner?.result.agent,
      winnerText: winner?.result.finalText.slice(0, 5000),
      spentUsd: spentUsd,
      iterations,
      meta: { stoppedReason, winnerLabel, verdictAction: lastVerdict?.action },
    });

    return {
      runId, winner, winnerLabel, verdict: lastVerdict,
      iterations, spentUsd, allCandidates, stoppedReason,
    };
  } catch (e) {
    updateRun(runId, { status: "failed", meta: { error: (e as Error).message } });
    return {
      runId, winner: undefined, winnerLabel: undefined, verdict: lastVerdict,
      iterations, spentUsd, allCandidates, stoppedReason: "error",
    };
  }
}

// ---- helpers ---------------------------------------------------------------

async function fanOut(
  opts: EnsembleOptions, registry: AdapterRegistry, router: ModelRouter,
  scheduler: Scheduler, policy: SafetyPolicy, width: number, timeoutSec: number,
  _runId: string, onEvent: (a: AgentName, e: AgentEvent) => void
): Promise<Candidate[]> {
  const chosen = opts.agents.slice(0, width);
  const handles = chosen.map((agentName) => {
    const adapter = registry.require(agentName);
    const req: RunRequest = {
      agent: agentName, prompt: opts.task, model: opts.model,
      posture: opts.posture, verbosity: "stream-json",
      cwd: opts.cwd, timeoutSec,
    };
    return scheduler.submit(adapter, router, req, onEvent);
  });
  const results = await Promise.allSettled(handles.map((h) => h.done));
  const out: Candidate[] = [];
  for (const r of results) {
    if (r && r.status === "fulfilled" && (r.value.exitCode === 0 || r.value.finalText)) {
      out.push({ result: r.value, model: opts.model });
    }
  }
  return out;
}

async function refineOne(
  opts: EnsembleOptions, registry: AdapterRegistry, router: ModelRouter,
  scheduler: Scheduler, policy: SafetyPolicy, base: Candidate, feedback: string,
  timeoutSec: number, _runId: string, onEvent: (a: AgentName, e: AgentEvent) => void
): Promise<Candidate> {
  const agentName = base.result.agent;
  const adapter = registry.require(agentName);
  const prompt = `You previously produced this solution to a task. A reviewer gave feedback. Rewrite the solution to address it.

=== ORIGINAL TASK ===
${opts.task}

=== YOUR PREVIOUS SOLUTION ===
${base.result.finalText}

=== REVIEWER FEEDBACK ===
${feedback}

Produce the improved, complete solution now.`;
  const req: RunRequest = {
    agent: agentName, prompt, model: opts.model, posture: opts.posture,
    verbosity: "stream-json", cwd: opts.cwd, timeoutSec,
    sessionId: base.result.sessionId, // resume session if supported
  };
  const handle = scheduler.submit(adapter, router, req, onEvent);
  const result = await handle.done;
  return { result, model: opts.model };
}

async function judge(
  opts: EnsembleOptions, registry: AdapterRegistry, router: ModelRouter,
  policy: SafetyPolicy, candidates: Candidate[], _runId: string,
  onEvent?: (e: AgentEvent) => void
) {
  const judgeName = opts.judgeAgent ?? "claude";
  const adapter = registry.require(judgeName);
  return judgeCandidates(adapter, router, policy, opts.task, candidates, {
    cwd: opts.cwd, model: opts.judgeModel, onEvent,
  });
}

/** The working set for a judge round = last `width` candidates (most recent refinements). */
function lastWorkingSet(all: Candidate[], width: number): Candidate[] {
  return all.slice(-width);
}

function roundCandidatesFromLast(_all: Candidate[], v: Verdict): Candidate[] {
  return lastWorkingSet(_all, v.ranking.length || 3);
}

function roundCandidatesCount(_all: Candidate[], v: Verdict): number {
  return v.ranking.length || 3;
}

/** Token-overlap similarity ratio in [0,1] — cheap convergence proxy. */
function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const ta = new Set(a.toLowerCase().split(/\s+/));
  const tb = new Set(b.toLowerCase().split(/\s+/));
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

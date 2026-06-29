/**
 * Stack Ai OS — Debate pattern
 *
 * Adversarial refinement: two (or more) agents take turns proposing and
 * critiquing until their outputs converge or a round cap is hit. Unlike
 * ensemble (parallel candidates judged once), debate is iterative — each
 * critique is fed back as the basis for the next proposal.
 *
 * Flow: A proposes → B critiques → A revises (using critique) → B critiques → …
 * Convergence: when a revision is ≥X% similar to the prior (no change) or both
 * agents agree the solution is sound (judge action=accept), stop.
 */
import type { AgentName, AgentEvent, RunRequest, RunResult } from "../types.js";
import type { AdapterRegistry } from "../adapters/registry.js";
import type { ModelRouter } from "../types.js";
import type { Scheduler } from "../kernel/scheduler.js";
import type { SafetyPolicy } from "../safety/policy.js";
import { createRun, updateRun, recordCandidate } from "../kernel/store.js";
import { judgeCandidates, type Verdict } from "./judge.js";

export interface DebateOptions {
  task: string;
  /** Proposer agent (default claude). */
  proposer?: AgentName;
  /** Critic agent (default codex). */
  critic?: AgentName;
  model?: string;
  maxRounds?: number;        // default 3
  convergenceRatio?: number; // default 0.9
  timeoutSec?: number;
  cwd?: string;
  posture?: RunRequest["posture"];
  onEvent?: (role: string, agent: AgentName, evt: AgentEvent) => void;
  onRound?: (round: number, proposal: string, critique: string, converged: boolean) => void;
}

export interface DebateResult {
  runId: string;
  proposal: string;
  critique: string;
  rounds: number;
  converged: boolean;
  verdict?: Verdict;
  totalDurationMs: number;
  status: "done" | "failed";
}

const PROPOSE_PROMPT = `Propose a solution to this task. Consider the prior critique (if any) and revise your solution to address it.\n\n=== TASK ===\n{{task}}\n\n=== PRIOR CRITIQUE ===\n{{critique}}`;
const CRITIQUE_PROMPT = `Critique this proposed solution rigorously. Identify the strongest objections, missing cases, and flaws. Be adversarial but constructive.\n\n=== TASK ===\n{{task}}\n\n=== PROPOSED SOLUTION ===\n{{proposal}}`;

export async function runDebate(
  registry: AdapterRegistry,
  router: ModelRouter,
  scheduler: Scheduler,
  policy: SafetyPolicy,
  opts: DebateOptions
): Promise<DebateResult> {
  const proposerName = opts.proposer ?? "claude";
  const criticName = opts.critic ?? "codex";
  const maxRounds = opts.maxRounds ?? 3;
  const convergence = opts.convergenceRatio ?? 0.9;
  const timeoutSec = opts.timeoutSec ?? 900;

  const runId = await createRun("debate", opts.task, { cwd: opts.cwd });
  const start = Date.now();
  let proposal = "";
  let critique = "";
  let rounds = 0;
  let converged = false;
  let status: "done" | "failed" = "done";

  try {
    for (let round = 0; round < maxRounds; round++) {
      rounds = round + 1;

      // Propose / revise.
      const propPrompt = PROPOSE_PROMPT
        .replace("{{task}}", opts.task)
        .replace("{{critique}}", critique || "(none — this is the first proposal)");
      const prevProposal = proposal;
      const propResult = await runStage(registry, router, scheduler, policy, {
        agent: proposerName, prompt: propPrompt, opts, timeoutSec, role: "propose",
      });
      proposal = propResult.finalText;
      await recordCandidate(runId, round, propResult, opts.model, undefined);

      // Convergence: proposal stopped changing.
      if (prevProposal && similarity(prevProposal, proposal) >= convergence) {
        converged = true;
        opts.onRound?.(round, proposal, critique, true);
        break;
      }

      // Critique.
      const critPrompt = CRITIQUE_PROMPT
        .replace("{{task}}", opts.task)
        .replace("{{proposal}}", proposal);
      const critResult = await runStage(registry, router, scheduler, policy, {
        agent: criticName, prompt: critPrompt, opts, timeoutSec, role: "critique",
      });
      critique = critResult.finalText;
      await recordCandidate(runId, round, critResult, opts.model, undefined);

      opts.onRound?.(round, proposal, critique, false);

      // Early agreement: critique says it's sound (no substantive issues).
      if (/^(no |there are no |i have no |looks good|no further|solid|well done)/i.test(critique.trim().slice(0, 40))) {
        converged = true;
        break;
      }
    }

    // Final judge to score the converged proposal.
    let verdict: Verdict | undefined;
    try {
      const judgeAdapter = registry.require("claude");
      const res = await judgeCandidates(judgeAdapter, router, policy, opts.task,
        [{ result: { agent: proposerName as AgentName, exitCode: 0, finalText: proposal, events: [], durationMs: 0, timedOut: false } }],
        { cwd: opts.cwd, model: opts.model });
      verdict = res.verdict;
    } catch { /* judge is best-effort */ }

    await updateRun(runId, {
      status,
      winnerAgent: proposerName,
      winnerText: proposal.slice(0, 5000),
      iterations: rounds,
      meta: { converged, pattern: "debate" },
    });

    return { runId, proposal, critique, rounds, converged, verdict, totalDurationMs: Date.now() - start, status };
  } catch (e) {
    await updateRun(runId, { status: "failed", meta: { error: (e as Error).message } });
    return { runId, proposal, critique, rounds, converged, totalDurationMs: Date.now() - start, status: "failed" };
  }
}

async function runStage(
  registry: AdapterRegistry, router: ModelRouter, scheduler: Scheduler,
  policy: SafetyPolicy,
  p: { agent: AgentName; prompt: string; opts: DebateOptions; timeoutSec: number; role: string }
): Promise<RunResult> {
  const adapter = registry.require(p.agent);
  const req: RunRequest = {
    agent: p.agent, prompt: p.prompt, model: p.opts.model,
    posture: p.opts.posture, verbosity: "stream-json",
    cwd: p.opts.cwd, timeoutSec: p.timeoutSec, label: `debate:${p.role}`,
  };
  policy.validate(req);
  req.posture = policy.effectivePosture(req);
  const handle = scheduler.submit(adapter, router, req, (agent, evt) =>
    p.opts.onEvent?.(p.role, agent, evt));
  return handle.done;
}

function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const ta = new Set(a.toLowerCase().split(/\s+/));
  const tb = new Set(b.toLowerCase().split(/\s+/));
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

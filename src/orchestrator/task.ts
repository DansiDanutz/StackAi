/**
 * Stack Ai OS — TaskOrchestrator (6-phase lifecycle)
 *
 * Runs every task through 6 mandatory phases with agents handing off to each
 * other sequentially. Each agent's output becomes the next agent's input.
 *
 *   PHASE 1 PLANNING      → break the task into a concrete plan
 *   PHASE 2 ORCHESTRATING → assign roles (who plans/codes/reviews)
 *   PHASE 3 RUNNING       → implement, using the plan as input
 *   PHASE 4 TESTING       → review/critique the implementation
 *   PHASE 5 LOOPING       → if review found issues, re-run Phase 3 (cap-enforced)
 *   PHASE 6 DELIVERED     → final tested output + summary
 *
 * Composes existing primitives: the Scheduler (concurrency pool) runs each
 * phase's agent; prompt substitution ({{task}}/{{prior}}) carries context
 * forward — the same idiom as the pipeline pattern. judgeCandidates scores the
 * implementation in Phase 4. Emits TaskEvents at each transition so the
 * dashboard Conversation tab can render the handoff chain live.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { AgentName, AgentEvent, AgentAdapter, RunRequest, RunResult } from "../types.js";
import type { AdapterRegistry } from "../adapters/registry.js";
import type { ModelRouter } from "../types.js";
import type { Scheduler } from "../kernel/scheduler.js";
import type { SafetyPolicy } from "../safety/policy.js";
import { createRun, updateRun, recordCandidate } from "../kernel/store.js";
import { judgeCandidates, type Verdict } from "../patterns/judge.js";

export type Phase = "planning" | "orchestrating" | "running" | "testing" | "looping" | "delivered";

export const PHASES: Phase[] = ["planning", "orchestrating", "running", "testing", "looping", "delivered"];

export const PHASE_LABELS: Record<Phase, string> = {
  planning: "PLANNING",
  orchestrating: "ORCHESTRATING",
  running: "RUNNING",
  testing: "TESTING",
  looping: "LOOPING",
  delivered: "DELIVERED",
};

/** A single agent-to-agent message in the conversation. */
export interface TaskMessage {
  phase: Phase;
  fromAgent: AgentName;
  /** Who receives this output next (the handoff target). */
  toAgent?: AgentName;
  content: string;
  iteration?: number;
  ts: string;
}

/** Events the orchestrator emits for live display (dashboard Conversation tab). */
export type TaskEvent =
  | { kind: "phase"; phase: Phase; iteration?: number; ts: string }
  | { kind: "message"; message: TaskMessage }
  | { kind: "agent-switch"; phase: Phase; from: AgentName; to: AgentName; reason: string; ts: string }
  | { kind: "done"; result: TaskResult };

export interface TaskOrchestratorOptions {
  task: string;
  /** The team of agents. Order: [planner, orchestrator, coder, reviewer]. */
  agents?: AgentName[];
  model?: string;
  maxLoops?: number;      // Phase 5 cap. Default 2.
  timeoutSec?: number;    // per-phase. Default 600.
  cwd?: string;
  posture?: RunRequest["posture"];
  /** Path to write the delivered output to (closes the text→file gap). */
  out?: string;
  /** Extract a clean code block from the delivered text before writing. */
  extractCode?: boolean;
  onEvent?: (evt: TaskEvent) => void;
  /** Per-agent streaming events (for terminal live renderer). */
  onAgentEvent?: (phase: Phase, agent: AgentName, evt: AgentEvent) => void;
}

export interface TaskPhaseRecord {
  phase: Phase;
  agent: AgentName;
  output: string;
  durationMs: number;
  iteration?: number;
}

export interface TaskResult {
  runId: string;
  task: string;
  phases: TaskPhaseRecord[];
  conversation: TaskMessage[];
  finalOutput: string;
  /** Agent-reported failure reason when status is "failed". */
  error?: string;
  iterations: number;
  verdict?: Verdict;
  status: "delivered" | "failed";
  totalDurationMs: number;
}

export const PHASE_PROMPTS: Record<string, string> = {
  planning: `You are the PLANNER. Break this task into a concrete, numbered implementation plan. Be specific about files, functions, and approach. Do NOT write the full implementation — just the plan.\n\n=== TASK ===\n{{task}}`,
  orchestrating: `You are the ORCHESTRATOR. Given this task and plan, assign roles: specify which agent should implement, which should review, and the order of work. Keep it concise.\n\n=== TASK ===\n{{task}}\n\n=== PLAN ===\n{{prior}}`,
  running: `You are the CODER. Implement the task following the plan. Produce complete, working code. Use the prior context.\n\n=== TASK ===\n{{task}}\n\n=== PRIOR CONTEXT (plan + orchestration) ===\n{{prior}}`,
  testing: `You are the REVIEWER/Test engineer. Critically review this implementation against the task. Identify bugs, missing edge cases, and whether it would pass tests. End with a clear verdict line: "VERDICT: PASS" or "VERDICT: FAIL — <specific issues>".\n\n=== TASK ===\n{{task}}\n\n=== IMPLEMENTATION ===\n{{prior}}`,
};

export class TaskOrchestrator {
  private messages: TaskMessage[] = [];
  private phases: TaskPhaseRecord[] = [];
  /** Last agent-reported error, carried into the final delivery summary. */
  private lastError: string | undefined;
  /** The active scheduler handle — kept so cancel() can abort it. */
  private currentHandle: { cancel: () => void } | undefined;
  /** Whether this run was cancelled by the user. */
  private cancelled = false;

  constructor(
    private registry: AdapterRegistry,
    private router: ModelRouter,
    private scheduler: Scheduler,
    private policy: SafetyPolicy,
    private opts: TaskOrchestratorOptions
  ) {}

  async run(): Promise<TaskResult> {
    const { task, maxLoops = 2, timeoutSec = 600 } = this.opts;
    const start = Date.now();
    // Store registration is best-effort — the orchestrator must still run if
    // the store is unavailable (e.g. node:sqlite missing under vitest, or a
    // corrupted DB). A synthetic runId keeps everything working.
    let runId: string;
    try {
      runId = await createRun("task", task, { cwd: this.opts.cwd });
    } catch {
      runId = "taskrun-" + Date.now().toString(36);
    }

    // Resolve the team. Default: planner=codex, orchestrator=gemini, coder=codex, reviewer=codex
    const team = this.resolveTeam();
    let status: "delivered" | "failed" = "delivered";
    let verdict: Verdict | undefined;
    let iterations = 0;

    try {
      // ── Phase 1: PLANNING ──
      await this.enterPhase("planning");
      const plan = await this.runPhase("planning", team.planner, task, "", runId, 0);
      if (this.cancelled) { status = "failed"; this.lastError = "cancelled by user"; await this.finish(runId, status, iterations, start); return this.result(runId, status, iterations, verdict, start); }
      if (!plan) { status = "failed"; await this.finish(runId, status, iterations, start); return this.result(runId, status, iterations, verdict, start); }

      // ── Phase 2: ORCHESTRATING ──
      if (this.cancelled) { status = "failed"; this.lastError = "cancelled by user"; await this.finish(runId, status, iterations, start); return this.result(runId, status, iterations, verdict, start); }
      await this.enterPhase("orchestrating");
      const orchestration = await this.runPhase("orchestrating", team.orchestrator, task, plan, runId, 0);
      const priorForCoder = `PLAN:\n${plan}\n\nORCHESTRATION:\n${orchestration || "(use defaults)"}`;

      // ── Phases 3-5: RUNNING → TESTING → LOOPING (iterate) ──
      let implementation = "";
      let review = "";
      for (let iter = 0; iter <= maxLoops; iter++) {
        iterations = iter;
        // Phase 3: RUNNING
        await this.enterPhase("running", iter);
        implementation = await this.runPhase("running", team.coder, task, iter === 0 ? priorForCoder : `${priorForCoder}\n\nPRIOR IMPLEMENTATION:\n${implementation}\n\nREVIEW FEEDBACK TO ADDRESS:\n${review}`, runId, iter);
        if (!implementation) { status = "failed"; break; }

        // Phase 4: TESTING
        await this.enterPhase("testing", iter);
        review = await this.runPhase("testing", team.reviewer, task, implementation, runId, iter);

        // Score via the judge for a structured verdict.
        try {
          const judgeAdapter = this.registry.require(team.reviewer);
          const judgeRes = await judgeCandidates(judgeAdapter, this.router, this.policy, task,
            [{ result: { agent: team.coder, exitCode: 0, finalText: implementation, events: [], durationMs: 0, timedOut: false } }],
            { cwd: this.opts.cwd, model: this.opts.model });
          verdict = judgeRes.verdict;
        } catch { /* judge best-effort */ }

        // Did it pass?
        const passed = /VERDICT:\s*PASS/i.test(review) || (verdict?.action === "accept");
        if (passed || iter === maxLoops) {
          // Either passed, or we hit the loop cap — deliver.
          if (!passed && iter === maxLoops) {
            // Final loop attempt didn't pass — note it but still deliver best effort.
            await this.enterPhase("looping", iter);
          }
          break;
        }

        // Phase 5: LOOPING — review found issues, loop back to RUNNING.
        await this.enterPhase("looping", iter);
        // loop continues: next iteration re-enters RUNNING with the review feedback.
      }

      // ── Phase 6: DELIVERED ──
      await this.enterPhase("delivered");
      // Record the final delivery as a message from the coder to the user.
      this.recordMessage("delivered", team.coder, undefined, implementation, iterations);

      // On failure, append the captured agent error to the delivered message so
      // the user sees *why* it failed in the Conversation tab + Runs table.
      try { await updateRun(runId, { status: status === "delivered" ? "done" : "failed", winnerAgent: team.coder, winnerText: implementation.slice(0, 5000), iterations, meta: { pattern: "task", phases: this.phases.map((p) => ({ phase: p.phase, agent: p.agent, durationMs: p.durationMs })), verdictAction: verdict?.action, loopCount: iterations, error: status === "failed" ? this.lastError : undefined } }); } catch { /* best-effort */ }

      return this.result(runId, status, iterations, verdict, start);
    } catch (e) {
      const msg = (e as Error).message;
      try { await updateRun(runId, { status: "failed", meta: { error: msg } }); } catch { /* best-effort */ }
      this.recordMessage("delivered", this.resolveTeam().planner, undefined, `[task failed: ${msg}]`, iterations);
      this.lastError = msg;
      return this.result(runId, "failed", iterations, verdict, start);
    }
  }

  /**
   * Run one phase's agent, capturing its output as a conversation message.
   *
   * Adaptive fallback: the orchestrator always has the last word. If the
   * primary agent produces no text or errors (empty output, 401, crash), we
   * walk down the rest of the enabled fleet until an agent delivers real
   * output. Each switch is broadcast so the user sees recovery happening live.
   * Only when every agent fails do we give up — and even then the error reason
   * is surfaced, never silently swallowed.
   */
  private async runPhase(
    phase: Phase, agent: AgentName, task: string, prior: string, runId: string, iteration: number
  ): Promise<string> {
    const promptTemplate = PHASE_PROMPTS[phase] ?? "{{task}}";
    const prompt = promptTemplate.replace(/\{\{task\}\}/g, task).replace(/\{\{prior\}\}/g, prior);
    const phaseStart = Date.now();

    // Build the fallback chain: primary agent first, then the rest of the
    // enabled fleet (excluding the primary + already-tried). We skip cloud-only
    // adapters like fugu unless it's the only option.
    const chain = this.fallbackChain(agent);

    let finalAgent = agent;
    let result: RunResult | undefined;
    let lastError: string | undefined;
    let prevAgent: AgentName | undefined;

    for (const candidate of chain) {
      // If we've moved past the primary agent, tell the user we're switching.
      if (prevAgent) {
        const reason = (lastError ?? "no output").slice(0, 120);
        this.opts.onEvent?.({ kind: "agent-switch", phase, from: prevAgent, to: candidate, reason, ts: new Date().toISOString() });
        this.recordMessage(phase, prevAgent, candidate, `[switch] ${prevAgent} failed (${reason}) → trying ${candidate}`, iteration);
      }
      const adapter = this.registry.require(candidate);
      const req: RunRequest = {
        agent: candidate, prompt, model: this.opts.model,
        posture: this.opts.posture, verbosity: "stream-json",
        cwd: this.opts.cwd, timeoutSec: this.opts.timeoutSec ?? 600,
        label: `task:${phase}`,
      };
      // Retry a transient failure (auth blip) once before moving on.
      result = await this.tryOnce(adapter, req, phase);
      if (result.exitCode !== 0 && !result.finalText && !result.error) {
        await new Promise((r) => setTimeout(r, 1200));
        result = await this.tryOnce(adapter, req, phase);
      }

      // Did this agent deliver usable output?
      // Reject text that's actually an error message (auth failure, crash) —
      // claude exits 0 with the error string as its text, so we can't rely on
      // result.error alone. Detect known error patterns and fall through.
      const text = result.finalText || "";
      const looksLikeError = !text.trim() ||
        /failed to authenticate|api error: \d{3}|401 unauthorized|connection (was )?closed|invalid api key|not authorized/i.test(text);
      if (text.trim() && !looksLikeError) {
        finalAgent = candidate;
        break;
      }
      // No usable output — record the error and try the next agent.
      const reason = result.error || (looksLikeError ? text.slice(0, 80) : "produced no output");
      lastError = reason;
      if (reason) this.recordMessage(phase, candidate, undefined, `[error] ${candidate}: ${reason}`, iteration);
      prevAgent = candidate;
    }

    const output = result?.finalText || (lastError ? `[error] ${lastError}` : "");
    const hasError = !output || output.startsWith("[error]");
    this.phases.push({ phase, agent: finalAgent, output, durationMs: Date.now() - phaseStart, iteration });

    try { if (result) await recordCandidate(runId, iteration, result, this.opts.model, undefined); } catch { /* best-effort */ }

    const nextAgent = this.nextAgentFor(phase);
    this.recordMessage(phase, finalAgent, nextAgent, output, iteration);
    if (hasError) this.lastError = lastError;
    return output;
  }

  /** Cancel the run — aborts the current agent and stops the orchestrator. */
  cancel(): void {
    this.cancelled = true;
    this.currentHandle?.cancel();
    this.opts.onEvent?.({ kind: "message", message: { phase: "delivered", fromAgent: "orchestrator", content: "[cancelled] Task cancelled by user", ts: new Date().toISOString() } });
  }

  /** Submit one attempt; return the RunResult. Tracks the handle for cancellation. */
  private async tryOnce(adapter: AgentAdapter, req: RunRequest, phase: Phase): Promise<RunResult> {
    const h = this.scheduler.submit(adapter, this.router, req, (a, evt) =>
      this.opts.onAgentEvent?.(phase, a, evt));
    this.currentHandle = h;
    return h.done;
  }

  /**
   * Build the agent fallback chain for a phase: the primary agent first, then
   * every other enabled agent in fleet order. Used so the orchestrator can
   * recover by handing off to a different agent when the primary fails.
   */
  private fallbackChain(primary: AgentName): AgentName[] {
    const chain: AgentName[] = [primary];
    for (const a of this.registry.enabled()) {
      if (a.name !== primary) chain.push(a.name);
    }
    return chain;
  }

  /** Emit a phase-transition event. */
  private async enterPhase(phase: Phase, iteration?: number): Promise<void> {
    const evt: TaskEvent = { kind: "phase", phase, iteration, ts: new Date().toISOString() };
    this.opts.onEvent?.(evt);
  }

  /** Record a conversation message + emit it. */
  private recordMessage(phase: Phase, fromAgent: AgentName, toAgent: AgentName | undefined, content: string, iteration?: number): void {
    const msg: TaskMessage = { phase, fromAgent, toAgent, content, iteration, ts: new Date().toISOString() };
    this.messages.push(msg);
    this.opts.onEvent?.({ kind: "message", message: msg });
  }

  /** Which agent runs the next phase (for the handoff indicator). */
  private nextAgentFor(phase: Phase): AgentName | undefined {
    const team = this.resolveTeam();
    const map: Partial<Record<Phase, AgentName>> = {
      planning: team.orchestrator,
      orchestrating: team.coder,
      running: team.reviewer,
      testing: team.coder, // loops back to coder if review fails
    };
    return map[phase];
  }

  /** Resolve the 4-role team from opts.agents or defaults. */
  private resolveTeam(): { planner: AgentName; orchestrator: AgentName; coder: AgentName; reviewer: AgentName } {
    const a = this.opts.agents ?? [];
    return {
      planner: a[0] ?? "codex",
      orchestrator: a[1] ?? "gemini",
      coder: a[2] ?? a[0] ?? "codex",
      reviewer: a[3] ?? a[0] ?? "codex",
    };
  }

  private async finish(runId: string, status: "delivered" | "failed", iterations: number, start: number): Promise<void> {
    await updateRun(runId, { status: status === "delivered" ? "done" : "failed", iterations });
  }

  private result(runId: string, status: "delivered" | "failed", iterations: number, verdict: Verdict | undefined, start: number): TaskResult {
    const finalOutput = this.phases.filter((p) => p.phase === "running").pop()?.output ?? "";

    // If --out was requested, write the delivered output to disk (closes the
    // text→file gap: agents produced code, now it lands in a real file).
    if (this.opts.out && status === "delivered") {
      try {
        const content = this.opts.extractCode !== false
          ? extractCodeBlock(finalOutput) ?? finalOutput
          : finalOutput;
        const outPath = resolve(this.opts.cwd ?? process.cwd(), this.opts.out);
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, content, "utf8");
        // Record the file write as a final conversation message.
        this.recordMessage("delivered", this.resolveTeam().coder, undefined, `[written to ${outPath}]`, iterations);
      } catch (e) {
        // Surface the write error but don't fail the task.
        this.recordMessage("delivered", this.resolveTeam().coder, undefined, `[file write failed: ${(e as Error).message}]`, iterations);
      }
    }

    const result: TaskResult = {
      runId, task: this.opts.task, phases: this.phases, conversation: this.messages,
      finalOutput, error: status === "failed" ? this.lastError : undefined,
      iterations, verdict, status, totalDurationMs: Date.now() - start,
    };
    this.opts.onEvent?.({ kind: "done", result });
    return result;
  }
}

/**
 * Extract the content of a fenced code block from agent output. Handles
 * ```lang\n...\n``` and indented variants. Returns null if no block found.
 */
export function extractCodeBlock(text: string): string | null {
  // Prefer the longest fenced block (agents often wrap the solution in ```).
  const matches = [...text.matchAll(/```(?:[a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g)];
  if (matches.length === 0) return null;
  // Return the longest match — that's most likely the actual solution.
  const longest = matches.reduce((a, b) => (b[1]!.length > a[1]!.length ? b : a));
  return longest[1]!.trim();
}

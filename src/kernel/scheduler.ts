/**
 * Stack Ai OS — Scheduler (concurrency pool)
 *
 * Limits how many agent runs execute in parallel. An ensemble of 4 heavy
 * coding agents would otherwise peg the Mac Studio; the scheduler queues
 * RunRequests and runs them through a bounded worker pool.
 *
 * Each scheduled job returns a promise that resolves to its result; callers
 * also get an async iterator for live events via the job handle.
 */
import type { AgentName, AgentEvent, RunRequest, RunResult } from "../types.js";
import type { AgentAdapter, ModelRouter } from "../types.js";
import type { SafetyPolicy } from "../safety/policy.js";

export interface ScheduleOptions {
  /** Max concurrent runs across the whole kernel. Default 3. */
  concurrency?: number;
}

interface Job {
  adapter: AgentAdapter;
  req: RunRequest;
  router: ModelRouter;
  resolve: (r: RunResult) => void;
  reject: (e: Error) => void;
  onEvent?: (agent: AgentName, evt: AgentEvent) => void;
}

export interface JobHandle {
  /** Promise resolving to the final result. */
  done: Promise<RunResult>;
  /** Cancel the run (SIGTERM then SIGKILL). Best-effort. */
  cancel: () => void;
}

export class Scheduler {
  private queue: Job[] = [];
  private active = 0;
  private readonly concurrency: number;
  private policy: SafetyPolicy;
  /** Active child controllers, keyed by job, for cancellation. */
  private cancelled = new WeakMap<Job, boolean>();

  constructor(policy: SafetyPolicy, opts?: ScheduleOptions) {
    this.policy = policy;
    this.concurrency = opts?.concurrency ?? 3;
  }

  setPolicy(p: SafetyPolicy) { this.policy = p; }

  /** Enqueue a run. Returns a handle with the result promise + cancel(). */
  submit(
    adapter: AgentAdapter,
    router: ModelRouter,
    req: RunRequest,
    onEvent?: (agent: AgentName, evt: AgentEvent) => void
  ): JobHandle {
    let resolve!: (r: RunResult) => void;
    let reject!: (e: Error) => void;
    const done = new Promise<RunResult>((res, rej) => { resolve = res; reject = rej; });
    const job: Job = { adapter, req, router, resolve, reject, onEvent };
    this.queue.push(job);
    this.pump();
    return {
      done,
      cancel: () => { this.cancelled.set(job, true); },
    };
  }

  private pump() {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.active++;
      void this.runJob(job);
    }
  }

  private async runJob(job: Job) {
    const start = Date.now();
    const events: AgentEvent[] = [];
    try {
      // Validate + resolve posture.
      this.policy.validate(job.req);
      job.req.posture = this.policy.effectivePosture(job.req);

      const iter = job.adapter.run(job.req, job.router);
      let exitCode = 0, finalText = "", sessionId: string | undefined, costUsd: number | undefined, timedOut = false;

      for await (const evt of iter) {
        if (this.cancelled.get(job)) { timedOut = true; break; }
        events.push(evt);
        job.onEvent?.(job.req.agent, evt);
        // Accumulate assistant text as it streams (some CLIs' done event has
        // empty finalText — the content arrives via assistant text events).
        if (evt.type === "assistant" && evt.subtype === "text") finalText += evt.text;
        if (evt.type === "done") {
          exitCode = evt.exitCode;
          // done.finalText may be empty even when text was streamed — only
          // overwrite if the done event actually carries text.
          if (evt.finalText) finalText = evt.finalText;
          sessionId = evt.sessionId;
          if (exitCode === 124) timedOut = true;
        }
        if (evt.type === "cost" && evt.costUsd != null) costUsd = (costUsd ?? 0) + evt.costUsd;
      }

      job.resolve({
        agent: job.req.agent, exitCode, finalText, sessionId, events,
        durationMs: Date.now() - start, costUsd, timedOut,
      });
    } catch (e) {
      job.reject(e as Error);
    } finally {
      this.active--;
      this.pump();
    }
  }
}

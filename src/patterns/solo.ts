/**
 * Stack Ai OS — Solo pattern
 *
 * Runs a single agent on a prompt and returns the final result. The simplest
 * pattern; also the building block ensemble/judge/pipeline compose from.
 */
import type { AgentEvent, AgentName, RunRequest, RunResult } from "../types.js";
import type { AgentAdapter } from "../types.js";
import type { ModelRouter } from "../types.js";
import type { SafetyPolicy } from "../safety/policy.js";

export interface SoloOptions {
  agent: AgentName;
  prompt: string;
  model?: string;
  posture?: RunRequest["posture"];
  verbosity?: RunRequest["verbosity"];
  cwd?: string;
  timeoutSec?: number;
  /** Previous session id to resume (for agents with sessionResume capability). */
  sessionId?: string;
  /** Optional event sink (TUI/web subscribe here for live updates). */
  onEvent?: (agent: AgentName, evt: AgentEvent) => void;
}

/** Run one agent to completion, collecting events into a RunResult. */
export async function runSolo(
  adapter: AgentAdapter,
  router: ModelRouter,
  opts: SoloOptions,
  policy: SafetyPolicy
): Promise<RunResult> {
  const req: RunRequest = {
    agent: opts.agent,
    prompt: opts.prompt,
    model: opts.model,
    posture: opts.posture,
    verbosity: opts.verbosity ?? "stream-json",
    cwd: opts.cwd,
    timeoutSec: opts.timeoutSec ?? 600,
    sessionId: opts.sessionId,
  };

  policy.validate(req); // throws on guardrail violation
  const effectivePosture = policy.effectivePosture(req);
  req.posture = effectivePosture;

  const start = Date.now();
  const events: AgentEvent[] = [];
  let exitCode = 0;
  let finalText = "";
  let sessionId: string | undefined;
  let costUsd: number | undefined;
  let timedOut = false;

  for await (const evt of adapter.run(req, router)) {
    events.push(evt);
    opts.onEvent?.(opts.agent, evt);
    if (evt.type === "done") {
      exitCode = evt.exitCode;
      finalText = evt.finalText;
      sessionId = evt.sessionId;
      if (exitCode === 124) timedOut = true;
    }
    if (evt.type === "cost" && evt.costUsd != null) {
      costUsd = (costUsd ?? 0) + evt.costUsd;
    }
  }

  return {
    agent: opts.agent,
    exitCode,
    finalText,
    sessionId,
    events,
    durationMs: Date.now() - start,
    costUsd,
    timedOut,
  };
}

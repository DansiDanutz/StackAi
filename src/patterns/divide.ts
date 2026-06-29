/**
 * Stack Ai OS — Divide-and-conquer pattern
 *
 * A coordinator agent decomposes the task into independent subtasks (a flat
 * list — a true dependency DAG is planned but the flat fan-out covers most real
 * cases). Each subtask runs in parallel via the scheduler; a merger agent
 * combines the partial results into one final output.
 *
 * Flow: decompose(task) → [subtask1, subtask2, …] → fanOut(parallel) → merge
 *
 * Inspired by Open Multi-Agent's goal→DAG decomposition (see RESEARCH.md); we
 * implement a flat decomposition now (no cross-subtask dependencies) which is
 * simpler and sufficient for most coding tasks.
 */
import type { AgentName, AgentEvent, RunRequest, RunResult } from "../types.js";
import type { AdapterRegistry } from "../adapters/registry.js";
import type { ModelRouter } from "../types.js";
import type { Scheduler } from "../kernel/scheduler.js";
import type { SafetyPolicy } from "../safety/policy.js";
import { createRun, updateRun, recordCandidate } from "../kernel/store.js";

export interface DivideOptions {
  task: string;
  /** Decomposer agent (plans the split). Default claude. */
  decomposer?: AgentName;
  /** Worker agents that execute subtasks (round-robin). Default [claude, codex, gemini]. */
  workers?: AgentName[];
  /** Merger agent (combines partial results). Default claude. */
  merger?: AgentName;
  model?: string;
  /** Max subtasks to allow (safety cap). Default 6. */
  maxSubtasks?: number;
  timeoutSec?: number;
  cwd?: string;
  posture?: RunRequest["posture"];
  onEvent?: (phase: string, agent: AgentName, evt: AgentEvent) => void;
  onPhase?: (phase: string, detail: string) => void;
}

export interface DivideResult {
  runId: string;
  subtasks: string[];
  partialResults: { subtask: string; agent: AgentName; output: string }[];
  mergedOutput: string;
  totalDurationMs: number;
  status: "done" | "failed";
}

const DECOMPOSE_PROMPT = `Decompose this task into ${"{{n}}"} or fewer INDEPENDENT subtasks that can be solved in parallel. Each subtask should be self-contained.

Return ONLY a JSON array of strings, each a subtask description. No prose. Example: ["implement the auth function", "write tests for the auth function"]

=== TASK ===
{{task}}`;

const MERGE_PROMPT = `Merge these partial solutions into one coherent, complete result. Resolve any conflicts and remove duplication. Produce the final unified output.

=== TASK ===
{{task}}

=== PARTIAL SOLUTIONS ===
{{partials}}`;

export async function runDivideConquer(
  registry: AdapterRegistry,
  router: ModelRouter,
  scheduler: Scheduler,
  policy: SafetyPolicy,
  opts: DivideOptions
): Promise<DivideResult> {
  const decomposerName = opts.decomposer ?? "claude";
  const workers = opts.workers ?? ["claude", "codex", "gemini"];
  const mergerName = opts.merger ?? "claude";
  const maxSubtasks = opts.maxSubtasks ?? 6;
  const timeoutSec = opts.timeoutSec ?? 900;

  const runId = await createRun("divide-conquer", opts.task, { cwd: opts.cwd });
  const start = Date.now();
  let status: "done" | "failed" = "done";

  try {
    // 1. Decompose.
    const decomposer = registry.require(decomposerName);
    const decomposePrompt = DECOMPOSE_PROMPT
      .replace("{{n}}", String(maxSubtasks))
      .replace("{{task}}", opts.task);
    const decomposeReq: RunRequest = {
      agent: decomposerName, prompt: decomposePrompt, model: opts.model,
      posture: opts.posture, verbosity: "text", cwd: opts.cwd, timeoutSec,
      label: "divide:decompose",
    };
    policy.validate(decomposeReq);
    decomposeReq.posture = policy.effectivePosture(decomposeReq);
    const decomposeHandle = scheduler.submit(decomposer, router, decomposeReq,
      (agent, evt) => opts.onEvent?.("decompose", agent, evt));
    const decomposeResult = await decomposeHandle.done;
    await recordCandidate(runId, 0, decomposeResult, opts.model, undefined);

    const subtasks = parseSubtasks(decomposeResult.finalText, maxSubtasks);
    opts.onPhase?.("decompose", `${subtasks.length} subtasks`);
    if (!subtasks.length) {
      // Fallback: treat the whole task as one subtask.
      subtasks.push(opts.task);
    }

    // 2. Fan out subtasks to workers (round-robin assignment).
    const partialResults: DivideResult["partialResults"] = [];
    const handles = subtasks.map((subtask, i) => {
      const workerName = workers[i % workers.length]!;
      const adapter = registry.require(workerName);
      const req: RunRequest = {
        agent: workerName, prompt: subtask, model: opts.model,
        posture: opts.posture, verbosity: "stream-json",
        cwd: opts.cwd, timeoutSec, label: `divide:worker-${i}`,
      };
      return {
        workerName,
        subtask,
        handle: scheduler.submit(adapter, router, req, (agent, evt) =>
          opts.onEvent?.(`worker-${i}`, agent, evt)),
      };
    });

    const settled = await Promise.allSettled(handles.map((h) => h.handle.done));
    for (let i = 0; i < settled.length; i++) {
      const s = settled[i];
      const h = handles[i]!;
      if (s && s.status === "fulfilled") {
        partialResults.push({ subtask: h.subtask, agent: h.workerName, output: s.value.finalText });
        await recordCandidate(runId, i + 1, s.value, opts.model, undefined);
      }
    }
    opts.onPhase?.("fanout", `${partialResults.length}/${subtasks.length} done`);

    // 3. Merge.
    const merger = registry.require(mergerName);
    const partialsBlock = partialResults
      .map((p, i) => `=== Partial ${i + 1} (${p.agent}) — ${p.subtask} ===\n${p.output}`)
      .join("\n\n");
    const mergePrompt = MERGE_PROMPT
      .replace("{{task}}", opts.task)
      .replace("{{partials}}", partialsBlock);
    const mergeReq: RunRequest = {
      agent: mergerName, prompt: mergePrompt, model: opts.model,
      posture: opts.posture, verbosity: "stream-json",
      cwd: opts.cwd, timeoutSec, label: "divide:merge",
    };
    const mergeHandle = scheduler.submit(merger, router, mergeReq,
      (agent, evt) => opts.onEvent?.("merge", agent, evt));
    const mergeResult = await mergeHandle.done;
    await recordCandidate(runId, subtasks.length + 1, mergeResult, opts.model, undefined);

    opts.onPhase?.("merge", "complete");
    await updateRun(runId, {
      status, winnerAgent: mergerName,
      winnerText: mergeResult.finalText.slice(0, 5000),
      iterations: subtasks.length, meta: { pattern: "divide-conquer", subtaskCount: subtasks.length },
    });

    return {
      runId, subtasks, partialResults,
      mergedOutput: mergeResult.finalText,
      totalDurationMs: Date.now() - start, status,
    };
  } catch (e) {
    await updateRun(runId, { status: "failed", meta: { error: (e as Error).message } });
    return { runId, subtasks: [], partialResults: [], mergedOutput: "", totalDurationMs: Date.now() - start, status: "failed" };
  }
}

/** Parse the decomposer's JSON array of subtasks, defensively. */
export function parseSubtasks(text: string, max: number): string[] {
  // Extract the first JSON array.
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const arr = JSON.parse(match[0]);
    if (!Array.isArray(arr)) return [];
    return arr
      .map((s) => String(s).trim())
      .filter((s) => s.length > 0)
      .slice(0, max);
  } catch {
    return [];
  }
}

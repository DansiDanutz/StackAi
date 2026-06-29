/**
 * Stack Ai OS — Pipeline pattern
 *
 * Sequential handoff: a task flows through named stages, each stage's output
 * becomes the next stage's input. Default stages: plan → code → review → fix.
 * Each stage can use a different agent/model — e.g. opus plans, codex codes,
 * a different agent reviews, the coder fixes per review.
 *
 * Unlike ensemble (parallel + judge), pipeline is strictly sequential: each
 * step depends on the prior step's output. Best for tasks with a natural
 * plan→implement→verify structure.
 */
import type { AgentName, AgentEvent, RunRequest, RunResult } from "../types.js";
import type { AdapterRegistry } from "../adapters/registry.js";
import type { ModelRouter } from "../types.js";
import type { Scheduler } from "../kernel/scheduler.js";
import type { SafetyPolicy } from "../safety/policy.js";
import { createRun, updateRun, recordCandidate } from "../kernel/store.js";

export interface PipelineStage {
  name: string;          // "plan" | "code" | "review" | "fix" | custom
  agent: AgentName;
  model?: string;
  /** Prompt template; {{task}} and {{prior}} are substituted. */
  prompt: string;
}

export interface PipelineOptions {
  task: string;
  /** Ordered stages. Defaults to plan→code→review→fix. */
  stages?: PipelineStage[];
  /** Convenience: agents for the default 4-stage pipeline. */
  agents?: AgentName[];
  model?: string;
  timeoutSec?: number;
  cwd?: string;
  posture?: RunRequest["posture"];
  onEvent?: (stage: string, agent: AgentName, evt: AgentEvent) => void;
  onStage?: (stage: string, output: string) => void;
}

export interface PipelineResult {
  runId: string;
  stages: { name: string; agent: AgentName; output: string; durationMs: number }[];
  finalOutput: string;
  totalDurationMs: number;
  status: "done" | "failed";
}

const DEFAULT_STAGE_PROMPTS: Record<string, string> = {
  plan: `Break down this task into concrete implementation steps. Be specific about files, functions, and approach. Do NOT write the full implementation yet — just the plan.\n\n=== TASK ===\n{{task}}`,
  code: `Implement the following plan. Write complete, working code.\n\n=== TASK ===\n{{task}}\n\n=== PLAN ===\n{{prior}}`,
  review: `Review this implementation against the task. Identify bugs, missing edge cases, and improvements. Be specific and critical.\n\n=== TASK ===\n{{task}}\n\n=== IMPLEMENTATION ===\n{{prior}}`,
  fix: `Fix the issues found in review. Produce the corrected, complete solution.\n\n=== TASK ===\n{{task}}\n\n=== REVIEW (issues to fix) ===\n{{prior}}`,
};

/** Run a sequential pipeline. */
export async function runPipeline(
  registry: AdapterRegistry,
  router: ModelRouter,
  scheduler: Scheduler,
  policy: SafetyPolicy,
  opts: PipelineOptions
): Promise<PipelineResult> {
  const stages = opts.stages ?? defaultStages(opts);
  const timeoutSec = opts.timeoutSec ?? 1200;
  const runId = await createRun("pipeline", opts.task, { cwd: opts.cwd });

  const results: PipelineResult["stages"] = [];
  let priorOutput = "";
  const start = Date.now();
  let status: "done" | "failed" = "done";

  try {
    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i]!;
      const adapter = registry.require(stage.agent);

      const prompt = stage.prompt
        .replace(/\{\{task\}\}/g, opts.task)
        .replace(/\{\{prior\}\}/g, priorOutput);

      const req: RunRequest = {
        agent: stage.agent,
        prompt,
        model: stage.model ?? opts.model,
        posture: opts.posture,
        verbosity: "stream-json",
        cwd: opts.cwd,
        timeoutSec,
        label: `pipeline:${stage.name}`,
      };

      const stageStart = Date.now();
      const handle = scheduler.submit(adapter, router, req, (agent, evt) =>
        opts.onEvent?.(stage.name, agent, evt)
      );
      const result: RunResult = await handle.done;

      priorOutput = result.finalText;
      results.push({
        name: stage.name,
        agent: stage.agent,
        output: result.finalText,
        durationMs: Date.now() - stageStart,
      });

      await recordCandidate(runId, i, result, stage.model, undefined);
      opts.onStage?.(stage.name, result.finalText);

      if (result.exitCode !== 0 && !result.finalText) {
        status = "failed";
        break;
      }
    }

    await updateRun(runId, {
      status,
      winnerAgent: results[results.length - 1]?.agent,
      winnerText: priorOutput.slice(0, 5000),
      iterations: results.length,
    });

    return {
      runId,
      stages: results,
      finalOutput: priorOutput,
      totalDurationMs: Date.now() - start,
      status,
    };
  } catch (e) {
    await updateRun(runId, { status: "failed", meta: { error: (e as Error).message } });
    return {
      runId,
      stages: results,
      finalOutput: priorOutput,
      totalDurationMs: Date.now() - start,
      status: "failed",
    };
  }
}

function defaultStages(opts: PipelineOptions): PipelineStage[] {
  const agents = opts.agents ?? ["claude", "codex", "claude", "codex"];
  const names = ["plan", "code", "review", "fix"];
  return names.map((name, i) => ({
    name,
    agent: (agents[i] ?? "claude") as AgentName,
    model: opts.model,
    prompt: DEFAULT_STAGE_PROMPTS[name] ?? "{{task}}",
  }));
}

export { DEFAULT_STAGE_PROMPTS };

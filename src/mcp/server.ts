/**
 * Stack Ai OS — MCP server (OS exposes its own tools to CLIs)
 *
 * The "OS as MCP server" half of the two-way bus. Runs over stdio (JSON-RPC 2.0,
 * the MCP wire protocol) so any MCP-capable CLI connects via:
 *
 *   claude/codex/kimi/openclaude/hermes --mcp-config stack-ai-os.json
 *
 * where the config points at `stackai mcp serve`. The CLI then gains tools:
 *
 *   sao.recall        — query claude-mem + openclaw + graphify for context
 *   sao.ensemble      — fan out N CLIs on a task and return the judged winner
 *   sao.judge         — rank a set of candidate texts by a rubric
 *   sao.run_status    — get a run's status + winner from the store
 *   sao.list_runs     — recent run history
 *   sao.fugu_judge    — cloud meta-judge (if SAKANA_API_KEY set)
 *
 * This is the loop-completing piece: a CLI agent, mid-task, can ask the OS to
 * spawn an ensemble for a second opinion — agents orchestrating agents.
 */
import { createInterface } from "node:readline";
import { loadConfig } from "../config.js";
import { createRegistry } from "../adapters/registry.js";
import { ModelRouterImpl } from "../models/router.js";
import { defaultPolicy } from "../safety/policy.js";
import { recallAll, formatContext } from "../memory/recall.js";
import * as store from "../kernel/store.js";

const PROTOCOL_VERSION = "2024-11-05";

const TOOLS = [
  {
    name: "sao.recall",
    description: "Recall relevant context from Stack Ai OS memory (claude-mem, openclaw, graphify). Use before tackling a task to prime yourself with prior knowledge.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to recall" },
        codeTarget: { type: "string", description: "Optional file/symbol for graphify context" },
      },
      required: ["query"],
    },
  },
  {
    name: "sao.judge",
    description: "Rank candidate solution texts against a task using a judge agent (claude/opus by default). Returns scores, ranking, and the winner text.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "The original task" },
        candidates: { type: "array", items: { type: "string" }, description: "Candidate solutions to rank" },
        judge: { type: "string", enum: ["claude", "fugu"], description: "Judge agent (default claude)" },
      },
      required: ["task", "candidates"],
    },
  },
  {
    name: "sao.ensemble",
    description: "Fan out N coding CLIs on a task in parallel and return the judged winner. Use for a high-quality second opinion on a hard subproblem. Costs budget; use judiciously.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "The task to solve" },
        agents: { type: "array", items: { type: "string" }, description: "Agent names (default claude/codex/gemini)" },
        judge: { type: "string", description: "Judge agent (default claude; fugu for cloud)" },
        budgetUsd: { type: "number", description: "Max spend (default 0.50)" },
      },
      required: ["task"],
    },
  },
  {
    name: "sao.run_status",
    description: "Get the status, winner, and scores of a Stack Ai OS run by id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "sao.list_runs",
    description: "List recent Stack Ai OS runs (history).",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "How many (default 10)" } },
    },
  },
];

/** Start the MCP server over stdio. */
export function startMcpServer(): void {
  const rl = createInterface({ input: process.stdin });
  const send = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");

  rl.on("line", (line) => {
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; }
    handle(msg, send).catch((e) => {
      if (msg.id !== undefined) {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: (e as Error).message } });
      }
    });
  });
}

async function handle(msg: any, send: (o: unknown) => void): Promise<void> {
  const { id, method, params } = msg;

  // Notifications (no id) — ignore except initialized.
  if (id === undefined && method === "notifications/initialized") return;
  if (id === undefined) return;

  switch (method) {
    case "initialize":
      send({
        jsonrpc: "2.0", id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          serverInfo: { name: "stack-ai-os", version: "0.1.0" },
          capabilities: { tools: {} },
        },
      });
      return;

    case "tools/list":
      send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      return;

    case "tools/call": {
      const toolName = params?.name;
      const args = params?.arguments ?? {};
      const result = await dispatchTool(toolName, args);
      send({
        jsonrpc: "2.0", id,
        result: {
          content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }],
        },
      });
      return;
    }

    case "ping":
      send({ jsonrpc: "2.0", id, result: {} });
      return;

    default:
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

/** Route a tool call to its implementation. Returns text or JSON. */
async function dispatchTool(name: string, args: any): Promise<unknown> {
  switch (name) {
    case "sao.recall": {
      const results = recallAll(args.query, { codeTarget: args.codeTarget });
      return formatContext(results) || "(no recall results — backends may be offline)";
    }
    case "sao.judge": {
      const { judgeCandidates } = await import("../patterns/judge.js");
      const cfg = loadConfig();
      const registry = createRegistry(cfg);
      const router = new ModelRouterImpl(cfg.models);
      const policy = defaultPolicy();
      const judgeAgent = args.judge === "fugu" ? "fugu" : "claude";
      const adapter = registry.get(judgeAgent as any);
      if (!adapter) return { error: `judge agent '${judgeAgent}' not available` };
      const candidates = (args.candidates as string[]).map((text) => ({
        result: { agent: "input" as any, exitCode: 0, finalText: text, events: [], durationMs: 0, timedOut: false },
      }));
      const { verdict } = await judgeCandidates(adapter, router, policy, args.task, candidates);
      return {
        scores: verdict.scores, ranking: verdict.ranking, winner: verdict.winner,
        action: verdict.action, notes: verdict.notes,
        winnerText: candidates[verdict.ranking[0] ? "ABCDEFGH".indexOf(verdict.ranking[0]) : 0]?.result.finalText,
      };
    }
    case "sao.ensemble": {
      const { Scheduler } = await import("../kernel/scheduler.js");
      const { runEnsemble } = await import("../patterns/ensemble.js");
      const cfg = loadConfig();
      const registry = createRegistry(cfg);
      const router = new ModelRouterImpl(cfg.models);
      const policy = defaultPolicy();
      const scheduler = new Scheduler(policy, { concurrency: 3 });
      const result = await runEnsemble(registry, router, scheduler, policy, {
        task: args.task,
        agents: args.agents ?? ["claude", "codex", "gemini"],
        judgeAgent: args.judge ?? "claude",
        budgetUsd: args.budgetUsd ?? 0.5,
        maxIterations: 1,
        timeoutSec: 600,
      });
      return {
        runId: result.runId,
        winner: result.winner?.result.agent,
        winnerText: result.winner?.result.finalText.slice(0, 4000),
        stoppedReason: result.stoppedReason,
        spentUsd: result.spentUsd,
        scores: result.verdict?.scores,
      };
    }
    case "sao.run_status": {
      const run = await store.getRun(args.id);
      if (!run) return { error: "run not found" };
      const candidates = await store.listCandidates(args.id);
      return { run, candidates };
    }
    case "sao.list_runs": {
      return { runs: await store.listRuns(args.limit ?? 10) };
    }
    default:
      return { error: `unknown tool: ${name}` };
  }
}

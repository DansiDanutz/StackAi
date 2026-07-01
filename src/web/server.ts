/**
 * Stack Ai OS — Web dashboard server
 *
 * Zero-extra-dependency HTTP + WebSocket server (pure node:http). Serves:
 *   GET  /                  → dashboard SPA (single-file HTML)
 *   GET  /api/health        → { ok, version }
 *   GET  /api/fleet         → adapters + capabilities
 *   GET  /api/models        → model aliases
 *   GET  /api/runs          → recent runs from the store
 *   GET  /api/runs/:id      → run detail + candidates
 *   POST /api/upload        → save a drag-drop attachment, returns its path
 *   POST /api/task          → start a 6-phase task from the dashboard (in-process)
 *   GET  /api/fleet/tailnet → Tailscale peer list
 *   WS   /ws                → live event stream (run progress, fleet changes)
 *
 * Binds 127.0.0.1:8799 by default — matches the existing Tailscale funnel so
 * the dashboard is reachable at https://dans-mac-studio.tailc56ca0.ts.net
 */
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../config.js";
import { createRegistry } from "../adapters/registry.js";
import { ModelRouterImpl } from "../models/router.js";
import * as store from "../kernel/store.js";
import { getTailnetPeers } from "../kernel/tailnet.js";
import { dashboardHtml } from "./dashboard.js";
import { port as resolvePort, dashboardTailscaleUrl } from "../ports.js";
import { defaultPolicy } from "../safety/policy.js";
import { Scheduler } from "../kernel/scheduler.js";
import { TaskOrchestrator, type TaskEvent } from "../orchestrator/task.js";
import { clarifyTask, type ClarifyResult, type ClarifyQuestion } from "../orchestrator/clarify.js";

export interface ServerOptions {
  port?: number;
  host?: string;
}

export function startServer(opts: ServerOptions = {}): http.Server {
  const port = opts.port ?? resolvePort("dashboard");
  const host = opts.host ?? "127.0.0.1";

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}`);
    const path = url.pathname;

    try {
      // ---- POST: event ingest (CLI orchestrator → daemon → WS broadcast) ----
      if (req.method === "POST" && path === "/api/events") {
        const body = await readBody(req);
        try {
          const evt = JSON.parse(body);
          // Broadcast to all connected dashboard WS clients (Conversation tab).
          broadcast(evt.type ?? "event", evt.data ?? evt);
          return json(res, { ok: true });
        } catch {
          return json(res, { error: "invalid JSON" }, 400);
        }
      }

      // ---- POST: upload a file/image attachment (drag-drop or attach button) ----
      // Saves to a per-session temp dir and returns the absolute path. The path
      // is then passed to POST /api/task, which injects it into the prompt so
      // every agent (codex/claude/gemini) can read the file from disk.
      if (req.method === "POST" && path === "/api/upload") {
        const body = await readBody(req);
        let parsed: { name?: string; type?: string; data?: string };
        try { parsed = JSON.parse(body); } catch { return json(res, { error: "invalid JSON" }, 400); }
        const name = (parsed.name ?? "").trim();
        const data = (parsed.data ?? "").trim();
        if (!name || !data) return json(res, { error: "name and data are required" }, 400);
        // Reject obviously oversized payloads (64 MB) to protect the daemon.
        if (data.length > 64 * 1024 * 1024) return json(res, { error: "file too large (max 64 MB)" }, 413);

        const dir = resolveUploadDir();
        try { mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
        // Sanitize the filename: keep the extension, strip path components, append
        // a short uuid to avoid collisions between uploads of the same name.
        const ext = extname(name).toLowerCase();
        const base = name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 48).replace(/\.[^.]+$/, "");
        const safeName = `${base}-${randomUUID().slice(0, 8)}${ext}`;
        const fullPath = join(dir, safeName);
        try {
          writeFileSync(fullPath, Buffer.from(data, "base64"));
        } catch (e) {
          return json(res, { error: `write failed: ${(e as Error).message}` }, 500);
        }
        return json(res, { ok: true, path: fullPath, name: safeName, originalName: name, type: parsed.type ?? "" });
      }

      // ---- POST: start a task from the dashboard (in-process orchestrator) ----
      if (req.method === "POST" && path === "/api/task") {
        const body = await readBody(req);
        let parsed: { task?: string; agents?: string[]; maxLoops?: number; cwd?: string; attachments?: string[]; engine?: string; fullAuto?: boolean };
        try { parsed = JSON.parse(body); } catch { return json(res, { error: "invalid JSON" }, 400); }
        const taskRaw = (parsed.task ?? "").trim();
        if (!taskRaw) return json(res, { error: "task is required" }, 400);

        // Inject attachment paths into the task prompt so every agent reads them.
        const taskBase = injectAttachments(taskRaw, parsed.attachments);

        const cfg = loadConfig();
        const registry = createRegistry(cfg);
        const router = new ModelRouterImpl(cfg.models);
        const policy = defaultPolicy();
        const scheduler = new Scheduler(policy, { concurrency: 2 });

        // Broadcast orchestrator events directly to WS clients (same process —
        // no HTTP loopback needed, unlike the CLI path which posts to /api/events).
        const onEvent = (evt: TaskEvent) => {
          if (evt.kind === "phase") {
            broadcast("phase", { phase: evt.phase, iteration: evt.iteration });
          } else if (evt.kind === "message") {
            broadcast("conversation", evt.message);
          } else if (evt.kind === "agent-switch") {
            broadcast("agent-switch", { phase: evt.phase, from: evt.from, to: evt.to, reason: evt.reason });
          } else if (evt.kind === "done") {
            broadcast("done", {
              runId: evt.result.runId,
              status: evt.result.status,
              error: evt.result.error,
              finalOutput: evt.result.finalOutput ?? "",
              iterations: evt.result.iterations,
            });
          }
        };

        // GSD engine: clarify FIRST, then orchestrate. The clarifier scores the
        // task's ambiguity (GSD spec-phase model). If ambiguous, it pauses and
        // asks the user clarifying questions (GSD discuss-phase model) before
        // proceeding. The "fast" engine skips clarification for speed.
        const engine = parsed.engine ?? "gsd";
        const runOrchestration = (task: string) => {
          const orchestrator = new TaskOrchestrator(registry, router, scheduler, policy, {
            task,
            agents: parsed.agents,
            maxLoops: parsed.maxLoops,
            posture: parsed.fullAuto ? "full-auto" : undefined,
            cwd: parsed.cwd,
            onEvent,
          });
          activeOrchestrator = orchestrator;
          void orchestrator.run()
            .catch((e) => broadcast("error", { message: (e as Error).message }))
            .finally(() => { if (activeOrchestrator === orchestrator) activeOrchestrator = null; });
        };

        if (engine === "fast") {
          runOrchestration(taskBase);
          return json(res, { ok: true, task: taskBase });
        }

        // GSD engine: run the clarifier detached, then decide.
        void (async () => {
          try {
            const clarify: ClarifyResult = await clarifyTask(registry, router, scheduler, policy, taskBase, {
              cwd: parsed.cwd,
              onMessage: (msg) => broadcast("conversation", { phase: "planning", fromAgent: "clarifier", content: msg }),
            });
            if (clarify.clear) {
              runOrchestration(taskBase);
              return;
            }
            // Ambiguous — pause and ask the user. Generate a question id and
            // await the answer via the pending-clarify protocol.
            const questionId = "clarify-" + Date.now().toString(36);
            broadcast("clarify", { questionId, questions: clarify.questions });
            const answers = await new Promise<Record<string, string>>((resolve) => {
              pendingClarify = { questionId, questions: clarify.questions, resolve };
            });
            // Fold the user's answers into the task as locked decisions.
            runOrchestration(foldDecisions(taskBase, clarify.questions, answers));
          } catch (e) {
            broadcast("error", { message: (e as Error).message });
          }
        })();

        return json(res, { ok: true, task: taskBase });
      }

      // ---- POST: answer a clarifying question (resumes a paused task) ----
      if (req.method === "POST" && path === "/api/task/answer") {
        const body = await readBody(req);
        let parsed: { questionId?: string; answers?: Record<string, string> };
        try { parsed = JSON.parse(body); } catch { return json(res, { error: "invalid JSON" }, 400); }
        if (!parsed.questionId || !parsed.answers) return json(res, { error: "questionId and answers are required" }, 400);
        const pending = pendingClarify;
        if (!pending || pending.questionId !== parsed.questionId) {
          return json(res, { error: "no matching pending question" }, 404);
        }
        pendingClarify = null;
        pending.resolve(parsed.answers);
        broadcast("conversation", { phase: "planning", fromAgent: "clarifier", content: "Answers received. Locking decisions and starting orchestration." });
        return json(res, { ok: true });
      }

      // ---- POST: cancel the active task (stops a runaway / stuck run) ----
      if (req.method === "POST" && path === "/api/task/cancel") {
        if (!activeOrchestrator) return json(res, { error: "no active task to cancel" }, 404);
        activeOrchestrator.cancel();
        broadcast("conversation", { phase: "delivered", fromAgent: "orchestrator", content: "[cancelled] Task cancelled by user" });
        broadcast("done", { status: "cancelled", finalOutput: "" });
        activeOrchestrator = null;
        return json(res, { ok: true });
      }

      // ---- static dashboard ----
      if (path === "/" || path === "/index.html") {
        // no-cache: the dashboard is a single inline-SPA. Without this header
        // the browser serves a stale cached copy after a rebuild, so UI fixes
        // (button wiring, attachment logic, …) silently never reach the user.
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache, no-store, must-revalidate",
        });
        res.end(dashboardHtml);
        return;
      }

      // ---- API ----
      if (path === "/api/health") return json(res, { ok: true, version: "0.1.0" });

      if (path === "/api/fleet") {
        const cfg = loadConfig();
        const registry = createRegistry(cfg);
        const fleet = registry.enabled().map((a) => ({
          name: a.name,
          displayName: a.displayName,
          dynamic: a.dynamic ?? false,
          capabilities: a.capabilities,
        }));
        return json(res, { fleet });
      }

      if (path === "/api/models") {
        const cfg = loadConfig();
        const router = new ModelRouterImpl(cfg.models);
        return json(res, {
          aliases: router.describe(),
          defaults: cfg.models.defaults,
        });
      }

      if (path === "/api/runs") {
        return json(res, { runs: await store.listRuns(50) });
      }

      const runMatch = path.match(/^\/api\/runs\/([\w-]+)$/);
      if (runMatch && runMatch[1]) {
        const id = runMatch[1];
        const run = await store.getRun(id);
        if (!run) return json(res, { error: "not found" }, 404);
        return json(res, { run, candidates: await store.listCandidates(id) });
      }

      if (path === "/api/fleet/tailnet") {
        const peers = await getTailnetPeers();
        return json(res, { peers });
      }

      if (path === "/api/stats") {
        const runs = await store.listRuns(200);
        const totalSpent = runs.reduce((s, r) => s + (r.spentUsd ?? 0), 0);
        const byPattern: Record<string, number> = {};
        const byStatus: Record<string, number> = {};
        const winRate: Record<string, { wins: number; runs: number }> = {};
        const spendOverTime: { ts: string; spent: number }[] = [];
        for (const r of runs) {
          byPattern[r.pattern] = (byPattern[r.pattern] ?? 0) + 1;
          byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
          if (r.winnerAgent) {
            winRate[r.winnerAgent] = winRate[r.winnerAgent] ?? { wins: 0, runs: 0 };
            winRate[r.winnerAgent]!.wins += 1;
          }
          // Track all agents that participated (approx: by pattern agents in meta).
          if (r.spentUsd) spendOverTime.push({ ts: r.ts, spent: r.spentUsd });
        }
        const winRatePct = Object.fromEntries(
          Object.entries(winRate).map(([k, v]) => [k, Math.round((v.wins / Math.max(1, runs.filter(r => r.winnerAgent).length)) * 100)])
        );
        return json(res, {
          totalRuns: runs.length,
          totalSpent,
          byPattern,
          byStatus,
          winRate: winRatePct,
          spendOverTime: spendOverTime.slice(-30),
        });
      }

      if (path === "/api/config/agents") {
        const cfg = loadConfig();
        return json(res, { agents: cfg.agents.agents.map((a) => ({ name: a.name, command: a.command, enabled: a.enabled, defaultModel: a.defaultModel, dynamic: a.dynamic })) });
      }

      return json(res, { error: "not found", path }, 404);
    } catch (e) {
      return json(res, { error: (e as Error).message }, 500);
    }
  });

  // ---- WebSocket upgrade for live events ----
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${host}`);
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    acceptWebSocket(req, socket);
    // head is consumed by acceptWebSocket; reference to satisfy lints
    void head;
  });

  server.listen(port, host, () => {
    console.log(`Stack Ai OS dashboard: http://${host}:${port}`);
    console.log(`  Tailscale: ${dashboardTailscaleUrl()} (run 'stackai serve --tailnet' to publish)`);
  });

  return server;
}

/** Minimal RFC6455 WebSocket accept (no deps). */
function acceptWebSocket(req: http.IncomingMessage, socket: import("node:stream").Duplex): void {
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string") { socket.destroy(); return; }
  const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  // Broadcast channel: any module can push events to all connected clients.
  WS_CLIENTS.add(socket);
  socket.on("close", () => WS_CLIENTS.delete(socket));
  socket.on("error", () => WS_CLIENTS.delete(socket));
}

type WritableClient = { write: (data: string | Buffer) => boolean; destroy: () => void };
export const WS_CLIENTS = new Set<WritableClient>();

// ── Pending-clarify state (pause/resume protocol) ───────────────────────────
// When the clarifier finds an ambiguous task, the orchestrator pauses and waits
// for the user to answer the clarifying questions. This holds the resolver the
// paused task is awaiting; POST /api/task/answer resolves it with the answers.
// One pending question at a time — the daemon is single-user.
interface PendingClarify {
  questionId: string;
  questions: ClarifyQuestion[];
  resolve: (answers: Record<string, string>) => void;
}
let pendingClarify: PendingClarify | null = null;

// ── Active orchestrators (for run cancellation) ─────────────────────────────
// Tracks the orchestrator for the most recent task so POST /api/task/cancel
// can abort it. Single-user daemon → one active task at a time.
let activeOrchestrator: { cancel: () => void } | null = null;

/** Broadcast a JSON event to all connected dashboard clients. */
export function broadcast(type: string, data: unknown): void {
  const payload = JSON.stringify({ type, data });
  const frame = wsFrame(payload);
  for (const c of WS_CLIENTS) {
    try { c.write(frame); } catch { WS_CLIENTS.delete(c); }
  }
}

/** Encode a text WebSocket frame (server→client, unmasked). */
function wsFrame(payload: string): Buffer {
  const len = Buffer.byteLength(payload);
  const head =
    len < 126 ? Buffer.from([0x81, len]) :
    len < 65536 ? Buffer.from([0x81, 126, (len >> 8) & 0xff, len & 0xff]) :
    (() => { throw new Error("payload too large for ws frame"); })();
  return Buffer.concat([head, Buffer.from(payload)]);
}

function json(res: http.ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(body));
}

/** Read the full request body (for POST /api/events). */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Resolve the attachment upload directory. Uses STACKAI_DATA_DIR if set
 * (matches the store), otherwise a stack-ai-os/ dir under the OS tmpdir.
 */
function resolveUploadDir(): string {
  const base = process.env.STACKAI_DATA_DIR ?? join(tmpdir(), "stack-ai-os");
  return join(base, "uploads");
}

/** MIME types treated as images (so the prompt says "image" not "file"). */
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);

/**
 * Inject attachment file paths into the task prompt. Each existing path is
 * referenced by its absolute location so agents can read it. Non-existent
 * paths are skipped (they may have been cleaned up or forged).
 *
 * Example output:
 *   <original task>
 *
 *   --- Attached files ---
 *   - /tmp/.../screenshot.png  (image)
 *   - /tmp/.../spec.md  (file)
 *   Read these attachments to complete the task above.
 */
function injectAttachments(task: string, attachments?: string[]): string {
  if (!attachments || attachments.length === 0) return task;
  const valid = attachments.filter((p) => {
    try { return existsSync(p); } catch { return false; }
  });
  if (valid.length === 0) return task;
  const lines = valid.map((p) => {
    const isImage = IMAGE_EXTS.has(extname(p).toLowerCase());
    return `- ${p}  (${isImage ? "image" : "file"})`;
  });
  return `${task}\n\n--- Attached files ---\n${lines.join("\n")}\nRead these attachments to complete the task above.`;
}

/**
 * Fold the user's clarifying answers into the task as LOCKED DECISIONS. This is
 * GSD's core "discuss once, lock forever" principle — downstream agents see the
 * decisions and must not re-question them. Answers the user didn't provide get
 * the recommended option as a default.
 *
 * Example output appended to the task:
 *   === LOCKED DECISIONS (do not re-question) ===
 *   - Output format: CLI script (a runnable .py file)
 *   - Language: Python
 */
function foldDecisions(
  task: string,
  questions: ClarifyQuestion[],
  answers: Record<string, string>,
): string {
  const lines: string[] = [];
  for (const q of questions) {
    const answer = answers[q.id];
    if (answer && answer.trim()) {
      lines.push(`- ${q.header}: ${answer.trim()}`);
    } else {
      // No answer → use the recommended option (GSD --auto fallback).
      const rec = q.options.find((o) => o.recommended) ?? q.options[0];
      if (rec) lines.push(`- ${q.header}: ${rec.label}`);
    }
  }
  if (lines.length === 0) return task;
  return `${task}\n\n=== LOCKED DECISIONS (do not re-question) ===\n${lines.join("\n")}`;
}

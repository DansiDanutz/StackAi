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
 *   GET  /api/fleet/tailnet → Tailscale peer list
 *   WS   /ws                → live event stream (run progress, fleet changes)
 *
 * Binds 127.0.0.1:8799 by default — matches the existing Tailscale funnel so
 * the dashboard is reachable at https://dans-mac-studio.tailc56ca0.ts.net
 */
import http from "node:http";
import { createHash } from "node:crypto";
import { loadConfig } from "../config.js";
import { createRegistry } from "../adapters/registry.js";
import { ModelRouterImpl } from "../models/router.js";
import * as store from "../kernel/store.js";
import { getTailnetPeers } from "../kernel/tailnet.js";
import { dashboardHtml } from "./dashboard.js";
import { port as resolvePort, dashboardTailscaleUrl } from "../ports.js";

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
      // ---- static dashboard ----
      if (path === "/" || path === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
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

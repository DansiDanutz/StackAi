/**
 * Stack Ai OS — Dashboard Conversation bridge test.
 *
 * Verifies the live-event path: POST /api/events → broadcast() → connected
 * WebSocket client receives the event. This is the bridge that makes the
 * dashboard Conversation tab update live when `stackai task` runs. It was
 * previously built but never tested end-to-end.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Socket } from "node:net";
import { Buffer } from "node:buffer";

const TMP = mkdtempSync(join(tmpdir(), "sao-conv-"));
process.env.STACKAI_DATA_DIR = TMP;
process.env.STACKAI_CONFIG_DIR = TMP;

const { startServer } = await import("../src/web/server.js");
let server: http.Server;
let port: number;

beforeAll(async () => {
  server = startServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => server.on("listening", () => {
    port = (server.address() as any).port;
    resolve();
  }));
});
afterAll(async () => {
  // Force-close: server.close() waits for keep-alive connections; use a timeout.
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    setTimeout(resolve, 1500); // don't let teardown hang the suite
  });
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** Minimal raw WebSocket client (no dep) that connects and collects messages. */
function connectWs(): { messages: string[]; close: () => void; opened: Promise<void> } {
  const messages: string[] = [];
  const sock = new Socket();
  const key = Buffer.from(Math.random().toString()).slice(0, 16).toString("base64");
  const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");

  const opened = new Promise<void>((resolve, reject) => {
    sock.connect(port, "127.0.0.1");
    sock.on("connect", () => {
      sock.write(
        "GET /ws HTTP/1.1\r\n" +
        "Host: 127.0.0.1\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Key: ${key}\r\n` +
        "Sec-WebSocket-Version: 13\r\n\r\n"
      );
    });
    sock.on("data", (data) => {
      const buf = Buffer.from(data);
      const text = buf.toString();
      if (text.includes("101 Switching")) {
        resolve(); // handshake done
        // There may be a frame in the same chunk after the headers.
        const frameStart = text.indexOf("\r\n\r\n");
        if (frameStart >= 0) parseFrame(buf.subarray(frameStart + 4));
      } else {
        // This chunk is a WS frame (after handshake).
        parseFrame(buf);
      }
    });
    sock.on("error", reject);
    setTimeout(() => resolve(), 2000); // don't hang forever
  });

  return { messages, close: () => sock.destroy(), opened };

  /** Parse a WebSocket text frame (server→client, unmasked) into messages. */
  function parseFrame(buf: Buffer) {
    if (buf.length < 2) return;
    const opcode = buf[0]! & 0x0f;
    if (opcode !== 0x1) return; // only text frames
    const masked = (buf[1]! & 0x80) !== 0;
    let len = buf[1]! & 0x7f;
    let offset = 2;
    if (len === 126) { len = buf.readUInt16BE(2); offset = 4; }
    else if (len === 127) { offset = 10; }
    let payload = buf.subarray(offset, offset + len);
    if (masked) {
      const mask = buf.subarray(offset, offset + 4);
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]!;
      offset += 4;
    }
    messages.push(payload.toString("utf8"));
  }
}

function postEvent(payload: any): Promise<void> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request(`http://127.0.0.1:${port}/api/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
    }, () => resolve());
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

describe("dashboard conversation bridge (POST /api/events → WS broadcast)", () => {
  it("broadcasts a phase event to connected WS clients", async () => {
    const client = connectWs();
    await client.opened;
    await postEvent({ type: "phase", data: { phase: "planning" } });
    // Give the broadcast a moment to propagate.
    await new Promise((r) => setTimeout(r, 300));
    client.close();
    const received = client.messages.some((m) => m.includes("planning"));
    expect(received).toBe(true);
  });

  it("broadcasts a conversation message to connected WS clients", async () => {
    const client = connectWs();
    await client.opened;
    await postEvent({ type: "conversation", data: { fromAgent: "codex", content: "hello team", phase: "running" } });
    await new Promise((r) => setTimeout(r, 300));
    client.close();
    const received = client.messages.some((m) => m.includes("codex") && m.includes("hello team"));
    expect(received).toBe(true);
  });

  it("broadcasts a done event", async () => {
    const client = connectWs();
    await client.opened;
    await postEvent({ type: "done", data: { runId: "test-123", status: "delivered" } });
    await new Promise((r) => setTimeout(r, 300));
    client.close();
    const received = client.messages.some((m) => m.includes("delivered"));
    expect(received).toBe(true);
  });
});

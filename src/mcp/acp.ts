/**
 * Stack Ai OS — ACP (Agent Client Protocol) client
 *
 * ACP is a JSON-RPC 2.0 protocol over stdio between a CLIENT (us) and an AGENT
 * (a coding-agent CLI that speaks ACP, e.g. opencode/gemini/kimi/zcode). It's
 * far more reliable than parsing each CLI's bespoke stream-json, because the
 * wire messages are standardized: initialize → session/new → session/prompt →
 * session/update notifications → PromptResponse(stopReason).
 *
 * Reference: agentclientprotocol.com — schema v1. We implement the client side
 * (the methods an AGENT must handle), per meta.json:
 *   initialize, session/new, session/prompt, session/cancel, session/close
 * and we handle the client→us notifications:
 *   session/update (TaskStart | AgentMessage | TaskComplete | …)
 *
 * This module is transport-only: it produces normalized AgentEvents. Adapters
 * that opt into ACP use runAcpSession() instead of the raw child-process path.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { AgentEvent } from "../types.js";

export interface AcpEndpoint {
  /** Command to spawn the ACP agent server (e.g. ["opencode","acp"]). */
  cmd: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface AcpSessionOptions {
  endpoint: AcpEndpoint;
  prompt: string;
  cwd?: string;
  /** Model id (passed in initialize.config or session/new). */
  model?: string;
  /** Previous ACP session id to resume. */
  sessionId?: string;
  /** Wall-clock seconds before we cancel + kill. */
  timeoutSec?: number;
  /** Permission mode hint, e.g. "yolo"/"auto"/"default". */
  mode?: string;
}

const PROTOCOL_VERSION = 1;

/** A fully-normalized async stream of AgentEvents from one ACP prompt turn. */
export async function* runAcpSession(
  opts: AcpSessionOptions,
  onRaw?: (msg: any) => void
): AsyncIterable<AgentEvent> {
  const child = spawn(opts.endpoint.cmd, opts.endpoint.args, {
    cwd: opts.endpoint.cwd ?? opts.cwd ?? process.cwd(),
    env: { ...process.env, ...opts.endpoint.env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const rpc = new JsonRpcTransport(child, opts.timeoutSec ?? 600);
  let sessionId: string | undefined = opts.sessionId;
  let finalText = "";
  let timedOut = false;

  try {
    // 1. initialize handshake (client capabilities + protocol version).
    const init = await rpc.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "stack-ai-os", version: "0.1.0" },
    });
    onRaw?.({ phase: "initialize", result: init });

    // 2. session/new (or session/load if resuming).
    if (sessionId) {
      await rpc.request("session/load", { sessionId }).catch(() => {});
    } else {
      const res = await rpc.request("session/new", {
        cwd: opts.cwd,
        mode: opts.mode,
        mcpServers: [],
        config: opts.model ? { model: opts.model } : undefined,
      });
      sessionId = res?.sessionId ?? res?.session?.id;
      if (sessionId) yield { type: "system", subtype: "init", message: `acp session ${sessionId}` };
    }

    // 3. session/prompt — prompts in ACP are an array of message parts.
    // While the prompt is active, the agent emits session/update notifications.
    const promptPromise = rpc.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: opts.prompt }],
    });

    // 4. Consume session/update notifications until the prompt resolves.
    await Promise.race([
      (async () => {
        const stop = await promptPromise;
        onRaw?.({ phase: "prompt-done", result: stop });
      })(),
      rpc.closed,
    ]).catch(() => {
      timedOut = true;
    });

    // Drain any buffered updates, then map them.
    for (const upd of rpc.drainUpdates()) {
      const ev = mapSessionUpdate(upd);
      if (ev) {
        if (ev.type === "assistant" && ev.subtype === "text") finalText += ev.text;
        yield ev;
      }
    }
  } catch (e) {
    yield { type: "error", message: (e as Error).message, recoverable: false };
  } finally {
    // 5. session/close + kill.
    if (sessionId) {
      await rpc.notify("session/close", { sessionId }).catch(() => {});
    }
    rpc.dispose();
    child.kill("SIGKILL");

    yield {
      type: "done",
      exitCode: timedOut ? 124 : 0,
      finalText,
      sessionId,
    };
  }
}

/** Map an ACP session/update payload to our normalized AgentEvent. */
function mapSessionUpdate(upd: any): AgentEvent | null {
  // SessionUpdate is a discriminated union by the shape of its nested object.
  const kind = upd?.update?.kind ?? upd?.kind ?? upd?.type;
  const data = upd?.update ?? upd;

  switch (kind) {
    case "task_start":
      return { type: "system", subtype: "task_start", message: String(data?.role ?? "agent") };
    case "agent_message":
      return {
        type: "assistant",
        subtype: "text",
        text: extractText(data?.content ?? data?.message ?? data?.text),
      };
    case "reasoning":
      return {
        type: "assistant",
        subtype: "thinking",
        text: extractText(data?.content ?? data?.text),
      };
    case "tool_call":
      return {
        type: "tool_use",
        id: String(data?.id ?? data?.toolCallId ?? ""),
        name: String(data?.toolName ?? data?.name ?? ""),
        input: data?.input ?? data?.rawInput,
      };
    case "tool_call_update":
    case "tool_call_result":
      return {
        type: "tool_result",
        id: String(data?.id ?? data?.toolCallId ?? ""),
        content: extractText(data?.content ?? data?.output ?? "").slice(0, 4000),
        isError: Boolean(data?.error),
      };
    case "task_complete":
      return { type: "system", subtype: "task_complete", message: "done" };
    default:
      return null;
  }
}

function extractText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "string" ? c : c?.text ?? c?.content ?? ""))
      .join("");
  }
  if (content?.text) return String(content.text);
  return "";
}

// ---------------------- minimal JSON-RPC 2.0 over stdio --------------------

class JsonRpcTransport {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private buffer = "";
  private updates: any[] = [];
  private timer: NodeJS.Timeout;
  private dead = false;
  /** Resolves when the child closes or times out. */
  readonly closed: Promise<void>;
  private resolveClosed!: () => void;

  constructor(
    private child: ChildProcessWithoutNullStreams,
    timeoutSec: number
  ) {
    this.closed = new Promise((r) => (this.resolveClosed = r));
    this.timer = setTimeout(() => this.timeout(), timeoutSec * 1000);

    child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    child.stderr.on("data", () => { /* swallow; ACP is on stdout */ });
    child.on("exit", () => this.shutdown());
    child.on("error", () => this.shutdown());
  }

  request(method: string, params?: any): Promise<any> {
    if (this.dead) return Promise.reject(new Error("ACP transport closed"));
    const id = this.nextId++;
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.child.stdin.write(msg + "\n");
      } catch (e) {
        reject(e as Error);
      }
    });
  }

  notify(method: string, params?: any): Promise<void> {
    if (this.dead) return Promise.resolve();
    return new Promise((resolve) => {
      try {
        this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
      } catch { /* ignore */ }
      resolve();
    });
  }

  drainUpdates(): any[] {
    const u = this.updates;
    this.updates = [];
    return u;
  }

  private onData(chunk: Buffer) {
    this.buffer += chunk.toString();
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      this.handle(msg);
    }
  }

  private handle(msg: any) {
    // Response to a request?
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message ?? "ACP error"));
        else p.resolve(msg.result);
      }
      return;
    }
    // Notification (no id) — route session/update into our buffer.
    if (msg.method === "session/update" && msg.params) {
      this.updates.push(msg.params);
    }
  }

  private timeout() {
    for (const [, p] of this.pending) p.reject(new Error("ACP request timeout"));
    this.pending.clear();
    this.shutdown();
  }

  private shutdown() {
    if (this.dead) return;
    this.dead = true;
    clearTimeout(this.timer);
    this.resolveClosed();
  }

  dispose() {
    this.dead = true;
    clearTimeout(this.timer);
    try { this.child.stdin.end(); } catch { /* ignore */ }
  }
}

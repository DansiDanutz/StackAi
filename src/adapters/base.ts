/**
 * Stack Ai OS — Base adapter
 *
 * Shared machinery every concrete adapter builds on:
 *  - spawnProcess: spawn the CLI, stream stdout/stderr, enforce timeout.
 *  - pumpEvents: parse newline-delimited JSON and run each adapter's parseEvent.
 *  - run(): the default AsyncIterable<AgentEvent> implementation.
 *
 * Concrete adapters only implement buildCommand() + parseEvent(); the spawn
 * + normalize loop is identical for all 9 CLIs.
 */
import { spawn } from "node:child_process";
import { runAcpSession } from "../mcp/acp.js";
import type {
  AgentEvent,
  AgentName,
  AdapterCapabilities,
  ModelRouter,
  RunRequest,
} from "../types.js";
import type { AgentAdapter } from "../types.js";
import type { AgentConfig } from "../config.js";

export abstract class BaseAdapter implements AgentAdapter {
  abstract readonly name: AgentName;
  abstract readonly capabilities: AdapterCapabilities;
  abstract displayName: string;
  protected readonly cfg: AgentConfig;

  constructor(cfg: AgentConfig) {
    this.cfg = cfg;
  }

  abstract resolveModel(alias: string, router: ModelRouter): string | undefined;
  abstract buildCommand(
    req: RunRequest,
    router: ModelRouter
  ): { cmd: string; args: string[]; env: NodeJS.ProcessEnv };
  abstract parseEvent(raw: unknown): AgentEvent | null;

  /**
   * The command to launch this agent as an ACP server (JSON-RPC over stdio).
   * Override in adapters whose CLIs support ACP (opencode/gemini/kimi/zcode).
   * Return null if ACP is not available for this run; the base run() then
   * falls back to the stream-json child-process path.
   */
  acpCommand(_req: RunRequest, _router: ModelRouter): { cmd: string; args: string[] } | null {
    return null;
  }

  /**
   * Spawn the CLI built by buildCommand(), stream its output, and yield
   * normalized AgentEvents. Enforces timeoutSec; emits a final `done` event.
   *
   * Two parsing modes:
   *  - stream-json (default): each stdout line is JSON → parseEvent.
   *  - text: stdout is accumulated; a single `assistant` event + `done` emitted.
   */
  async *run(req: RunRequest, router: ModelRouter): AsyncIterable<AgentEvent> {
    // ACP path: if the adapter is ACP-capable and yields a launch command,
    // use the structured JSON-RPC session instead of parsing stream-json.
    if (this.capabilities.acpServer) {
      const acp = this.acpCommand(req, router);
      if (acp) {
        yield* runAcpSession({
          endpoint: { cmd: acp.cmd, args: acp.args, cwd: req.cwd, env: {} },
          prompt: req.prompt,
          cwd: req.cwd,
          model: this.resolveModel(req.model ?? "auto", router) || undefined,
          sessionId: req.sessionId,
          timeoutSec: req.timeoutSec,
          mode: req.posture === "full-auto" ? "yolo" : undefined,
        });
        return;
      }
    }

    // Stream-json / text path (default).
    const { cmd, args, env } = this.buildCommand(req, router);
    const verbosity = req.verbosity ?? "stream-json";
    const timeoutMs = (req.timeoutSec ?? 600) * 1000;

    const child = spawn(cmd, args, {
      cwd: req.cwd ?? process.cwd(),
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Close stdin immediately. Several CLIs (codex, gemini) read additional
    // context from stdin when it's a pipe and BLOCK forever waiting for input
    // if left open. We never pipe prompt content via stdin (always via flags),
    // so end it right away.
    try { child.stdin.end(); } catch { /* already closed */ }

    let timedOut = false;
    let finalText = "";
    let sessionId: string | undefined;
    const buffer: string[] = [];
    const stderrBuf: string[] = [];

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // escalate if it won't die
      setTimeout(() => child.kill("SIGKILL"), 5000);
    }, timeoutMs);

    // Line-buffered stream-json parser. Resolves a Promise per line boundary so
    // the generator can yield events as they arrive.
    let pending = "";
    const lineEmitter = createLineEmitter();

    child.stdout?.on("data", (chunk: Buffer) => {
      pending += chunk.toString();
      let idx: number;
      while ((idx = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, idx).trim();
        pending = pending.slice(idx + 1);
        if (line) lineEmitter.push(line);
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf.push(chunk.toString());
    });
    child.stdout?.on("end", () => lineEmitter.end());

    try {
      while (true) {
        const line = await lineEmitter.next();
        if (line === null) break; // stdout closed

        if (verbosity === "stream-json" || verbosity === "json") {
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            // Not JSON — treat as a textual progress line.
            yield { type: "system", message: line };
            continue;
          }
          const evt = this.parseEvent(parsed);
          if (evt) {
            if (evt.type === "assistant" && evt.subtype === "text") finalText += evt.text;
            if (evt.type === "done") {
              if (evt.sessionId) sessionId = evt.sessionId;
              if (evt.finalText) finalText = evt.finalText;
            }
            yield evt;
          }
        } else {
          // text mode: collect and emit as one assistant block at the end.
          buffer.push(line);
        }
      }
    } finally {
      clearTimeout(timer);
    }

    // Wait for process exit.
    const exitCode: number = await new Promise((resolve) => {
      child.on("exit", (code) => resolve(code ?? 0));
      child.on("error", () => resolve(1));
    });

    if (verbosity === "text" && buffer.length) {
      finalText = buffer.join("\n");
      yield { type: "assistant", subtype: "text", text: finalText };
    }

    if (stderrBuf.length && exitCode !== 0) {
      yield {
        type: "error",
        message: stderrBuf.join("").trim().slice(0, 2000),
        recoverable: false,
      };
    }

    yield {
      type: "done",
      exitCode: timedOut ? 124 : exitCode,
      finalText,
      sessionId,
    };
  }
}

/** Tiny async line queue: push lines, consume via next() (null = ended). */
function createLineEmitter() {
  const queue: string[] = [];
  let waiter: ((v: string | null) => void) | null = null;
  let ended = false;

  return {
    push(line: string) {
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(line);
      } else {
        queue.push(line);
      }
    },
    end() {
      ended = true;
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(null);
      }
    },
    next(): Promise<string | null> {
      if (queue.length) return Promise.resolve(queue.shift()!);
      if (ended) return Promise.resolve(null);
      return new Promise((resolve) => {
        waiter = resolve;
      });
    },
  };
}

/** Helper for adapters: resolve an alias, falling back to the agent's defaultModel. */
export function resolveWithDefault(
  adapterName: AgentName,
  alias: string | undefined,
  router: ModelRouter,
  defaultModel?: string
): string | undefined {
  if (!alias || alias === "auto") return defaultModel;
  if (alias.includes(":") && alias.startsWith(adapterName + ":")) {
    return alias.slice(adapterName.length + 1);
  }
  // A bare `agent:model` pin for this specific agent.
  return router.resolve(adapterName, alias) ?? alias;
}

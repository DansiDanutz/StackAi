/**
 * Stack Ai OS — Mock adapter for testing patterns without real agents.
 *
 * A deterministic fake adapter that yields a configurable sequence of AgentEvents.
 * This is what lets us regression-test the scheduler's finalText accumulation,
 * the orchestrator's phase flow, and --out file writing — all without spawning
 * real CLIs (which are slow, flaky, and need auth).
 */
import type {
  AgentEvent, AgentName, AdapterCapabilities, ModelRouter, RunRequest,
} from "../src/types.js";
import type { AgentAdapter } from "../src/types.js";

export interface MockAdapterConfig {
  name?: AgentName;
  /** Events to emit on each run() call. If it's a function, called per-run (for multi-call mocks). */
  events?: AgentEvent[] | (() => AgentEvent[]);
  /** Delay between events (ms), for realistic streaming. Default 0. */
  delayMs?: number;
  capabilities?: Partial<AdapterCapabilities>;
}

export class MockAdapter implements AgentAdapter {
  readonly name: AgentName;
  readonly capabilities: AdapterCapabilities;
  readonly dynamic = false;
  displayName: string;
  private eventsConfig: AgentEvent[] | (() => AgentEvent[]);
  private delayMs: number;
  callCount = 0;

  constructor(cfg: MockAdapterConfig = {}) {
    this.name = cfg.name ?? ("mock" as AgentName);
    this.displayName = "Mock Agent";
    this.eventsConfig = cfg.events ?? [];
    this.delayMs = cfg.delayMs ?? 0;
    this.capabilities = {
      jsonStream: true,
      modelSelection: false,
      mcpClient: false,
      mcpServer: false,
      sessionResume: false,
      fullAuto: false,
      acpServer: false,
      ...cfg.capabilities,
    };
  }

  resolveModel(): string | undefined { return undefined; }

  buildCommand(): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } {
    return { cmd: "mock", args: [], env: {} };
  }

  parseEvent(raw: unknown): AgentEvent | null {
    return raw as AgentEvent;
  }

  async *run(_req: RunRequest, _router: ModelRouter): AsyncIterable<AgentEvent> {
    this.callCount++;
    const events = typeof this.eventsConfig === "function" ? this.eventsConfig() : this.eventsConfig;
    for (const evt of events) {
      if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
      yield evt;
    }
  }
}

/** Build the classic "streamed text, empty done" event sequence (the codex/gemini shape). */
export function streamedTextEvents(text: string, opts?: { sessionId?: string }): AgentEvent[] {
  return [
    { type: "system", subtype: "init", message: "mock session" },
    { type: "assistant", subtype: "text", text },
    { type: "done", exitCode: 0, finalText: "", sessionId: opts?.sessionId }, // empty finalText!
  ];
}

/** Build a "text in done only" sequence (some adapters put text only in done). */
export function doneTextEvents(text: string): AgentEvent[] {
  return [
    { type: "system", subtype: "init", message: "mock session" },
    { type: "done", exitCode: 0, finalText: text },
  ];
}

/** A no-op mock router. */
export const mockRouter: ModelRouter = {
  resolve: () => undefined,
  aliases: () => [],
};

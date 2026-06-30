/**
 * Stack Ai OS — Core Types
 *
 * The shared vocabulary every module speaks. Adapters normalize arbitrary CLIs
 * into RunRequest (in) / AgentEvent (out). Patterns and the kernel only ever
 * deal with these shapes — never raw CLI flags.
 */

/** Built-in agent names. Dynamic adapters use arbitrary string ids. */
export type BuiltinAgentName =
  | "claude"
  | "codex"
  | "opencode"
  | "gemini"
  | "kimi"
  | "openclaude"
  | "pi"
  | "hermes"
  | "zcode";

export const ALL_AGENTS: readonly BuiltinAgentName[] = [
  "claude", "codex", "opencode", "gemini", "kimi",
  "openclaude", "pi", "hermes", "zcode",
] as const;

/** Any agent — built-in or dynamically added. */
export type AgentName = BuiltinAgentName | (string & {});

/** What a given CLI can actually do — patterns consult this to pick eligible agents. */
export interface AdapterCapabilities {
  jsonStream: boolean;
  modelSelection: boolean;
  mcpClient: boolean;
  mcpServer: boolean;
  sessionResume: boolean;
  fullAuto: boolean;
  /** Can run as an ACP server (opencode/gemini/kimi/zcode) — enables robust
   *  structured events via the ACP client instead of stream-json parsing. */
  acpServer: boolean;
}

export type SafetyPosture = "cautious" | "full-auto";
export type Verbosity = "text" | "json" | "stream-json";

/**
 * A request to run one agent on one prompt. Patterns build these and hand them
 * to adapters; the kernel dispatches them through the scheduler.
 */
export interface RunRequest {
  agent: AgentName;
  prompt: string;
  cwd?: string;
  model?: string;
  posture?: SafetyPosture;
  verbosity?: Verbosity;
  mcpConfig?: string[];
  sessionId?: string;
  timeoutSec?: number;
  extraArgs?: string[];
  label?: string;
}

/**
 * Normalized event emitted by an adapter as an agent runs. Mirrors the
 * stream-json shape common to claude/codex/kimi, but is the only shape the
 * rest of the system consumes.
 */
export type AgentEvent =
  | { type: "system"; subtype?: string; message: string }
  | { type: "assistant"; subtype?: "text" | "thinking"; text: string }
  | { type: "tool_use"; id: string; name: string; input?: unknown }
  | { type: "tool_result"; id: string; name?: string; content: string; isError?: boolean }
  | { type: "cost"; inputTokens?: number; outputTokens?: number; costUsd?: number }
  | { type: "error"; message: string; recoverable?: boolean }
  | { type: "done"; exitCode: number; finalText: string; sessionId?: string };

export interface RunResult {
  agent: AgentName;
  exitCode: number;
  finalText: string;
  /** Error message if the agent emitted an error event (auth failure, CLI crash,
   *  rate limit, etc.). Surface this to the user — a non-empty error explains
   *  *why* finalText is empty / exitCode is non-zero. */
  error?: string;
  sessionId?: string;
  events: AgentEvent[];
  durationMs: number;
  costUsd?: number;
  timedOut: boolean;
}

/** What an adapter must implement. One per CLI (built-in or dynamic). */
export interface AgentAdapter {
  readonly name: AgentName;
  readonly capabilities: AdapterCapabilities;
  displayName: string;
  /** Whether this adapter was dynamically added (vs. a built-in). */
  readonly dynamic?: boolean;
  resolveModel(alias: string, router: ModelRouter): string | undefined;
  buildCommand(req: RunRequest, router: ModelRouter): { cmd: string; args: string[]; env: NodeJS.ProcessEnv };
  parseEvent(raw: unknown): AgentEvent | null;
  run(req: RunRequest, router: ModelRouter): AsyncIterable<AgentEvent>;
}

export interface ModelRouter {
  resolve(agent: AgentName, alias: string): string | undefined;
  aliases(): string[];
  describe(agent?: AgentName): Array<{ alias: string; resolved?: string; providers: Partial<Record<AgentName, string>> }>;
}

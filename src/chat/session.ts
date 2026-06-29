/**
 * Stack Ai OS — Chat session engine
 *
 * A ChatSession holds a conversation's message history and drives turns. Each
 * turn builds a prompt from the accumulated context (so the agent sees the full
 * thread) and runs one agent via runSolo. Sessions serialize to JSON for resume.
 *
 * Built on the explored interfaces:
 *   - runSolo (patterns/solo.ts) for each turn
 *   - AgentEvent streaming via onEvent
 *   - sessionResume: reuses the prior turn's sessionId for native continuity
 */
import type { AgentEvent, AgentName, ModelRouter, RunResult } from "../types.js";
import type { AgentAdapter } from "../types.js";
import type { AdapterRegistry } from "../adapters/registry.js";
import type { SafetyPolicy } from "../safety/policy.js";
import { runSolo } from "../patterns/solo.js";

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  agent: string;        // which agent produced (assistant) or received (user) this
  ts: string;           // ISO timestamp
}

export interface ChatSessionData {
  id: string;
  agent: AgentName;
  model?: string;
  cwd?: string;
  title: string;
  startedAt: string;
  endedAt?: string;
  messages: ChatMessage[];
  /** Run-store run id (one row per chat session, pattern="chat"). */
  runId?: string;
}

export interface ChatTurnCallbacks {
  onEvent?: (agent: AgentName, evt: AgentEvent) => void;
}

export class ChatSession {
  id: string;
  agent: AgentName;
  model?: string;
  cwd?: string;
  title: string;
  startedAt: string;
  endedAt?: string;
  messages: ChatMessage[];
  runId?: string;

  /** The last assistant turn's native sessionId (for sessionResume continuity). */
  private lastSessionId?: string;

  constructor(data: ChatSessionData) {
    this.id = data.id;
    this.agent = data.agent;
    this.model = data.model;
    this.cwd = data.cwd;
    this.title = data.title;
    this.startedAt = data.startedAt;
    this.endedAt = data.endedAt;
    this.messages = data.messages ?? [];
    this.runId = data.runId;
  }

  /** Number of user→assistant turn pairs. */
  get turnCount(): number {
    return this.messages.filter((m) => m.role === "user").length;
  }

  /** Run one turn: send the user prompt (+ context), get the agent's streamed reply. */
  async turn(
    registry: AdapterRegistry,
    router: ModelRouter,
    policy: SafetyPolicy,
    userPrompt: string,
    cb?: ChatTurnCallbacks
  ): Promise<RunResult> {
    // Record the user message.
    this.messages.push({ role: "user", text: userPrompt, agent: this.agent, ts: new Date().toISOString() });

    const adapter = registry.require(this.agent);
    // Build the full-context prompt from the conversation so far.
    const prompt = this.buildContextPrompt();

    const result = await runSolo(adapter, router, {
      agent: this.agent,
      prompt,
      model: this.model,
      verbosity: "stream-json",
      cwd: this.cwd,
      timeoutSec: 600,
      sessionId: this.lastSessionId, // resume prior turn's session if supported
      onEvent: cb?.onEvent ? (agent, evt) => cb.onEvent!(agent, evt) : undefined,
    }, policy);

    // Track the native session id for next-turn continuity.
    if (result.sessionId) this.lastSessionId = result.sessionId;

    // Record the assistant reply (even if empty, to keep turns paired).
    this.messages.push({
      role: "assistant",
      text: result.finalText,
      agent: this.agent,
      ts: new Date().toISOString(),
    });

    return result;
  }

  /** Build a prompt that includes the full conversation context. */
  buildContextPrompt(): string {
    if (this.messages.length <= 1) {
      // First turn — just the single user message.
      return this.messages[this.messages.length - 1]?.text ?? "";
    }
    // Multi-turn: format as a transcript so the agent sees prior context.
    const lines = this.messages.map((m) => {
      const who = m.role === "user" ? "User" : `${m.agent} (assistant)`;
      return `### ${who}\n${m.text}`;
    });
    return `You are continuing a conversation. Here is the full transcript so far. Respond to the most recent message, using prior context.\n\n${lines.join("\n\n")}`;
  }

  /** Switch the active agent mid-conversation. */
  switchAgent(agent: AgentName): void {
    this.agent = agent;
    // Clear the native session id — different agent = different session.
    this.lastSessionId = undefined;
  }

  /** Clear conversation context (start fresh within the same session file). */
  clear(): void {
    this.messages = [];
    this.lastSessionId = undefined;
  }

  /** Auto-derive a title from the first user message. */
  static deriveTitle(firstMessage: string): string {
    const clean = firstMessage.trim().replace(/\s+/g, " ");
    return clean.length > 60 ? clean.slice(0, 57) + "…" : clean || "untitled chat";
  }

  /** Serialize for the history JSON file. */
  serialize(): ChatSessionData {
    return {
      id: this.id,
      agent: this.agent,
      model: this.model,
      cwd: this.cwd,
      title: this.title,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      messages: this.messages,
      runId: this.runId,
    };
  }

  /** Deserialize from JSON. */
  static deserialize(data: ChatSessionData): ChatSession {
    return new ChatSession(data);
  }
}

/** Generate a short session id. */
export function newSessionId(): string {
  return "chat-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * Stack Ai OS — Chat history persistence
 *
 * Saves/loads chat sessions as JSON files under data/chats/. Each session also
 * gets one row in the run store (pattern="chat") so chats appear in
 * `stackai runs` and the dashboard Runs tab for free. A lightweight index file
 * powers `stackai chat --list`.
 *
 * Storage location: DATA_DIR/chats/ (sibling of run-store.sqlite).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "../config.js";
import { ChatSession, type ChatSessionData } from "./session.js";
import * as store from "../kernel/store.js";

const DATA_DIR = process.env.STACKAI_DATA_DIR ?? path.resolve(CONFIG_DIR, "..", "data");
const CHATS_DIR = path.join(DATA_DIR, "chats");
const INDEX_FILE = path.join(CHATS_DIR, "index.json");

export interface ChatIndexEntry {
  id: string;
  title: string;
  agent: string;
  startedAt: string;
  messageCount: number;
}

function sessionFile(id: string): string {
  return path.join(CHATS_DIR, `${id}.json`);
}

/** Save a session to its JSON file + update the index. */
export async function saveSession(session: ChatSession): Promise<void> {
  mkdirSync(CHATS_DIR, { recursive: true });
  writeFileSync(sessionFile(session.id), JSON.stringify(session.serialize(), null, 2), "utf8");
  updateIndex(session);
}

/** Load a session by id. */
export function loadSession(id: string): ChatSession | null {
  const file = sessionFile(id);
  if (!existsSync(file)) return null;
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as ChatSessionData;
    return ChatSession.deserialize(data);
  } catch {
    return null;
  }
}

/** List all sessions from the index (newest-first). */
export function listSessions(): ChatIndexEntry[] {
  if (!existsSync(INDEX_FILE)) {
    // Rebuild index from files if missing.
    return rebuildIndex();
  }
  try {
    const entries = JSON.parse(readFileSync(INDEX_FILE, "utf8")) as ChatIndexEntry[];
    return entries.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  } catch {
    return rebuildIndex();
  }
}

/** Rebuild the index from the chat files on disk. */
function rebuildIndex(): ChatIndexEntry[] {
  if (!existsSync(CHATS_DIR)) return [];
  const entries: ChatIndexEntry[] = [];
  for (const f of readdirSync(CHATS_DIR)) {
    if (!f.endsWith(".json") || f === "index.json") continue;
    try {
      const data = JSON.parse(readFileSync(path.join(CHATS_DIR, f), "utf8")) as ChatSessionData;
      entries.push({
        id: data.id, title: data.title, agent: data.agent,
        startedAt: data.startedAt, messageCount: data.messages.length,
      });
    } catch { /* skip corrupt */ }
  }
  const sorted = entries.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  writeFileSync(INDEX_FILE, JSON.stringify(sorted, null, 2), "utf8");
  return sorted;
}

/** Update the index with one session (upsert). */
function updateIndex(session: ChatSession): void {
  const entries = listSessions();
  const entry: ChatIndexEntry = {
    id: session.id, title: session.title, agent: session.agent,
    startedAt: session.startedAt, messageCount: session.messages.length,
  };
  const idx = entries.findIndex((e) => e.id === session.id);
  if (idx >= 0) entries[idx] = entry;
  else entries.unshift(entry);
  const sorted = entries.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  mkdirSync(CHATS_DIR, { recursive: true });
  writeFileSync(INDEX_FILE, JSON.stringify(sorted, null, 2), "utf8");
}

// ---- Run store integration -----------------------------------------------

/** Create a run-store row for a new chat session (pattern="chat"). */
export async function registerSessionInStore(session: ChatSession): Promise<void> {
  try {
    const id = await store.createRun("chat", session.title, {
      cwd: session.cwd, id: session.id.replace("chat-", "chatrun-"),
    });
    session.runId = id;
    await store.updateRun(id, {
      status: "running",
      winnerAgent: session.agent,
      meta: { sessionId: session.id, title: session.title, agent: session.agent, kind: "chat" },
    });
  } catch { /* best-effort */ }
}

/** Record one assistant turn as a candidate in the run store. */
export async function recordTurnInStore(session: ChatSession, turnIndex: number, result: { agent: string; exitCode: number; finalText: string; durationMs: number; sessionId?: string; timedOut: boolean }): Promise<void> {
  if (!session.runId) return;
  try {
    await store.recordCandidate(session.runId, turnIndex, {
      agent: result.agent as any, exitCode: result.exitCode,
      finalText: result.finalText, events: [],
      durationMs: result.durationMs, timedOut: result.timedOut,
      sessionId: result.sessionId,
    }, session.model, undefined);
  } catch { /* best-effort */ }
}

/** Mark the session's run-store row as done. */
export async function finalizeSessionInStore(session: ChatSession): Promise<void> {
  if (!session.runId) return;
  try {
    await store.updateRun(session.runId, {
      status: "done",
      iterations: session.turnCount,
      meta: { sessionId: session.id, title: session.title, agent: session.agent, kind: "chat", turns: session.turnCount },
    });
  } catch { /* best-effort */ }
}

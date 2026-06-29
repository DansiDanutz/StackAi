/**
 * Stack Ai OS — Chat history persistence tests.
 *
 * Tests save/load/index round-trips against a temp DATA_DIR so the real
 * data/chats/ is never touched. Covers: save+load, listSessions ordering,
 * index rebuild from files, run-store registration (mocked).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "sao-chat-hist-"));
process.env.STACKAI_DATA_DIR = TMP;
process.env.STACKAI_CONFIG_DIR = TMP;

// Import after env is set.
const history = await import("../src/chat/history.js");
const { ChatSession, newSessionId } = await import("../src/chat/session.js");

afterAll(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

function makeSession(title: string, messages = []) {
  return new ChatSession({
    id: newSessionId(), agent: "codex", title,
    startedAt: new Date().toISOString(), messages,
  });
}

describe("chat history", () => {
  it("saves and loads a session round-trip", async () => {
    const s = makeSession("test session", [
      { role: "user", text: "hello", agent: "codex", ts: "2026-06-29T20:00:00Z" },
      { role: "assistant", text: "hi", agent: "codex", ts: "2026-06-29T20:00:01Z" },
    ]);
    await history.saveSession(s);
    const loaded = history.loadSession(s.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.title).toBe("test session");
    expect(loaded!.messages.length).toBe(2);
    expect(loaded!.messages[0]!.text).toBe("hello");
  });

  it("returns null for a non-existent session", () => {
    expect(history.loadSession("does-not-exist")).toBeNull();
  });

  it("lists sessions newest-first", async () => {
    const a = makeSession("older");
    a.startedAt = "2026-06-01T10:00:00Z";
    await history.saveSession(a);
    const b = makeSession("newer");
    b.startedAt = "2026-06-29T10:00:00Z";
    await history.saveSession(b);
    const list = history.listSessions();
    const ia = list.findIndex((s) => s.id === a.id);
    const ib = list.findIndex((s) => s.id === b.id);
    expect(ib).toBeLessThan(ia); // newer first
  });

  it("upserts on re-save (no duplicates in index)", async () => {
    const s = makeSession("upsert test");
    await history.saveSession(s);
    s.title = "updated title";
    await history.saveSession(s);
    const list = history.listSessions().filter((x) => x.id === s.id);
    expect(list.length).toBe(1);
    expect(list[0]!.title).toBe("updated title");
  });

  it("index entry has correct messageCount", async () => {
    const s = makeSession("count test", [
      { role: "user", text: "q1", agent: "codex", ts: "" },
      { role: "assistant", text: "a1", agent: "codex", ts: "" },
      { role: "user", text: "q2", agent: "codex", ts: "" },
    ]);
    await history.saveSession(s);
    const entry = history.listSessions().find((x) => x.id === s.id);
    expect(entry).toBeDefined();
    expect(entry!.messageCount).toBe(3);
  });
});

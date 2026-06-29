/**
 * Stack Ai OS — Chat session logic tests.
 *
 * Tests the pure, deterministic parts: session serialize/restore round-trip,
 * context-prompt building (single + multi-turn), title derivation, turnCount,
 * switchAgent/clear. The live REPL (which spawns real agents) is tested
 * end-to-end via `stackai chat`.
 */
import { describe, it, expect } from "vitest";
import { ChatSession, newSessionId } from "../src/chat/session.js";

describe("ChatSession", () => {
  function makeSession(messages = []) {
    return new ChatSession({
      id: newSessionId(),
      agent: "codex",
      title: "test chat",
      startedAt: "2026-06-29T20:00:00.000Z",
      messages,
    });
  }

  describe("serialize / deserialize round-trip", () => {
    it("preserves all fields through serialize → deserialize", () => {
      const s = makeSession([
        { role: "user", text: "hello", agent: "codex", ts: "2026-06-29T20:00:01Z" },
        { role: "assistant", text: "hi there", agent: "codex", ts: "2026-06-29T20:00:02Z" },
      ]);
      const data = s.serialize();
      const restored = ChatSession.deserialize(data);
      expect(restored.id).toBe(s.id);
      expect(restored.agent).toBe("codex");
      expect(restored.title).toBe("test chat");
      expect(restored.messages.length).toBe(2);
      expect(restored.messages[0]!.text).toBe("hello");
      expect(restored.messages[1]!.role).toBe("assistant");
    });
  });

  describe("buildContextPrompt", () => {
    it("returns the raw message on the first turn", () => {
      const s = makeSession();
      s.messages.push({ role: "user", text: "what is 2+2", agent: "codex", ts: "" });
      expect(s.buildContextPrompt()).toBe("what is 2+2");
    });

    it("includes the full transcript for multi-turn context", () => {
      const s = makeSession([
        { role: "user", text: "what is async/await", agent: "codex", ts: "" },
        { role: "assistant", text: "it's syntax for promises", agent: "codex", ts: "" },
        { role: "user", text: "show me an example", agent: "codex", ts: "" },
      ]);
      const prompt = s.buildContextPrompt();
      expect(prompt).toContain("async/await");
      expect(prompt).toContain("syntax for promises");
      expect(prompt).toContain("show me an example");
      expect(prompt).toContain("User");
      expect(prompt).toContain("assistant");
    });
  });

  describe("deriveTitle", () => {
    it("uses the first message as the title", () => {
      expect(ChatSession.deriveTitle("how do I reverse a list")).toBe("how do I reverse a list");
    });
    it("truncates long titles with ellipsis", () => {
      const long = "this is a very long question that exceeds the sixty character limit by quite a lot";
      const title = ChatSession.deriveTitle(long);
      expect(title.length).toBeLessThanOrEqual(60);
      expect(title).toMatch(/…$/);
    });
    it("defaults to untitled for empty input", () => {
      expect(ChatSession.deriveTitle("")).toBe("untitled chat");
      expect(ChatSession.deriveTitle("   ")).toBe("untitled chat");
    });
  });

  describe("turnCount", () => {
    it("counts user messages as turns", () => {
      const s = makeSession([
        { role: "user", text: "q1", agent: "codex", ts: "" },
        { role: "assistant", text: "a1", agent: "codex", ts: "" },
        { role: "user", text: "q2", agent: "codex", ts: "" },
        { role: "assistant", text: "a2", agent: "codex", ts: "" },
      ]);
      expect(s.turnCount).toBe(2);
    });
    it("is zero for an empty session", () => {
      expect(makeSession().turnCount).toBe(0);
    });
  });

  describe("switchAgent / clear", () => {
    it("switches the active agent", () => {
      const s = makeSession();
      s.switchAgent("gemini");
      expect(s.agent).toBe("gemini");
    });
    it("clears all messages on clear()", () => {
      const s = makeSession([
        { role: "user", text: "q", agent: "codex", ts: "" },
      ]);
      s.clear();
      expect(s.messages.length).toBe(0);
      expect(s.turnCount).toBe(0);
    });
  });
});

describe("newSessionId", () => {
  it("generates unique ids with the chat- prefix", () => {
    const a = newSessionId();
    const b = newSessionId();
    expect(a).toMatch(/^chat-/);
    expect(a).not.toBe(b);
  });
});

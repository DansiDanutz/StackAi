/**
 * Stack Ai OS — Safety policy tests.
 *
 * Verifies the cautious-by-default posture, posture escalation rules,
 * cwd allowlist enforcement, and blocked-command guardrails (which must hold
 * even in full-auto).
 */
import { describe, it, expect } from "vitest";
import { SafetyPolicy } from "../src/safety/policy.js";
import type { RunRequest } from "../src/types.js";

describe("SafetyPolicy", () => {
  it("defaults to cautious", () => {
    const p = new SafetyPolicy();
    expect(p.posture).toBe("cautious");
    expect(p.isFullAuto()).toBe(false);
  });

  it("resolves effective posture from request", () => {
    const p = new SafetyPolicy({ posture: "cautious" });
    const req: RunRequest = { agent: "claude", prompt: "hi", posture: "full-auto" };
    expect(p.effectivePosture(req)).toBe("full-auto");
    expect(p.effectivePosture({ agent: "claude", prompt: "hi" })).toBe("cautious");
  });

  it("full-auto policy stays full-auto", () => {
    const p = new SafetyPolicy({ posture: "full-auto" });
    expect(p.effectivePosture({ agent: "claude", prompt: "hi" })).toBe("full-auto");
  });

  it("rejects prompts matching blocked patterns even in full-auto", () => {
    const p = new SafetyPolicy({ posture: "full-auto" });
    const blocked = [
      "run: rm -rf /",
      "please do rm -rf ~",
      "git push --force origin main",
      "execute :(){ :|:& };:",
    ];
    for (const prompt of blocked) {
      expect(() => p.validate({ agent: "claude", prompt })).toThrow(/guardrail|allowlist/i);
    }
  });

  it("allows benign prompts", () => {
    const p = new SafetyPolicy();
    expect(() => p.validate({ agent: "claude", prompt: "refactor auth.ts to use PKCE" })).not.toThrow();
  });

  it("enforces cwd allowlist when set", () => {
    const p = new SafetyPolicy({ cwdAllowlist: ["/tmp/proj"] });
    expect(() => p.validate({ agent: "claude", prompt: "ok", cwd: "/tmp/proj" })).not.toThrow();
    expect(() => p.validate({ agent: "claude", prompt: "ok", cwd: "/tmp/proj/sub" })).not.toThrow();
    expect(() => p.validate({ agent: "claude", prompt: "ok", cwd: "/etc" })).toThrow(/allowlist/);
  });
});

/**
 * Stack Ai OS — Fugu adapter tests.
 *
 * Tests model resolution and capability declarations (pure logic — no network).
 * The HTTP run() path is exercised in integration with a real key; here we lock
 * the contract: Fugu is cloud-only, no MCP/ACP/tools, and resolves tiers.
 */
import { describe, it, expect } from "vitest";
import { FuguAdapter } from "../src/adapters/fugu.js";

describe("FuguAdapter", () => {
  const a = new FuguAdapter();

  describe("capabilities", () => {
    it("is cloud and has no file tools / MCP / ACP", () => {
      expect(a.capabilities.mcpClient).toBe(false);
      expect(a.capabilities.mcpServer).toBe(false);
      expect(a.capabilities.acpServer).toBe(false);
      expect(a.capabilities.fullAuto).toBe(false);
      expect(a.capabilities.sessionResume).toBe(false);
    });
    it("can select models and stream", () => {
      expect(a.capabilities.modelSelection).toBe(true);
      expect(a.capabilities.jsonStream).toBe(true);
    });
    it("is flagged cloud", () => {
      expect((a as any).isCloud).toBe(true);
    });
  });

  describe("resolveModel", () => {
    it("defaults to fugu (fast tier)", () => {
      expect(a.resolveModel("auto")).toBe("fugu");
      expect(a.resolveModel("")).toBe("fugu");
    });
    it("resolves the ultra tier", () => {
      expect(a.resolveModel("ultra")).toBe("fugu-ultra");
      expect(a.resolveModel("fugu-ultra")).toBe("fugu-ultra");
    });
    it("resolves the fast tier", () => {
      expect(a.resolveModel("fugu")).toBe("fugu");
      expect(a.resolveModel("fast")).toBe("fugu");
    });
    it("passes through unknown ids", () => {
      expect(a.resolveModel("custom-model")).toBe("custom-model");
    });
  });

  describe("buildCommand", () => {
    it("returns a marker (cloud — no child process)", () => {
      const r = a.buildCommand({ agent: "fugu", prompt: "x" } as never, { resolve: () => undefined, aliases: () => [], describe: () => [] });
      expect(r.cmd).toBe("fugu-api");
    });
  });
});

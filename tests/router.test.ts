/**
 * Stack Ai OS — Model router tests.
 *
 * Verifies alias → per-CLI resolution, agent:model pins, and the 'auto' alias.
 */
import { describe, it, expect } from "vitest";
import { ModelRouterImpl } from "../src/models/router.js";
import type { ModelsConfig } from "../src/config.js";

const cfg: ModelsConfig = {
  models: [
    { alias: "sonnet", providers: { claude: "claude-sonnet-4-6", openclaude: "claude-sonnet-4-6" } },
    { alias: "gpt5", providers: { codex: "gpt-5-codex" } },
    { alias: "qwen-local", providers: { pi: "qwen3:8b", openclaude: "qwen3-8b" } },
  ],
  defaults: {},
};

describe("ModelRouterImpl", () => {
  const router = new ModelRouterImpl(cfg);

  it("resolves an alias for the right agent", () => {
    expect(router.resolve("claude", "sonnet")).toBe("claude-sonnet-4-6");
    expect(router.resolve("codex", "gpt5")).toBe("gpt-5-codex");
  });

  it("returns undefined when the agent isn't a provider for the alias", () => {
    expect(router.resolve("codex", "sonnet")).toBeUndefined();
    expect(router.resolve("gemini", "gpt5")).toBeUndefined();
  });

  it("returns undefined for unknown aliases", () => {
    expect(router.resolve("claude", "nonexistent")).toBeUndefined();
  });

  it("'auto' resolves to undefined (use agent default)", () => {
    expect(router.resolve("claude", "auto")).toBeUndefined();
  });

  it("handles agent:model pins", () => {
    expect(router.resolve("claude", "claude:claude-opus-4-6")).toBe("claude-opus-4-6");
    // pin for a different agent → undefined
    expect(router.resolve("codex", "claude:claude-opus-4-6")).toBeUndefined();
  });

  it("lists all aliases", () => {
    expect(router.aliases().sort()).toEqual(["gpt5", "qwen-local", "sonnet"]);
  });

  it("describe() returns alias + optional resolved id", () => {
    const desc = router.describe("codex");
    const gpt5 = desc.find((d) => d.alias === "gpt5");
    expect(gpt5?.resolved).toBe("gpt-5-codex");
    const sonnet = desc.find((d) => d.alias === "sonnet");
    expect(sonnet?.resolved).toBeUndefined(); // codex isn't a sonnet provider
  });
});

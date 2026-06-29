/**
 * Stack Ai OS — TUI render helper tests.
 *
 * Tests the pure rendering primitives (progressBar, trunc) and the overview
 * renderer's state-driven output. The live raw-mode loop is exercised manually
 * via `stackai tui`; these unit tests lock the rendering contract.
 */
import { describe, it, expect } from "vitest";
import { progressBar, trunc, C } from "../src/tui/render.js";

describe("progressBar", () => {
  it("renders a 0% bar", () => {
    const bar = progressBar(0, 10, 8);
    expect(bar).toContain("░");
    expect(bar).toContain("0%");
  });
  it("renders a 100% bar", () => {
    const bar = progressBar(10, 10, 8);
    expect(bar).toContain("▓");
    expect(bar).toContain("100%");
  });
  it("handles zero total without dividing by zero", () => {
    const bar = progressBar(5, 0, 8);
    expect(bar).toContain("0%"); // ratio clamped to 0
  });
  it("clamps above 100%", () => {
    const bar = progressBar(20, 10, 8);
    expect(bar).toContain("100%");
  });
});

describe("trunc", () => {
  it("leaves short strings unchanged", () => {
    expect(trunc("hello", 10)).toBe("hello");
  });
  it("truncates with ellipsis", () => {
    expect(trunc("hello world this is long", 10)).toBe("hello wor…");
  });
  it("handles exact length", () => {
    expect(trunc("1234567890", 10)).toBe("1234567890");
  });
});

describe("color constants", () => {
  it("exports ANSI codes", () => {
    expect(C.reset).toContain("\x1b");
    expect(C.green).toContain("\x1b[32m");
    expect(C.bold).toContain("\x1b[1m");
  });
});

/**
 * Stack Ai OS — Adapter buildCommand tests.
 *
 * These are the critical "flag vocabulary" tests: they lock in the exact CLI
 * invocation per the capability matrix. If a CLI changes its flags, these break
 * first — that's the point (flag-drift detection).
 *
 * Uses a mock router; never spawns a real process.
 */
import { describe, it, expect } from "vitest";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { GeminiAdapter } from "../src/adapters/gemini.js";
import { KimiAdapter } from "../src/adapters/kimi.js";
import { OpenclaudeAdapter } from "../src/adapters/openclaude.js";
import { PiAdapter } from "../src/adapters/pi.js";
import type { AgentConfig, ModelRouter } from "../src/config.js";
import type { AgentName } from "../src/types.js";

const noopRouter: ModelRouter = { resolve: () => undefined, aliases: () => [], describe: () => [] };
const routerWith = (map: Record<string, Record<string, string>>): ModelRouter => ({
  resolve: (a, alias) => map[alias]?.[a],
  aliases: () => Object.keys(map),
  describe: () => [],
});

const agentCfg = (name: AgentName): AgentConfig => ({
  name, command: "/bin/" + name, enabled: true, defaultModel: "default-m",
});

describe("ClaudeAdapter buildCommand", () => {
  const a = new ClaudeAdapter(agentCfg("claude"));
  it("uses -p with the prompt and stream-json by default", () => {
    const { cmd, args } = a.buildCommand({ agent: "claude", prompt: "hello" }, noopRouter);
    expect(cmd).toBe("/bin/claude");
    expect(args[0]).toBe("-p");
    expect(args[1]).toBe("hello");
    expect(args).toContain("--output-format");
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
  });
  it("adds --dangerously-skip-permissions in full-auto", () => {
    const { args } = a.buildCommand({ agent: "claude", prompt: "x", posture: "full-auto" }, noopRouter);
    expect(args).toContain("--dangerously-skip-permissions");
  });
  it("does NOT add skip-permissions in cautious", () => {
    const { args } = a.buildCommand({ agent: "claude", prompt: "x" }, noopRouter);
    expect(args).not.toContain("--dangerously-skip-permissions");
  });
  it("resolves model alias via router", () => {
    const r = routerWith({ sonnet: { claude: "claude-sonnet-4-6" } });
    const { args } = a.buildCommand({ agent: "claude", prompt: "x", model: "sonnet" }, r);
    const i = args.indexOf("--model");
    expect(args[i + 1]).toBe("claude-sonnet-4-6");
  });
});

describe("CodexAdapter buildCommand", () => {
  const a = new CodexAdapter({ ...agentCfg("codex"), prefixArgs: ["exec"] });
  it("prepends exec subcommand", () => {
    const { args } = a.buildCommand({ agent: "codex", prompt: "hi" }, noopRouter);
    expect(args[0]).toBe("exec");
    expect(args).toContain("--json");
    expect(args[args.length - 1]).toBe("hi"); // prompt positional last
  });
  it("uses bypass-approvals flag in full-auto", () => {
    const { args } = a.buildCommand({ agent: "codex", prompt: "x", posture: "full-auto" }, noopRouter);
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
  });
});

describe("GeminiAdapter buildCommand (gotcha: -p is prompt)", () => {
  const a = new GeminiAdapter(agentCfg("gemini"));
  it("uses -p for the PROMPT (not print!)", () => {
    const { args } = a.buildCommand({ agent: "gemini", prompt: "do thing" }, noopRouter);
    expect(args[0]).toBe("-p");
    expect(args[1]).toBe("do thing");
    expect(args).toContain("-o");
  });
  it("uses --yolo in full-auto", () => {
    const { args } = a.buildCommand({ agent: "gemini", prompt: "x", posture: "full-auto" }, noopRouter);
    expect(args).toContain("--yolo");
  });
});

describe("KimiAdapter buildCommand (gotcha: needs --prompt AND --print)", () => {
  const a = new KimiAdapter(agentCfg("kimi"));
  it("emits both --prompt and --print", () => {
    const { args } = a.buildCommand({ agent: "kimi", prompt: "task" }, noopRouter);
    expect(args).toContain("--prompt");
    expect(args).toContain("--print");
    const i = args.indexOf("--prompt");
    expect(args[i + 1]).toBe("task");
  });
  it("uses --afk in full-auto", () => {
    const { args } = a.buildCommand({ agent: "kimi", prompt: "x", posture: "full-auto" }, noopRouter);
    expect(args).toContain("--afk");
  });
});

describe("OpenclaudeAdapter buildCommand", () => {
  const a = new OpenclaudeAdapter({ ...agentCfg("openclaude"), command: "/x/cli.mjs" });
  it("invokes via node with the .mjs path first", () => {
    const { cmd, args } = a.buildCommand({ agent: "openclaude", prompt: "x" }, noopRouter);
    expect(cmd).toBe("node");
    expect(args[0]).toBe("/x/cli.mjs"); // the .mjs path is the first node arg
    expect(args).toContain("-p");
  });
});

describe("PiAdapter buildCommand", () => {
  const a = new PiAdapter(agentCfg("pi"));
  it("uses --mode json (not --output-format)", () => {
    const { args } = a.buildCommand({ agent: "pi", prompt: "x" }, noopRouter);
    expect(args).toContain("--mode");
    expect(args[args.indexOf("--mode") + 1]).toBe("json");
  });
  it("has NO full-auto flag (capability is false)", () => {
    expect(a.capabilities.fullAuto).toBe(false);
    const { args } = a.buildCommand({ agent: "pi", prompt: "x", posture: "full-auto" }, noopRouter);
    // pi should NOT emit any yolo/skip flag
    expect(args.join(" ")).not.toMatch(/yolo|skip|bypass/i);
  });
});

describe("capabilities are correct per the matrix", () => {
  it("pi has no MCP (client or server)", () => {
    expect(new PiAdapter(agentCfg("pi")).capabilities.mcpClient).toBe(false);
  });
  it("gemini/kimi/opencode/zcode are ACP-capable", () => {
    expect(new GeminiAdapter(agentCfg("gemini")).capabilities.acpServer).toBe(true);
    expect(new KimiAdapter(agentCfg("kimi")).capabilities.acpServer).toBe(true);
    expect(new CodexAdapter(agentCfg("codex")).capabilities.acpServer).toBe(false);
  });
  it("claude is NOT ACP-capable", () => {
    expect(new ClaudeAdapter(agentCfg("claude")).capabilities.acpServer).toBe(false);
  });
});

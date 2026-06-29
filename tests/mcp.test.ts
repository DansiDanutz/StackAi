/**
 * Stack Ai OS — MCP client capability-gating tests.
 *
 * Verifies the inject logic: MCP-capable agents receive shared servers;
 * non-MCP agents (pi, zcode) receive none; disabled/needsAuth servers are
 * skipped; includeSelf toggle works.
 */
import { describe, it, expect } from "vitest";
import { resolveInjectableServers, SHARED_MCP_SERVERS } from "../src/mcp/client.js";

describe("MCP client injection", () => {
  it("injects shared servers for an MCP-capable agent", () => {
    const servers = resolveInjectableServers("claude", { mcpClient: true });
    expect(Object.keys(servers).length).toBeGreaterThan(0);
    expect(servers).toHaveProperty("context7");
    expect(servers).toHaveProperty("playwright");
  });

  it("injects NOTHING for a non-MCP agent (pi)", () => {
    const servers = resolveInjectableServers("pi", { mcpClient: false });
    expect(Object.keys(servers).length).toBe(0);
  });

  it("includes the Stack Ai OS self-server by default", () => {
    const servers = resolveInjectableServers("codex", { mcpClient: true });
    expect(servers).toHaveProperty("stack-ai-os");
  });

  it("honors includeSelf=false to omit the self-server", () => {
    const servers = resolveInjectableServers("codex", { mcpClient: true }, { includeSelf: false });
    expect(servers).not.toHaveProperty("stack-ai-os");
  });

  it("skips servers marked needsAuth", () => {
    const servers = resolveInjectableServers("claude", { mcpClient: true });
    for (const [, entry] of Object.entries(servers)) {
      expect(entry.needsAuth).toBeFalsy();
    }
  });

  it("skips servers marked enabled=false", () => {
    const before = Object.keys(SHARED_MCP_SERVERS).length;
    expect(before).toBeGreaterThan(0);
    // All injected servers must be enabled (default true)
    const servers = resolveInjectableServers("claude", { mcpClient: true });
    for (const [, entry] of Object.entries(servers)) {
      expect(entry.enabled).not.toBe(false);
    }
  });
});

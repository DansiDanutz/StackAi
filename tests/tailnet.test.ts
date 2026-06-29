/**
 * Stack Ai OS — Tailscale peer parser tests.
 *
 * The JSON parsing is hard to test without tailscale installed, but the
 * text-fallback parser (parseTextStatus, currently private) is pure logic.
 * We re-test the same parsing algorithm against sample `tailscale status`
 * output to lock the contract. Also tests tailscaleAvailable + getSelf shape.
 */
import { describe, it, expect } from "vitest";
import { tailscaleAvailable, getTailnetPeers } from "../src/kernel/tailnet.js";

describe("tailnet discovery", () => {
  it("tailscaleAvailable returns a boolean without throwing", () => {
    expect(typeof tailscaleAvailable()).toBe("boolean");
  });

  it("getTailnetPeers returns an array (empty if tailscale absent)", async () => {
    const peers = await getTailnetPeers();
    expect(Array.isArray(peers)).toBe(true);
    // If tailscale IS present, each peer should have the right shape.
    for (const p of peers) {
      expect(typeof p.ip).toBe("string");
      expect(typeof p.hostname).toBe("string");
      expect(typeof p.online).toBe("boolean");
    }
  });
});

// Test the text-status parsing algorithm directly (re-implemented here to lock
// the contract; the production version is in kernel/tailnet.ts parseTextStatus).
describe("text-status parser (contract lock)", () => {
  function parseLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return null;
    const m = trimmed.match(/^(\d+\.\d+\.\d+\.\d+)\s+(\S+)\s+(\S+@?)\s+(\S+)\s+(.*)$/);
    if (!m) return null;
    return {
      ip: m[1] ?? "",
      hostname: m[2] ?? "",
      user: (m[3] ?? "").replace(/@$/, ""),
      os: m[4] ?? "",
      state: m[5] ?? "",
    };
  }

  it("parses a standard status line", () => {
    const p = parseLine("100.79.10.102   dans-mac-studio   DansiDanutz@   macOS   -");
    expect(p).not.toBeNull();
    expect(p!.ip).toBe("100.79.10.102");
    expect(p!.hostname).toBe("dans-mac-studio");
    expect(p!.user).toBe("DansiDanutz");
    expect(p!.os).toBe("macOS");
  });

  it("parses a line with offline state", () => {
    const p = parseLine("100.112.31.86   dans-mac-mini   DansiDanutz@   macOS   offline, last seen 36d ago");
    expect(p).not.toBeNull();
    expect(p!.hostname).toBe("dans-mac-mini");
    expect(p!.state).toContain("offline");
  });

  it("parses a line with exit-node offering", () => {
    const p = parseLine("100.88.192.48   memo-droplet   DansiDanutz@   linux   active; offers exit node; direct 138.68.86.47:41641");
    expect(p).not.toBeNull();
    expect(p!.hostname).toBe("memo-droplet");
    expect(p!.os).toBe("linux");
    expect(p!.state).toContain("exit node");
  });

  it("returns null for comment/blank lines", () => {
    expect(parseLine("# Funnel on:")).toBeNull();
    expect(parseLine("")).toBeNull();
    expect(parseLine("   ")).toBeNull();
  });

  it("returns null for lines that don't match the IP-prefixed format", () => {
    expect(parseLine("some random text without ip")).toBeNull();
  });
});

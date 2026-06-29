/**
 * Stack Ai OS — Tailscale fleet discovery
 *
 * Discovers tailnet peers via `tailscale status` so the dashboard and scheduler
 * know which remote machines can host agents. This is read-only discovery;
 * Phase 4 routing (executing on a remote peer over the tailnet) builds on this.
 *
 * Parses the `tailscale status` human format, which is stable across versions:
 *   <ip>   <hostname>   <user>   <os>   <state>
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

export interface TailnetPeer {
  ip: string;
  hostname: string;
  user: string;
  os: string;
  /** raw state line, e.g. "active; offers exit node; direct 1.2.3.4:41641" */
  state: string;
  online: boolean;
  /** True if this peer offers an exit node / subnet route. */
  offersExitNode: boolean;
}

export function tailscaleAvailable(): boolean {
  return existsSync("/opt/homebrew/bin/tailscale") || existsSync("/usr/local/bin/tailscale") || which("tailscale") !== null;
}

function which(bin: string): string | null {
  try {
    return execSync(`command -v ${bin}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/** Return this machine's own tailnet identity, or null. */
export function getSelf(): TailnetPeer | null {
  try {
    const raw = execSync("tailscale status --json", { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"] });
    const data = JSON.parse(raw);
    const s = data.Self;
    if (!s) return null;
    return {
      ip: Array.isArray(s.TailscaleIPs) ? (s.TailscaleIPs[0] ?? "") : "",
      hostname: s.HostName ?? "",
      user: (data.User?.[s.UserID]?.toString?.() ?? "").split("@")[0] ?? "",
      os: s.OS ?? "macOS",
      state: "self",
      online: true,
      offersExitNode: Boolean(s.ExitNodeOption),
    };
  } catch {
    return null;
  }
}

/** List all tailnet peers (excluding self). Empty if tailscale is absent. */
export async function getTailnetPeers(): Promise<TailnetPeer[]> {
  if (!tailscaleAvailable()) return [];
  // Prefer --json for robust parsing; fall back to text.
  try {
    const raw = execSync("tailscale status --json", {
      encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"],
    });
    const data = JSON.parse(raw);
    const peers: TailnetPeer[] = [];
    for (const p of Object.values<any>(data.Peer ?? {})) {
      peers.push({
        ip: Array.isArray(p.TailscaleIPs) ? (p.TailscaleIPs[0] ?? "") : "",
        hostname: p.HostName ?? "",
        user: (data.User?.[p.UserID]?.toString?.() ?? "").split("@")[0] ?? "",
        os: p.OS ?? "",
        state: p.Online ? "active" : "offline",
        online: Boolean(p.Online),
        offersExitNode: Boolean(p.ExitNodeOption),
      });
    }
    return peers.sort((a, b) => a.hostname.localeCompare(b.hostname));
  } catch {
    // Fall back to text parse.
    return parseTextStatus();
  }
}

/** Parse `tailscale status` text output as a fallback. */
function parseTextStatus(): TailnetPeer[] {
  try {
    const raw = execSync("tailscale status", { encoding: "utf8", timeout: 10000 });
    const peers: TailnetPeer[] = [];
    for (const line of raw.split("\n")) {
      // skip comments and blank lines
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const m = trimmed.match(/^(\d+\.\d+\.\d+\.\d+)\s+(\S+)\s+(\S+@?)\s+(\S+)\s+(.*)$/);
      if (!m) continue;
      const ip = m[1] ?? "";
      const hostname = m[2] ?? "";
      const user = (m[3] ?? "").replace(/@$/, "");
      const os = m[4] ?? "";
      const state = m[5] ?? "";
      if (!ip || !hostname) continue;
      peers.push({
        ip, hostname, user, os,
        state,
        online: !/offline/i.test(state),
        offersExitNode: /exit node/i.test(state),
      });
    }
    return peers;
  } catch {
    return [];
  }
}

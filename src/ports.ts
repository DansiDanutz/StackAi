/**
 * Stack Ai OS — Port assignments (single source of truth)
 *
 * Ports were chosen by scanning all live listeners on this Mac Studio and the
 * known fleet ports (8997 Claude Balancer, 18789 OpenClaw Gateway, 11434
 * Ollama, 6379 Redis, 3210 Paperclip, 37777 claude-mem worker) and picking a
 * free band that is also BELOW the macOS ephemeral range (49152–65535) so the
 * OS can never hand these out for outbound connections.
 *
 * Reserved band: 42700–42799 (the "SAO" band). All Stack Ai OS services live
 * here. Verified free 2026-06-29.
 */
export const PORTS = {
  /** Web dashboard + REST API + WebSocket (live events). */
  dashboard: 42719,
  /** MCP server (stdio over a TCP bridge when exposed to the tailnet). */
  mcpBridge: 42720,
  /** Fleet heartbeat / agent discovery on the tailnet. */
  fleetDiscovery: 42721,
} as const;

export type PortName = keyof typeof PORTS;

/** Resolve a port, allowing STACKAI_PORT_<NAME> env override. */
export function port(name: PortName): number {
  const envKey = `STACKAI_PORT_${name.toUpperCase()}`;
  const env = process.env[envKey];
  if (env && /^\d+$/.test(env)) return Number(env);
  return PORTS[name];
}

/** Human-readable local URL for the dashboard. */
export function dashboardUrl(): string {
  return `http://127.0.0.1:${port("dashboard")}`;
}

/** Tailscale HTTPS URL for the dashboard (requires `tailscale serve` setup). */
export function dashboardTailscaleUrl(): string {
  return "https://dans-mac-studio.tailc56ca0.ts.net";
}

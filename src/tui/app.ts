/**
 * Stack Ai OS — TUI main app
 *
 * A live terminal interface for orchestration. Tabs: Overview · Fleet · Runs ·
 * Live. Plus a command palette (Tab) to launch runs, and a status footer with
 * safety posture + keybindings.
 *
 * Launches a background render loop (5Hz) that re-pulls state from the run
 * store + fleet. Keyboard: ←/→ tabs, Tab palette, q/Esc quit, r refresh.
 *
 * Usage: stackai tui
 */
import { stdout } from "node:process";
import { Renderer, C, progressBar, trunc } from "./render.js";
import { Input } from "./input.js";
import { loadConfig } from "../config.js";
import { createRegistry } from "../adapters/registry.js";
import { ModelRouterImpl } from "../models/router.js";
import { defaultPolicy } from "../safety/policy.js";
import * as store from "../kernel/store.js";
import { getTailnetPeers } from "../kernel/tailnet.js";

type Tab = "overview" | "fleet" | "runs" | "live";

interface AppState {
  tab: Tab;
  paletteOpen: boolean;
  paletteText: string;
  liveLog: string[];
  agents: { name: string; displayName: string; capabilities: any }[];
  runs: any[];
  peers: any[];
  posture: string;
  message: string;
}

export async function startTUI(): Promise<void> {
  stdout.write("\x1b[?25l"); // hide cursor
  const renderer = new Renderer();
  const input = new Input();

  const state: AppState = {
    tab: "overview",
    paletteOpen: false,
    paletteText: "",
    liveLog: ["// Stack Ai OS TUI — press Tab for command palette, q to quit"],
    agents: [],
    runs: [],
    peers: [],
    posture: defaultPolicy().posture,
    message: "",
  };

  // Initial data load.
  await refresh(state);

  // Keyboard.
  input.start((e) => {
    if (state.paletteOpen) {
      handlePaletteKey(state, e);
      return;
    }
    switch (e.name) {
      case "q":
      case "escape":
        input.stop();
        renderer.destroy();
        process.exit(0);
        break;
      case "tab":
        state.paletteOpen = true;
        state.paletteText = "";
        break;
      case "right":
      case "l":
        state.tab = nextTab(state.tab);
        break;
      case "left":
      case "h":
        state.tab = prevTab(state.tab);
        break;
      case "r":
        refresh(state).then(() => { state.message = "refreshed"; });
        break;
    }
  });

  // Render loop at ~5Hz.
  const timer = setInterval(async () => {
    render(renderer, state);
    // Periodically refresh data (lightweight).
    if (state.tab === "overview" || state.tab === "runs") {
      await refresh(state).catch(() => {});
    }
  }, 200);

  // Initial render.
  render(renderer, state);

  // Keep alive; cleanup on exit.
  process.on("SIGINT", () => {
    clearInterval(timer);
    input.stop();
    renderer.destroy();
    process.exit(0);
  });
}

function nextTab(t: Tab): Tab {
  const tabs: Tab[] = ["overview", "fleet", "runs", "live"];
  return tabs[(tabs.indexOf(t) + 1) % tabs.length]!;
}
function prevTab(t: Tab): Tab {
  const tabs: Tab[] = ["overview", "fleet", "runs", "live"];
  return tabs[(tabs.indexOf(t) - 1 + tabs.length) % tabs.length]!;
}

function handlePaletteKey(state: AppState, e: any): void {
  if (e.name === "escape") { state.paletteOpen = false; return; }
  if (e.name === "return") {
    state.paletteOpen = false;
    state.message = `would run: ${state.paletteText} (launch via 'stackai run "${state.paletteText}"')`;
    state.liveLog.unshift(`$ ${state.paletteText}`);
    state.paletteText = "";
    return;
  }
  if (e.name === "backspace") {
    state.paletteText = state.paletteText.slice(0, -1);
    return;
  }
  if (e.sequence && e.sequence.length === 1 && /[\x20-\x7e]/.test(e.sequence)) {
    state.paletteText += e.sequence;
  }
}

async function refresh(state: AppState): Promise<void> {
  try {
    const cfg = loadConfig();
    const registry = createRegistry(cfg);
    state.agents = registry.enabled().map((a) => ({
      name: a.name, displayName: a.displayName, capabilities: a.capabilities,
    }));
    void new ModelRouterImpl(cfg.models);
    state.runs = await store.listRuns(15);
    state.peers = await getTailnetPeers();
  } catch { /* keep last state */ }
}

function render(r: Renderer, s: AppState): void {
  r.begin();

  // Header
  r.line(`${C.bold}Stack ${C.cyan}Ai OS${C.reset}  ${C.gray}— multi-CLI orchestration${C.reset}`);
  const tabs = ["overview", "fleet", "runs", "live"];
  const tabLine = tabs.map((t) => (s.tab === t ? `${C.cyan}${C.bold}[${t}]${C.reset}` : `${C.gray} ${t} ${C.reset}`)).join("  ");
  r.line(tabLine);
  r.line(C.gray + "─".repeat(Math.min(stdout.columns || 80, 100)) + C.reset);
  r.line();

  // Tab content
  switch (s.tab) {
    case "overview": renderOverview(r, s); break;
    case "fleet": renderFleet(r, s); break;
    case "runs": renderRuns(r, s); break;
    case "live": renderLive(r, s); break;
  }

  r.line();

  // Command palette overlay
  if (s.paletteOpen) {
    r.line(`${C.bgBlue}${C.bold} ❯ ${s.paletteText}${C.reset}${C.gray}_${C.reset}`);
    r.line(C.gray + "  enter to run · esc to cancel" + C.reset);
    r.line();
  }

  // Footer
  const postureColor = s.posture === "full-auto" ? C.red : C.green;
  r.line(`${C.gray}┤ ${postureColor}${s.posture}${C.reset} ${C.gray}│${C.reset} ${C.gray}←/→ tabs · Tab palette · r refresh · q quit${C.reset}${s.message ? "   " + C.yellow + s.message + C.reset : ""}`);

  r.flush();
}

function renderOverview(r: Renderer, s: AppState): void {
  const done = s.runs.filter((x) => x.status === "done").length;
  const spent = s.runs.reduce((sum, x) => sum + (x.spentUsd || 0), 0);
  const online = s.peers.filter((p) => p.online).length;
  r.box("Overview", [
    `${C.bold}Agents${C.reset}    ${s.agents.length} in fleet`,
    `${C.bold}Runs${C.reset}      ${s.runs.length} total · ${done} done`,
    `${C.bold}Spent${C.reset}     $${spent.toFixed(3)}`,
    `${C.bold}Tailnet${C.reset}   ${online} online of ${s.peers.length} peers`,
    `${C.bold}Posture${C.reset}   ${s.posture}`,
  ], C.blue);
  r.line();
  r.line(`${C.bold}Recent runs${C.reset}`);
  if (!s.runs.length) {
    r.line(C.gray + "  (none yet — press Tab to launch a task)" + C.reset);
  } else {
    for (const run of s.runs.slice(0, 6)) {
      const status = colorStatus(run.status);
      const win = run.winnerAgent ? `${C.green}→ ${run.winnerAgent}${C.reset}` : "";
      r.line(`  ${C.gray}${trunc(run.id, 10)}${C.reset} ${status} ${win} ${trunc(run.task || "", 40)}`);
    }
  }
}

function renderFleet(r: Renderer, s: AppState): void {
  r.line(`${C.bold}Fleet${C.reset}  ${C.gray}${s.agents.length} adapters${C.reset}`);
  r.line();
  r.line(`${C.gray}  agent          capabilities${C.reset}`);
  for (const a of s.agents) {
    const caps = [];
    if (a.capabilities.modelSelection) caps.push("model");
    if (a.capabilities.mcpClient) caps.push("mcp-c");
    if (a.capabilities.mcpServer) caps.push("mcp-s");
    if (a.capabilities.acpServer) caps.push(C.cyan + "acp" + C.reset);
    if (a.capabilities.fullAuto) caps.push(C.yellow + "auto" + C.reset);
    r.line(`  ${a.name.padEnd(14)} ${caps.join("  ")}`);
  }
}

function renderRuns(r: Renderer, s: AppState): void {
  r.line(`${C.bold}Runs${C.reset}  ${C.gray}${s.runs.length} recent${C.reset}`);
  r.line();
  if (!s.runs.length) {
    r.line(C.gray + "  (none yet)" + C.reset);
    return;
  }
  for (const run of s.runs) {
    const status = colorStatus(run.status);
    const spent = run.spentUsd != null ? `$${run.spentUsd.toFixed(3)}` : "";
    const budget = run.budgetUsd != null ? `/${run.budgetUsd}` : "";
    r.line(`  ${C.gray}${trunc(run.id, 12)}${C.reset} ${run.pattern.padEnd(9)} ${status} ${spent}${budget}`);
    if (run.winnerAgent) r.line(`      ${C.green}winner: ${run.winnerAgent}${C.reset}  ${C.gray}${trunc(run.task || "", 50)}${C.reset}`);
  }
}

function renderLive(r: Renderer, s: AppState): void {
  r.line(`${C.bold}Live${C.reset}  ${C.gray}event stream${C.reset}`);
  r.line();
  const shown = s.liveLog.slice(-18);
  for (const l of shown) {
    r.line(`  ${trunc(l, 90)}`);
  }
  if (shown.length < 18) {
    r.line();
    r.line(C.gray + "  (launch a run via Tab to see events stream here)" + C.reset);
  }
}

function colorStatus(status: string): string {
  const m: Record<string, string> = { done: C.green, running: C.yellow, failed: C.red, cancelled: C.gray };
  const color = m[status] || C.gray;
  return `${color}${status.padEnd(8)}${C.reset}`;
}

export { render, renderOverview }; // for testing

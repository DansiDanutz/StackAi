/**
 * Stack Ai OS — Integration check harness (`stackai check`)
 *
 * Reproducibly re-runs the live validations that were previously manual:
 *   1. Daemon health (dashboard responding on :42719)
 *   2. Adapter binary probe (all 15+ adapters)
 *   3. Live agent smoke test (actually run a trivial prompt through each agent
 *      that's likely authenticated, verify it produces output)
 *   4. Dashboard endpoint sweep (health/fleet/runs/stats)
 *   5. Store round-trip (createRun + getRun)
 *
 * Exits non-zero if any critical check fails. This replaces the ad-hoc bash
 * probes and makes the system verifiable after any change.
 *
 * Usage: stackai check [--agents codex,gemini] [--no-live] [--json]
 */
import { stdout, stderr } from "node:process";
import { loadConfig } from "../config.js";
import { createRegistry } from "../adapters/registry.js";
import { ModelRouterImpl } from "../models/router.js";
import { defaultPolicy } from "../safety/policy.js";
import { runSolo } from "../patterns/solo.js";
import { port as resolvePort } from "../ports.js";
import * as store from "../kernel/store.js";
import type { AgentName } from "../types.js";

const G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m", D = "\x1b[2m", B = "\x1b[1m", C = "\x1b[36m", RESET = "\x1b[0m";

interface CheckResult { name: string; pass: boolean; detail: string; durationMs: number }

export async function runCheck(opts: { agents?: string[]; noLive?: boolean; json?: boolean }): Promise<number> {
  const results: CheckResult[] = [];
  const check = async (name: string, fn: () => Promise<{ pass: boolean; detail: string }>) => {
    const start = Date.now();
    try {
      const r = await fn();
      results.push({ name, ...r, durationMs: Date.now() - start });
    } catch (e) {
      results.push({ name, pass: false, detail: (e as Error).message, durationMs: Date.now() - start });
    }
  };

  const cfg = loadConfig();
  const registry = createRegistry(cfg);
  const router = new ModelRouterImpl(cfg.models);
  const policy = defaultPolicy();
  const dashPort = resolvePort("dashboard");

  // 1. Daemon health
  await check("daemon (dashboard :42719)", async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${dashPort}/api/health`, { signal: AbortSignal.timeout(3000) });
      const data = await r.json() as any;
      return { pass: data.ok === true, detail: `health=${data.ok} version=${data.version}` };
    } catch (e) {
      return { pass: false, detail: `daemon not responding: ${(e as Error).message.slice(0, 80)}` };
    }
  });

  // 2. Adapter binaries
  await check("adapter binaries", async () => {
    const agents = registry.enabled();
    let ok = 0;
    for (const a of agents) {
      const built = a.buildCommand({ agent: a.name, prompt: "x", verbosity: "text" } as never, router);
      const { existsSync } = await import("node:fs");
      const { execSync } = await import("node:child_process");
      const base = built.cmd === "node" ? "node" : built.cmd;
      let found = existsSync(base) || base.startsWith("/usr/bin");
      if (!found) { try { execSync(`command -v ${base}`, { stdio: "ignore" }); found = true; } catch { /* */ } }
      if (found || (a as any).isCloud) ok++;
    }
    return { pass: ok === agents.length, detail: `${ok}/${agents.length} adapter binaries present` };
  });

  // 3. Dashboard endpoint sweep
  await check("dashboard endpoints", async () => {
    const endpoints = ["/api/health", "/api/fleet", "/api/models", "/api/runs", "/api/stats"];
    let ok = 0;
    for (const ep of endpoints) {
      try {
        const r = await fetch(`http://127.0.0.1:${dashPort}${ep}`, { signal: AbortSignal.timeout(3000) });
        if (r.ok) ok++;
      } catch { /* */ }
    }
    return { pass: ok === endpoints.length, detail: `${ok}/${endpoints.length} endpoints responding` };
  });

  // 4. Store round-trip
  await check("run store (createRun + getRun)", async () => {
    const id = await store.createRun("check", "integration check", {});
    const run = await store.getRun(id);
    await store.updateRun(id, { status: "done" });
    return { pass: run?.id === id, detail: `createRun+getRun round-trip ok (id=${id.slice(0, 8)})` };
  });

  // 5. Live agent smoke tests
  if (!opts.noLive) {
    const liveAgents = (opts.agents ?? ["codex", "gemini", "openclaude"]).filter((a) => registry.get(a as AgentName)) as AgentName[];
    for (const agent of liveAgents) {
      await check(`live: ${agent}`, async () => {
        const adapter = registry.require(agent);
        const result = await runSolo(adapter, router, {
          agent, prompt: "Reply with exactly: CHECK_OK", verbosity: "text", timeoutSec: 90,
        }, policy);
        const ok = result.finalText.length > 0 && result.exitCode === 0;
        return { pass: ok, detail: ok ? `produced output (${result.finalText.length} chars)` : `exit=${result.exitCode} text=${result.finalText.length}chars` };
      });
    }
  }

  // Report
  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;

  if (opts.json) {
    stdout.write(JSON.stringify({ passed, failed, results }, null, 2) + "\n");
  } else {
    stdout.write(`\n${B}Stack Ai OS — integration check${RESET}\n\n`);
    for (const r of results) {
      const mark = r.pass ? `${G}✓${RESET}` : `${R}✗${RESET}`;
      stdout.write(`  ${mark} ${r.name.padEnd(28)} ${D}${r.detail}${RESET} ${D}(${r.durationMs}ms)${RESET}\n`);
    }
    stdout.write(`\n${B}${passed} passed${failed ? `, ${R}${failed} failed${RESET}` : `${G}, all green${RESET}`}${B} of ${results.length}.${RESET}\n`);
  }
  return failed > 0 ? 1 : 0;
}

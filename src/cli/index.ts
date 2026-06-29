#!/usr/bin/env node
/**
 * stackai — Stack Ai OS command-line interface.
 *
 *   stackai run "<task>" [--agent claude] [--model sonnet] [--full-auto] [--cwd .]
 *   stackai models [--agent claude]
 *   stackai doctor                       # probe all adapters (flag drift detection)
 *   stackai adapters list
 *   stackai adapters add <name> <cmd> [options...]
 *   stackai adapters remove <name>
 *   stackai patterns                     # list pattern presets
 *   stackai doctor-agent <name>          # smoke-test one adapter
 */
import { argv, exit, stdout, stderr } from "node:process";
import { createRegistry } from "../adapters/registry.js";
import { loadConfig, type AgentConfig } from "../config.js";
import { ModelRouterImpl } from "../models/router.js";
import { defaultPolicy } from "../safety/policy.js";
import { runSolo } from "../patterns/solo.js";
import { makeLiveRenderer } from "./live.js";
import type { AgentName } from "../types.js";
import * as store from "../kernel/store.js";

async function main() {
  const args = argv.slice(2);
  const cmd = args[0];
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") return usage(0);
  if (cmd === "-v" || cmd === "--version") return console.log("stackai 0.1.0");

  switch (cmd) {
    case "run": return cmdRun(args.slice(1));
    case "models": return cmdModels(args.slice(1));
    case "doctor": return cmdDoctor(args.slice(1));
    case "doctor-agent": return cmdDoctorAgent(args.slice(1));
    case "adapters": return cmdAdapters(args.slice(1));
    case "patterns": return cmdPatterns();
    case "fleet": return cmdFleet();
    case "runs": return cmdRuns(args.slice(1));
    case "recall": return cmdRecall(args.slice(1));
    case "serve": return cmdServe(args.slice(1));
    case "mcp": return cmdMcp(args.slice(1));
    case "vault": return cmdVault(args.slice(1));
    default:
      stderr.write(`Unknown command: ${cmd}\n`);
      return usage(1);
  }
}

// ---- run -----------------------------------------------------------------
async function cmdRun(args: string[]) {
  const parsed = parseRunArgs(args);
  if (!parsed.prompt) {
    stderr.write('Usage: stackai run "<task>" [--pattern ensemble] [--agent claude] [--model sonnet] [--cwd .] [--full-auto] [--text]\n');
    exit(1);
  }
  const cfg = loadConfig();
  const registry = createRegistry(cfg);
  const router = new ModelRouterImpl(cfg.models);
  const policy = defaultPolicy();

  // Resolve a named pattern preset (default = solo).
  const patternName = parsed.pattern ?? "default";
  const preset = cfg.patterns.patterns.find((p) => p.name === patternName);
  if (parsed.pattern && !preset) {
    stderr.write(`Unknown pattern: ${parsed.pattern}. Try one of: ${cfg.patterns.patterns.map((p) => p.name).join(", ")}\n`);
    exit(1);
  }

  if (preset && preset.kind === "ensemble") {
    return runEnsembleCLI(parsed, preset, cfg, registry, router, policy);
  }

  // Solo (default).
  const agent = (parsed.agent ?? preset?.agents?.[0] ?? "claude") as AgentName;
  const adapter = registry.require(agent);
  const render = makeLiveRenderer(stdout, { agent, quiet: parsed.quiet });
  const result = await runSolo(adapter, router, {
    agent,
    prompt: parsed.prompt,
    model: parsed.model,
    posture: parsed.fullAuto ? "full-auto" : undefined,
    verbosity: parsed.text ? "text" : "stream-json",
    cwd: parsed.cwd,
    onEvent: (_agent, evt) => render(evt),
  }, policy);
  exit(result.exitCode || (result.timedOut ? 124 : 0));
}

async function runEnsembleCLI(parsed: ParsedRun, preset: any, cfg: any, registry: any, router: any, policy: any) {
  const { Scheduler } = await import("../kernel/scheduler.js");
  const { runEnsemble } = await import("../patterns/ensemble.js");
  const scheduler = new Scheduler(policy, { concurrency: 4 });
  const agents = (parsed.agents ?? preset.agents ?? ["claude", "codex", "gemini"]) as AgentName[];

  const render = makeLiveRenderer(stdout, { quiet: parsed.quiet });
  const result = await runEnsemble(registry, router, scheduler, policy, {
    task: parsed.prompt!,
    agents,
    judgeAgent: (parsed.judge ?? preset.judge ?? "claude") as AgentName,
    model: parsed.model ?? preset.model,
    judgeModel: parsed.judge === "fugu" ? "fugu-ultra" : (parsed.model === "opus" ? "opus" : undefined),
    width: preset.width,
    maxIterations: preset.maxIterations,
    budgetUsd: preset.budgetUsd,
    timeoutSec: preset.timeoutSec,
    cwd: parsed.cwd,
    posture: parsed.fullAuto ? "full-auto" : undefined,
    onEvent: (phase, agent, evt) => render(evt),
    onRound: (iter, verdict) => {
      stdout.write(`\n── round ${iter} ── action=${verdict.action} winner=${verdict.winner} ranking=[${verdict.ranking.join(",")}]\n`);
    },
  });

  stdout.write(`\n── ensemble ${result.stoppedReason} ──\n`);
  stdout.write(`  run:      ${result.runId}\n`);
  stdout.write(`  iters:    ${result.iterations}\n`);
  if (result.verdict) stdout.write(`  scores:   ${JSON.stringify(result.verdict.scores)}\n`);
  stdout.write(`  winner:   ${result.winner?.result.agent ?? "(none)"}\n`);
  stdout.write(`  spent:    $${result.spentUsd?.toFixed(4) ?? "0"}\n`);

  // Persist to Obsidian (DansLab-Vault) via the existing vault_writer.
  const { logEnsembleRun } = await import("../memory/run-logger.js");
  const notePath = logEnsembleRun(result);
  if (notePath) stdout.write(`  vault:    ${notePath}\n`);
  if (parsed.quiet && result.winner?.result.finalText) {
    stdout.write("\n" + result.winner.result.finalText + "\n");
  }
  exit(0);
}

type ParsedRun = { prompt?: string; agent?: string; agents?: string[]; model?: string; judge?: string; pattern?: string; cwd?: string; fullAuto?: boolean; text?: boolean; quiet?: boolean };

function parseRunArgs(args: string[]): ParsedRun {
  const out: ParsedRun = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (a === "--agent" || a === "-a") out.agent = args[++i];
    else if (a === "--agents") out.agents = (args[++i] ?? "").split(",");
    else if (a === "--model" || a === "-m") out.model = args[++i];
    else if (a === "--judge") out.judge = args[++i];
    else if (a === "--pattern" || a === "-p") out.pattern = args[++i];
    else if (a === "--cwd") out.cwd = args[++i];
    else if (a === "--full-auto" || a === "-y") out.fullAuto = true;
    else if (a === "--text") out.text = true;
    else if (a === "--quiet" || a === "-q") out.quiet = true;
    else if (!a.startsWith("-") && !out.prompt) out.prompt = a;
  }
  return out;
}

// ---- models --------------------------------------------------------------
function cmdModels(args: string[]) {
  const cfg = loadConfig();
  const router = new ModelRouterImpl(cfg.models);
  const agentFlag = args.find((a) => a === "--agent");
  const agentIdx = args.indexOf("--agent");
  const agent = agentFlag ? args[agentIdx + 1] : undefined;

  console.log("Model aliases" + (agent ? ` (resolved for ${agent})` : "") + ":");
  for (const { alias, resolved } of router.describe(agent as AgentName | undefined)) {
    console.log(`  ${alias.padEnd(14)} ${resolved ? `→ ${resolved}` : "(no provider)"}`);
  }
  console.log("\nPattern defaults:");
  for (const [pat, d] of Object.entries(cfg.models.defaults)) {
    const bits = [d.model && `model=${d.model}`, d.agents && `agents=[${d.agents.join(",")}]`, d.judge && `judge=${d.judge}`].filter(Boolean);
    console.log(`  ${pat.padEnd(12)} ${bits.join("  ")}`);
  }
}

// ---- adapters ------------------------------------------------------------
function cmdAdapters(args: string[]) {
  const sub = args[0];
  if (sub === "list" || !sub) return listAdapters();
  if (sub === "add") return addAdapter(args.slice(1));
  if (sub === "remove" || sub === "rm") return removeAdapter(args.slice(1));
  stderr.write("Usage: stackai adapters {list|add|remove}\n");
  exit(1);
}

function listAdapters() {
  const cfg = loadConfig();
  const registry = createRegistry(cfg);
  console.log("Fleet adapters:");
  for (const a of registry.enabled()) {
    const c = a.capabilities;
    const caps = [
      c.modelSelection ? "model" : "",
      c.jsonStream ? "json" : "",
      c.mcpClient ? "mcp-c" : "",
      c.mcpServer ? "mcp-s" : "",
      c.acpServer ? "acp" : "",
      c.fullAuto ? "auto" : "",
    ].filter(Boolean).join(",");
    const dyn = a.dynamic ? " (dynamic)" : "";
    const dis = registry.isDisabled(a.name) ? " [DISABLED]" : "";
    console.log(`  ${a.name.padEnd(14)} ${a.displayName}${dyn}${dis}  [${caps}]`);
  }
  const disabled = [...registry["disabled" as never] as Set<string>];
  if (disabled.length) console.log(`\nDisabled: ${disabled.join(", ")}`);
}

function addAdapter(args: string[]) {
  // stackai adapters add <name> <command> [--label "..."] [--prefix "exec"]
  //   [--model-flag "--model,{{model}}"] [--json-flag "--output-format,stream-json"]
  //   [--auto-flag "--yolo"] [--mcp-flag "--mcp-config,{{mcp_config}}"]
  //   [--resume-flag "--resume,{{session}}"] [--positional] [--node-run]
  //   [--default-model sonnet]
  const name = args[0];
  const command = args[1];
  if (!name || !command) {
    stderr.write("Usage: stackai adapters add <name> <command> [options]\n");
    exit(1);
  }
  const flag = (k: string) => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 ? args[i + 1]?.split(",") : undefined;
  };
  const bool = (k: string) => args.includes(`--${k}`);
  const str = (k: string) => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 ? args[i + 1] : undefined;
  };

  const agentCfg: AgentConfig = {
    name: name as AgentName,
    command,
    enabled: true,
    dynamic: true,
    label: str("label") ?? name,
    defaultModel: str("default-model"),
    prefixArgs: str("prefix") ? str("prefix")!.split(",") : undefined,
    nodeRun: bool("node-run"),
    template: {
      command,
      nodeRun: bool("node-run"),
      prefixArgs: str("prefix") ? str("prefix")!.split(",") : undefined,
      promptPositional: bool("positional"),
      flags: {
        model: flag("model-flag"),
        json: flag("json-flag"),
        fullAuto: flag("auto-flag"),
        mcp: flag("mcp-flag"),
        resume: flag("resume-flag"),
      },
    },
    capabilities: {
      jsonStream: !!flag("json-flag"),
      modelSelection: !!flag("model-flag"),
      mcpClient: !!flag("mcp-flag"),
      mcpServer: false,
      sessionResume: !!flag("resume-flag"),
      fullAuto: !!flag("auto-flag"),
      acpServer: bool("acp"),
    },
  };

  const cfg = loadConfig();
  const registry = createRegistry(cfg);
  try {
    registry.addAdapter(agentCfg);
    console.log(`✓ Added dynamic adapter '${name}' → ${command}`);
    console.log(`  Edit config/agents.yaml to fine-tune; 'stackai doctor-agent ${name}' to smoke-test.`);
  } catch (e) {
    stderr.write(`Error: ${(e as Error).message}\n`);
    exit(1);
  }
}

function removeAdapter(args: string[]) {
  const name = args[0];
  if (!name) { stderr.write("Usage: stackai adapters remove <name>\n"); exit(1); }
  const cfg = loadConfig();
  const registry = createRegistry(cfg);
  if (registry.removeAdapter(name as AgentName)) {
    console.log(`✓ Removed dynamic adapter '${name}'`);
  } else {
    stderr.write(`Cannot remove '${name}' (built-in or not found)\n`);
    exit(1);
  }
}

// ---- patterns ------------------------------------------------------------
function cmdPatterns() {
  const cfg = loadConfig();
  console.log("Pattern presets:");
  for (const p of cfg.patterns.patterns) {
    const bits = [
      p.kind,
      p.agents && `agents=[${p.agents.join(",")}]`,
      p.judge && `judge=${p.judge}`,
      p.model && `model=${p.model}`,
      p.width && `width=${p.width}`,
      p.maxIterations && `iters=${p.maxIterations}`,
      p.budgetUsd && `$${p.budgetUsd}`,
    ].filter(Boolean);
    console.log(`  ${p.name.padEnd(16)} ${bits.join("  ")}`);
  }
}

// ---- doctor --------------------------------------------------------------
async function cmdDoctor(args: string[]) {
  const cfg = loadConfig();
  const registry = createRegistry(cfg);
  const quiet = args.includes("--quiet");
  console.log(`Stack Ai OS doctor — probing ${registry.enabled().length} adapters\n`);
  let ok = 0, fail = 0;
  for (const a of registry.enabled()) {
    const res = await probe(a, quiet);
    if (res) ok++; else fail++;
  }
  console.log(`\n${ok} ok, ${fail} failed of ${ok + fail}.`);
  exit(fail > 0 ? 1 : 0);
}

async function cmdDoctorAgent(args: string[]) {
  const name = args[0] as AgentName;
  if (!name) { stderr.write("Usage: stackai doctor-agent <name>\n"); exit(1); }
  const cfg = loadConfig();
  const registry = createRegistry(cfg);
  const a = registry.get(name);
  if (!a) { stderr.write(`No such adapter: ${name}\n`); exit(1); }
  const ok = await probe(a, false);
  exit(ok ? 0 : 1);
}

async function probe(a: ReturnType<ReturnType<typeof createRegistry>["enabled"]>[number] | undefined, quiet: boolean): Promise<boolean> {
  if (!a) return false;
  process.stdout.write(`  ${a.name.padEnd(14)} `);
  try {
    // Build a trivial command (don't actually call the LLM) and check the binary exists.
    const { cmd } = a.buildCommand(
      { agent: a.name, prompt: "OK", verbosity: "text" } as never,
      { resolve: () => undefined, aliases: () => [] }
    );
    const { existsSync } = await import("node:fs");
    const baseCmd = cmd === "node" ? "/usr/bin/env" : cmd;
    if (!existsSync(baseCmd) && !baseCmd.startsWith("/usr/bin")) {
      // fallback: check PATH
      const { execSync } = await import("node:child_process");
      try { execSync(`command -v ${baseCmd}`, { stdio: "ignore" }); }
      catch { throw new Error(`binary not found: ${baseCmd}`); }
    }
    console.log(`${"✓"} ${a.displayName}`);
    if (!quiet) console.log(`    cmd: ${cmd}`);
    return true;
  } catch (e) {
    console.log(`✗ ${(e as Error).message}`);
    return false;
  }
}

// ---- mcp (two-way bus) ---------------------------------------------------
async function cmdMcp(args: string[]) {
  const sub = args[0];
  if (sub === "serve") {
    // Run Stack Ai OS as an MCP server over stdio. Any MCP-capable CLI connects
    // via its --mcp-config flag pointed at `stackai mcp config` output.
    const { startMcpServer } = await import("../mcp/server.js");
    startMcpServer();
    return; // long-running over stdio
  }
  if (sub === "config") {
    // Print a JSON snippet a CLI can use to connect to the Stack Ai OS MCP server.
    const { stackAiOsMcpSnippet } = await import("../mcp/client.js");
    console.log(JSON.stringify({ mcpServers: stackAiOsMcpSnippet() }, null, 2));
    return;
  }
  if (sub === "inject") {
    // Show what servers would be injected into a given agent's run.
    const agent = (args[1] ?? "claude") as AgentName;
    const cfg = loadConfig();
    const registry = createRegistry(cfg);
    const a = registry.get(agent);
    if (!a) { stderr.write(`No such adapter: ${agent}\n`); exit(1); }
    const { resolveInjectableServers } = await import("../mcp/client.js");
    const servers = resolveInjectableServers(agent, a.capabilities);
    if (!Object.keys(servers).length) {
      console.log(`No MCP servers injected for '${agent}' (mcpClient=${a.capabilities.mcpClient}).`);
      return;
    }
    console.log(`MCP servers injected into '${agent}':`);
    for (const [name, entry] of Object.entries(servers)) {
      const loc = entry.url ?? `${entry.command} ${(entry.args ?? []).join(" ")}`;
      console.log(`  ${name.padEnd(18)} ${loc}`);
    }
    return;
  }
  stderr.write("Usage: stackai mcp {serve|config|inject <agent>}\n");
  stderr.write("  serve    — run Stack Ai OS as an MCP server (for CLIs to call back)\n");
  stderr.write("  config   — print the mcp-config snippet for CLIs\n");
  stderr.write("  inject <agent> — show which servers an agent receives\n");
  exit(1);
}

// ---- serve (web dashboard) ----------------------------------------------
async function cmdServe(args: string[]) {
  const { startServer } = await import("../web/server.js");
  const { port: resolvePort } = await import("../ports.js");
  const tailnet = args.includes("--tailnet");
  const p = args.includes("--port") ? Number(args[args.indexOf("--port") + 1]) : resolvePort("dashboard");
  startServer({ port: p });
  if (tailnet) {
    stdout.write("\nTo publish on the tailnet run:\n");
    stdout.write(`  tailscale serve --bg --https 443 http://127.0.0.1:${p}\n\n`);
  }
  stdout.write("Press Ctrl+C to stop.\n");
  // keep alive
  process.on("SIGINT", () => exit(0));
}

// ---- recall (memory) -----------------------------------------------------
async function cmdRecall(args: string[]) {
  const memory = await import("../memory/recall.js");
  const query = args.filter((a) => !a.startsWith("--")).join(" ");
  const codeTarget = args.includes("--code") ? args[args.indexOf("--code") + 1] : undefined;
  if (!query) { stderr.write("Usage: stackai recall \"<query>\" [--code <path>]\n"); exit(1); }
  const results = memory.recallAll(query, { codeTarget });
  if (!results.length) { console.log("(no recall results — backends may be offline)"); return; }
  console.log(memory.formatContext(results));
}

// ---- runs (history from run store) ---------------------------------------
async function cmdRuns(args: string[]) {
  if (args[0] === "show") {
    const id = args[1];
    if (!id) { stderr.write("Usage: stackai runs show <id>\n"); exit(1); }
    const run = await store.getRun(id);
    if (!run) { stderr.write(`Run ${id} not found.\n`); exit(1); }
    console.log(`Run ${run.id}`);
    console.log(`  pattern: ${run.pattern}`);
    console.log(`  status:  ${run.status}`);
    console.log(`  task:    ${run.task}`);
    console.log(`  ts:      ${run.ts}`);
    if (run.winnerAgent) console.log(`  winner:  ${run.winnerAgent}`);
    if (run.spentUsd != null) console.log(`  spent:   $${run.spentUsd.toFixed(4)} / $${run.budgetUsd ?? "?"}`);
    if (run.iterations != null) console.log(`  iters:   ${run.iterations}`);
    const cands = await store.listCandidates(id);
    if (cands.length) {
      console.log("\n  candidates:");
      for (const c of cands) {
        const score = c.score != null ? ` score=${c.score}` : "";
        console.log(`    iter ${c.iteration} ${c.agent.padEnd(10)} exit=${c.exitCode}${score} ${(c.durationMs / 1000).toFixed(1)}s`);
      }
    }
    return;
  }
  const runs = await store.listRuns(20);
  if (!runs.length) { console.log("No runs yet."); return; }
  console.log("Recent runs:");
  for (const r of runs) {
    const spent = r.spentUsd != null ? ` $${r.spentUsd.toFixed(3)}` : "";
    const win = r.winnerAgent ? ` → ${r.winnerAgent}` : "";
    console.log(`  ${r.id.slice(0, 12)}  ${r.pattern.padEnd(10)} ${r.status.padEnd(8)}${spent}${win}  ${r.task.slice(0, 50)}`);
  }
  console.log(`\n(${runs.length} of N — 'stackai runs show <id>' for details)`);
}

let _storeMod: typeof store | null = null;
function requireStore() {
  return (_storeMod ??= store);
}
function cmdFleet() {
  console.log("Fleet (local adapters + remote Tailscale peers — Phase 4):");
  const cfg = loadConfig();
  const registry = createRegistry(cfg);
  for (const a of registry.enabled()) {
    console.log(`  local   ${a.name.padEnd(14)} ${a.displayName}`);
  }
  console.log("  (run 'tailscale status' for the tailnet peer list)");
}

// ---- vault ---------------------------------------------------------------
async function cmdVault(args: string[]) {
  const sub = args[0];
  const vault = await import("../security/vault.js");
  const backend = vault.detectBackend();
  const pass = process.env.STACKAI_VAULT_PASS;

  if (sub === "set") {
    // stackai vault set <KEY> <value>  (value optional → reads from stdin)
    const key = args[1];
    if (!key) { stderr.write("Usage: stackai vault set <KEY> [value]\n"); exit(1); }
    let value = args[2];
    if (value === undefined) {
      const chunks: Buffer[] = [];
      for await (const c of process.stdin) chunks.push(c as Buffer);
      value = Buffer.concat(chunks).toString("utf8").replace(/\n$/, "");
    }
    if (!value) { stderr.write("No value provided (pass as arg or pipe via stdin).\n"); exit(1); }
    vault.setSecret(key, value, pass);
    console.log(`✓ Stored '${key}' in ${backend.name}.`);
    return;
  }
  if (sub === "get") {
    const key = args[1];
    if (!key) { stderr.write("Usage: stackai vault get <KEY>\n"); exit(1); }
    const v = vault.getSecret(key, pass);
    if (v === undefined) { stderr.write(`'${key}' not found in vault.\n`); exit(1); }
    stdout.write(v + "\n");
    return;
  }
  if (sub === "list") {
    const keys = vault.listSecrets(pass);
    console.log(`Vault (${backend.name}, ${keys.length} keys):`);
    for (const k of keys) if (k !== "__index__") console.log(`  ${k}`);
    return;
  }
  if (sub === "delete" || sub === "rm") {
    const key = args[1];
    if (!key) { stderr.write("Usage: stackai vault delete <KEY>\n"); exit(1); }
    if (vault.deleteSecret(key, pass)) console.log(`✓ Deleted '${key}'.`);
    else { stderr.write(`'${key}' not found.\n`); exit(1); }
    return;
  }
  if (sub === "import-env") {
    // Import all KEY=VALUE pairs from .env into the secure vault.
    const { loadSecrets } = await import("../secrets.js");
    loadSecrets();
    const fromFile = readEnvFile();
    if (!fromFile) { stderr.write("No .env file found.\n"); exit(1); }
    let n = 0;
    for (const [k, v] of Object.entries(fromFile)) {
      vault.setSecret(k, v, pass);
      n++;
    }
    console.log(`✓ Imported ${n} keys from .env into ${backend.name}.`);
    console.log("  You can now delete .env — secrets live securely in the vault.");
    return;
  }
  if (sub === "status") {
    console.log(`Vault backend: ${backend.name}`);
    console.log(`Available:     ${backend.available}`);
    console.log(`Needs passphrase: ${backend.needsPassphrase}`);
    const keys = vault.listSecrets(pass).filter((k) => k !== "__index__");
    console.log(`Keys stored:   ${keys.length}`);
    return;
  }
  stderr.write(`Usage: stackai vault {set|get|list|delete|import-env|status}\n`);
  exit(1);
}

function readEnvFile(): Record<string, string> | null {
  const { existsSync, readFileSync } = require_fs();
  const path = require_path();
  let dir = __dirnameSafe();
  for (let i = 0; i < 6; i++) {
    const f = path.join(dir, ".env");
    if (existsSync(f)) {
      const out: Record<string, string> = {};
      for (const line of readFileSync(f, "utf8").split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const eq = t.indexOf("=");
        if (eq < 0) continue;
        out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      }
      return out;
    }
    dir = path.dirname(dir);
  }
  return null;
}

// ESM-safe accessors (avoid require() under NodeNext).
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import { fileURLToPath as _fileURLToPath } from "node:url";
function require_fs() { return nodeFs; }
function require_path() { return nodePath; }
function __dirnameSafe(): string {
  return nodePath.dirname(_fileURLToPath(import.meta.url));
}

// ---- usage ---------------------------------------------------------------
function usage(code: number) {
  console.log(`stackai — Stack Ai OS

Usage:
  stackai run "<task>" [--pattern ensemble] [--agent claude] [--judge fugu] [--model sonnet] [--cwd .] [--full-auto] [--text]
  stackai models [--agent <name>]
  stackai doctor                          # probe all adapters
  stackai doctor-agent <name>             # smoke-test one adapter
  stackai adapters list
  stackai adapters add <name> <cmd> [options]
      --label "..." --prefix "exec" --model-flag "--model,{{model}}"
      --json-flag "--output-format,stream-json" --auto-flag "--yolo"
      --mcp-flag "--mcp-config,{{mcp_config}}" --resume-flag "--resume,{{session}}"
      --positional --node-run --default-model sonnet
  stackai adapters remove <name>
  stackai patterns
  stackai fleet
  stackai runs [show <id>]               # run history from the store
  stackai recall "<query>" [--code path] # query claude-mem + openclaw + graphify
  stackai serve [--port N] [--tailnet]   # web dashboard (default :42719)
  stackai mcp serve                      # run as MCP server (CLIs call back into the OS)
  stackai mcp config                     # print mcp-config snippet for CLIs
  stackai mcp inject <agent>             # show servers injected into an agent
  stackai vault set <KEY> [value|stdin]   # store in macOS Keychain (encrypted)
  stackai vault get <KEY>
  stackai vault list
  stackai vault delete <KEY>
  stackai vault import-env               # migrate .env → secure vault
  stackai vault status
`);
  exit(code);
}

main().catch((e) => { console.error(e); exit(1); });

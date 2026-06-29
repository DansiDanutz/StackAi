# Stack Ai OS — Architecture & Design

> How the system is structured, why it's structured that way, and how data
> flows through it. This is the authoritative design reference. It documents
> what is **built and verified** (June 2026), not aspiration.

---

## 1. System at a glance

Stack Ai OS is a **local orchestration kernel for AI coding-agent CLIs**. It
treats 9 installed CLIs (claude, codex, opencode, gemini, kimi, openclaude, pi,
hermes, zcode) plus any dynamically-added ones — and the cloud meta-orchestrator
Fugu — as schedulable "processes," runs them in collaborative loops, and lets you
drive the whole thing from a CLI, a web dashboard, or (planned) a TUI.

```
┌──────────────────────────────────────────────────────────────────┐
│                        INTERFACES                                 │
│   `stackai` CLI    Web dashboard (:42719)    TUI (planned)        │
└─────────────┬────────────────┬───────────────────┬───────────────┘
              │                │                   │
              ▼                ▼                   ▼
┌──────────────────────────────────────────────────────────────────┐
│                          KERNEL                                   │
│  Orchestrator · Scheduler (concurrency pool) · Safety policy      │
│  Loop engine (ensemble→judge→refine) · Run lifecycle              │
└──────┬───────────────────┬──────────────────────┬────────────────┘
       │ dispatches        │ reads/writes         │ exposes/consumes
       ▼                   ▼                      ▼
┌──────────────┐  ┌─────────────────┐  ┌───────────────────────────┐
│  PATTERNS    │  │  RUN STORE      │  │  MCP / ACP TWO-WAY BUS    │
│  solo        │  │  (SQLite)       │  │  OS as MCP server (5 tools)│
│  ensemble    │  │  runs/candidates│  │  + inject shared servers   │
│  judge       │  │  ratings        │  │  + ACP for 4 native CLIs   │
└──────┬───────┘  └─────────────────┘  └───────────────────────────┘
       │ calls
       ▼
┌──────────────────────────────────────────────────────────────────┐
│                         ADAPTERS                                  │
│  9 built-in (claude/codex/opencode/gemini/kimi/openclaude/pi/     │
│              hermes/zcode) + GenericAdapter (dynamic) + Fugu      │
│  Each normalizes one CLI's flags into RunRequest→AgentEvent       │
│  4 ACP-native agents bypass stream-json via JSON-RPC             │
└──────┬───────────────────────────────────────────────────────────┘
       │ spawns child processes / HTTP calls
       ▼
┌──────────────────────────────────────────────────────────────────┐
│              MEMORY & PERSISTENCE BUS (reuse, don't rebuild)      │
│  Obsidian (vault_writer.py → DansLab-Vault, obsidian-git)         │
│  claude-mem (:37777) · openclaw memory · graphify · run store     │
└──────────────────────────────────────────────────────────────────┘
```

---

## 2. Core abstractions

The entire system speaks **three types** and **one interface**, defined in
`src/types.ts`. Every module depends only on these — never on raw CLI flags.

### `RunRequest` (in)
What it takes to run one agent on one prompt. Patterns construct these; the
kernel dispatches them through adapters.
```ts
{ agent, prompt, cwd?, model?, posture?, verbosity?, mcpConfig?,
  sessionId?, timeoutSec?, extraArgs?, label? }
```

### `AgentEvent` (out)
A normalized discriminated union — the **only** event shape the rest of the
system consumes, regardless of which CLI produced it:
```
system | assistant(text|thinking) | tool_use | tool_result
      | cost | error | done
```

### `AgentAdapter` (interface)
One per CLI. Encodes the capability matrix:
```ts
interface AgentAdapter {
  name, capabilities, displayName
  resolveModel(alias, router)         // alias → this CLI's model id
  buildCommand(req, router)           // → exact shell command (the matrix)
  parseEvent(raw)                     // CLI's stream-json → AgentEvent
  acpCommand?(req, router)            // ACP-native agents override run()
  run(req, router): AsyncIterable<AgentEvent>
}
```

---

## 3. The adapter layer — why the design works

9 CLIs have **wildly incompatible** flag vocabularies. The adapter layer is the
single point that absorbs this complexity.

| Gotcha | How it's handled |
|---|---|
| gemini's `-p` means *prompt*, not print | `GeminiAdapter.buildCommand` emits `-p <prompt>` + separate `-o json` |
| codex gates headless behind `exec` | `prefixArgs: ["exec"]` in config; prompt is positional last |
| kimi needs BOTH `--prompt` AND `--print` | `KimiAdapter` emits both |
| openclaude is a zsh *function* (not a binary) | invokes the dist `.mjs` directly via `node` |
| zcode is off-PATH + has no `--model` flag | full `node …/zcode.cjs` path; model is config-only |
| **pi has zero MCP** | `capabilities.mcpClient=false` → MCP bus skips it |
| 4 CLIs speak **ACP** | `acpCommand()` override → base `run()` delegates to the JSON-RPC session, bypassing fragile stream-json parsing |

**`stackai doctor`** is the flag-drift canary: it probes every adapter's binary
and command shape. When a CLI updates and breaks a flag, doctor fails first.

### Dynamic adapters (the "add any CLI" feature)
`GenericAdapter` (`src/adapters/generic.ts`) builds its command entirely from a
`CommandTemplate` in `agents.yaml`. `stackai adapters add <name> <cmd> [flags]`
registers any CLI with no code — the template's `{{placeholders}}` are
substituted at runtime. This is how new CLIs join the fleet.

---

## 4. The kernel

### Scheduler (`src/kernel/scheduler.ts`)
A **bounded concurrency pool**. An ensemble of 4 heavy coding agents would
otherwise peg a single Mac Studio; the scheduler queues `RunRequests` and runs
them through a worker pool (default 3 concurrent). Each `submit()` returns a
handle with the result promise + a `cancel()`.

### Loop engine (`src/patterns/ensemble.ts`)
Drives `ensemble → judge → refine weakest → repeat` with **enforced** caps:
- **Budget**: hard USD ceiling; loop stops when exceeded.
- **Iterations**: max refinement rounds.
- **Time**: per-agent wall-clock timeout (kills with SIGTERM→SIGKILL).
- **Convergence**: if a refined candidate is ≥90% similar (token-overlap) to its
  predecessor, the loop stops — it's not changing.

Caps are checked in-code, not advisory. The `stoppedReason` field records which
cap triggered: `accepted | converged | budget | iterations | timeout | error`.

### Run store (`src/kernel/store.ts`)
SQLite (`node:sqlite`, built into Node 24 — no native dep). Tables: `runs`,
`candidates`, `ratings`. Powers `stackai runs` and the dashboard's history view.

---

## 5. Patterns

| Pattern | Flow | Status |
|---|---|---|
| **solo** | one agent → result | ✅ |
| **ensemble** | fan out N agents → judge → refine loop | ✅ |
| **judge** | rank candidates by rubric → verdict | ✅ |
| **pipeline** | plan → code → review → fix (sequential) | planned |
| **debate** | adversarial critique until convergence | planned |
| **divide-and-conquer** | coordinator splits → fan out → merge (DAG) | planned |

The judge returns a structured `Verdict` (`scores`, `ranking`, `winner`, `action`
∈ accept/refine/reject). `parseVerdict` is defensive: extracts JSON from
surrounding prose, clamps scores, falls back to a reject verdict on malformed
output. The verdict parser has dedicated unit tests.

---

## 6. The two-way MCP/ACP bus

This is the **"connects all"** layer — the reason agents can orchestrate agents.

### OS as MCP server (`src/mcp/server.ts`)
Stack Ai OS exposes **5 tools** over JSON-RPC stdio (MCP protocol v2024-11-05):
`sao.recall`, `sao.judge`, `sao.ensemble`, `sao.run_status`, `sao.list_runs`.

Any MCP-capable CLI connects via its `--mcp-config` flag pointed at
`stackai mcp serve`. A CLI agent, mid-task, can call `sao.ensemble` for a second
opinion — **agents orchestrating agents**. Verified: the protocol handshake +
tools/list work over stdio.

### OS as MCP client (`src/mcp/client.ts`)
A curated catalog of shared MCP servers (context7, playwright, claude-mem-search,
and the OS itself) is injected into MCP-capable agents' runs. Capability gating:
agents with `mcpClient=false` (pi, zcode) get nothing.

### ACP (`src/mcp/acp.ts`)
4 CLIs (opencode, gemini, kimi, zcode) speak the Agent Client Protocol. Instead
of parsing each one's bespoke stream-json, the OS opens a JSON-RPC session
(initialize → session/new → session/prompt → session/update) and receives typed
events. This is more robust than stream-json for those 4 agents.

---

## 7. Safety model

**Cautious by default; full-auto is opt-in.** Three layers:

1. **Posture** (`src/safety/policy.ts`): `cautious` (no skip-permission flags) or
   `full-auto` (each adapter emits its CLI's yolo equivalent). Full-auto is
   enabled via `--full-auto`, env, or config — never default.
2. **Hard guardrails** (always on, even in full-auto): blocked-command regexes
   (`rm -rf /`, force-push main, fork bombs, `dd` to disks), a cwd allowlist.
3. **Budget caps**: ensembles can't run away on cost.

---

## 8. Memory & persistence (reuse, don't rebuild)

Stack Ai OS never duplicates memory infrastructure. It wires together what's
already on the Mac Studio:

| Layer | What | How Stack Ai OS uses it |
|---|---|---|
| **Obsidian** | DansLab-Vault (your operational brain) | Writes run results via the existing `vault_writer.py` — proper frontmatter + obsidian-git auto-commit. Same path Claude/Codex/Hermes use. |
| **claude-mem** | ~494MB observations store (:37777) | `recall` queries it for cross-session context before solving |
| **openclaw memory** | SQLite + FTS + embeddings | `recall` queries via `openclaw memory search` |
| **graphify** | cross-repo code knowledge-graph | `recall` gets structural context for a code target |
| **run store** | Stack Ai OS's own SQLite | run history, candidates, judge scores, ratings |

Remote peers (droplets) reach the vault via the existing Redis-stream
`obsidian-bridge` daemon — Stack Ai OS's `ObsidianSink` falls back to that path.

---

## 9. Security model

| Concern | Mitigation |
|---|---|
| **API keys in a public repo** | Keys live in the **macOS Keychain** (or AES-256-GCM file), never in code. `.env` is gitignored. `stackai vault` manages them. |
| **Force-push to main** | Hard guardrail blocks `git push --force origin main` even in full-auto. |
| **Destructive shell** | `rm -rf /`, fork bombs, `dd` to disks blocked by regex. |
| **Cloud data egress** | Fugu is cloud + opt-in; never used for private codebases by default. WaveSpeed (media) vaulted but not integrated into the core. |
| **Concurrent overload** | Scheduler concurrency pool caps parallel agents. |

---

## 10. Design decisions (ADRs)

### ADR-1: Own the kernel; the CLIs are the agents
**Decision:** No CrewAI/AutoGen/LangGraph dependency. The 9 CLIs *are* the agents.
**Rationale:** Those frameworks are opinionated, mostly Python, and would fight
the adapter-driven, CLI-spawning design. A lean TS kernel keeps the system
self-contained and lets each CLI's full power (file tools, sessions) be used.

### ADR-2: MCP + ACP are the connective tissue
**Decision:** Standardize on MCP (server + client) and ACP, not custom protocols.
**Rationale:** 8/9 CLIs are MCP clients; 4 speak ACP. Adopting the standards
means zero glue per agent and bidirectional agent↔agent communication. Researched
in `docs/RESEARCH.md` alongside Open Multi-Agent and Sakana Fugu.

### ADR-3: Reuse the memory stack
**Decision:** Write through `vault_writer.py` and recall from claude-mem/openclaw/graphify.
**Rationale:** The Mac Studio already has a mature, git-backed memory ecosystem.
Duplicating it would fragment knowledge. Stack Ai OS adds only the run store.

### ADR-4: Cautious-by-default safety
**Decision:** Full-auto (skip-permissions) is opt-in; hard guardrails always on.
**Rationale:** A single Mac Studio running 9 tool-using agents with unrestricted
file/shell access is dangerous. The posture is escalatable, guardrails aren't.

### ADR-5: ACP-native agents bypass stream-json
**Decision:** For the 4 ACP-capable CLIs, use the JSON-RPC session; others parse stream-json.
**Rationale:** Stream-json shapes vary per CLI and break on updates. ACP gives
typed, versioned events — strictly more reliable where available.

### ADR-6: Cloud adapters (Fugu) are opt-in and separate
**Decision:** Fugu joins as a judge option, not a core participant.
**Rationale:** Fugu orchestrates *models* (API→text); Stack Ai OS orchestrates
*tool-using CLIs*. Different layers. Cloud means data egress — keep it opt-in.

---

## 11. Port allocation

Reserved **42700–42799** (the "SAO" band) — verified free, below the macOS
ephemeral range (49152–65535) so the OS can never reassign these for outbound
connections. Single source of truth: `src/ports.ts`.

| Service | Port |
|---|---|
| Web dashboard + REST + WebSocket | 42719 |
| MCP TCP bridge (tailnet exposure) | 42720 |
| Fleet discovery | 42721 |

---

## 12. Module reference

| Path | Responsibility |
|---|---|
| `src/types.ts` | `RunRequest`, `AgentEvent`, `AgentAdapter`, `ModelRouter` — the shared vocabulary |
| `src/config.ts` | YAML config schema + loader (agents/models/patterns) |
| `src/ports.ts` | Port assignments (42700–42799 band) |
| `src/secrets.ts` | `.env` loader (gitignored fallback) |
| `src/adapters/base.ts` | Shared spawn/stream/normalize machinery + ACP delegation |
| `src/adapters/{claude,codex,...,zcode}.ts` | One per built-in CLI (the flag matrix) |
| `src/adapters/generic.ts` | Config-driven adapter for `adapters add` |
| `src/adapters/fugu.ts` | Cloud meta-orchestrator (OpenAI-compatible API) |
| `src/adapters/registry.ts` | Builds + holds all adapters; add/remove dynamic |
| `src/models/router.ts` | Alias → per-CLI model id resolution |
| `src/safety/policy.ts` | Cautious/full-auto posture + guardrails |
| `src/security/vault.ts` | Keychain + AES-256-GCM file backend |
| `src/kernel/scheduler.ts` | Concurrency pool |
| `src/kernel/store.ts` | SQLite run store (async, node:sqlite) |
| `src/kernel/tailnet.ts` | Tailscale peer discovery |
| `src/patterns/solo.ts` | Single-agent run |
| `src/patterns/ensemble.ts` | Fan-out + judge + refine loop engine |
| `src/patterns/judge.ts` | Rubric prompt + defensive verdict parser |
| `src/mcp/server.ts` | OS as MCP server (5 tools over stdio) |
| `src/mcp/client.ts` | Shared-server injection (capability-gated) |
| `src/mcp/acp.ts` | Agent Client Protocol client |
| `src/memory/obsidian.ts` | vault_writer.py sink (+ Redis fallback) |
| `src/memory/recall.ts` | claude-mem + openclaw + graphify queries |
| `src/memory/run-logger.ts` | Run results → Obsidian |
| `src/web/server.ts` | HTTP + WebSocket dashboard server |
| `src/web/dashboard.ts` | Single-file SPA |
| `src/cli/index.ts` | The `stackai` command |

---

## 13. Testing strategy

- **Unit (vitest, 60 tests):** adapter `buildCommand` flag matrices, model router,
  safety guardrails, judge verdict parser, vault crypto, Fugu model resolution,
  MCP capability gating, ensemble similarity.
- **Integration (tsx, 5 tests):** run store CRUD against real `node:sqlite`.
- **Smoke (`stackai doctor`):** probes every adapter's binary + command shape.
- **Flag-drift detection:** adapter tests lock exact CLI invocations; a CLI
  update that changes a flag breaks the test first.

---

*This document reflects the verified state as of June 2026. Update it when
architectural decisions change; see `docs/RESEARCH.md` for the OSS leverage
analysis that informed these decisions.*

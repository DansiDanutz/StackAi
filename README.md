# Stack Ai OS

A local operating system that treats your AI coding CLIs as schedulable "processes,"
runs them in collaborative loops (ensemble → judge → refine), and lets you drive
the whole thing from a CLI (TUI + web dashboard coming). You set the model per
agent; the OS routes, fans out, judges, converges, persists, and remembers.

Built on a single Mac Studio with 9 CLIs installed. It speaks **MCP** and **ACP**
(the two protocols nearly all of them share) and reuses the existing memory stack
(claude-mem, openclaw memory, graphify, Obsidian) instead of reinventing it.

---

## What it does

```bash
stackai run "refactor auth.ts to PKCE" --pattern ensemble --budget 1.00
# → claude/codex/gemini solve it in parallel (ACP where available),
#   opus judges, the weakest is refined in a loop with convergence/budget caps,
#   the winner is saved to the run store + logged to your Obsidian vault.
```

**9 CLIs, normalized.** Each has wildly different flags (gemini's `-p` means
*prompt*, codex gates headless behind `exec`, pi has no MCP, zcode is off-PATH).
The adapter layer encodes the exact matrix so the rest of the system sees one
uniform interface.

**Patterns.** `solo`, `ensemble`, `judge`, (+ `pipeline`/`debate`/`divide-and-conquer`
planned). The loop engine drives iterative refinement with **enforced** caps:
budget, iterations, time, and diff-based convergence.

**Add any CLI.** `stackai adapters add <name> <cmd> ...` registers arbitrary
CLIs into the fleet via a config template — no code needed.

**Secure vault.** API keys live in the macOS Keychain (or an AES-256-GCM file),
never in the repo. `stackai vault set|get|list|import-env`.

**Persists everywhere.** Run store (SQLite) + your DansLab Obsidian vault (via
the existing `vault_writer.py` so obsidian-git auto-commits) + recall from
claude-mem / openclaw / graphify before solving.

---

## Quick start

```bash
cd /Users/davidai/ZCodeProject/stack-ai-os
pnpm install

stackai doctor                       # verify all 9 CLIs are present
stackai models --agent codex         # see alias → model-id resolution
stackai adapters list                # the fleet + capabilities
stackai run "hello" --agent claude   # solo run
```

## Install as a persistent tool

Turn Stack Ai OS into a global command with an always-on dashboard daemon:

```bash
./install.sh                # builds, installs global 'stackai' bin, starts dashboard daemon
./install.sh --no-daemon    # bin only, no daemon
./install.sh --uninstall    # remove everything cleanly
```

After install:
- `stackai` works **from any directory** (global bin in `~/.local/bin`)
- The dashboard runs persistently at **http://127.0.0.1:42719** — auto-starts on
  login and auto-restarts on crash (launchd `KeepAlive`)
- Logs: `data/daemon.log` / `data/daemon.err.log`
- Manage: `launchctl list com.danslab.stack-ai-os`

The installer resolves node's absolute path (launchd runs with a minimal PATH)
so the daemon survives reboots reliably.

### Store a secret securely

```bash
stackai vault import-env             # migrate .env → Keychain
stackai vault set OPENAI_API_KEY     # prompts via stdin
stackai vault list                   # names only (never values)
```

---

## CLI reference

| Command | What |
|---|---|
| `stackai run "<task>" [--pattern ensemble] [--agent claude] [--model sonnet] [--cwd .] [--full-auto]` | Run a task (solo or pattern) |
| `stackai models [--agent <name>]` | Show model aliases + per-CLI resolution |
| `stackai patterns` | List pattern presets |
| `stackai doctor` / `doctor-agent <name>` | Probe adapters / smoke-test one (flag-drift detection) |
| `stackai adapters list` | Fleet + capabilities (model/json/mcp-c/mcp-s/acp/auto) |
| `stackai adapters add <name> <cmd> [flags...]` | Register any CLI into the fleet |
| `stackai adapters remove <name>` | Remove a dynamic adapter |
| `stackai runs [show <id>]` | Run history + candidates/scores |
| `stackai recall "<query>" [--code path]` | Query claude-mem + openclaw + graphify |
| `stackai vault {set\|get\|list\|delete\|import-env\|status}` | Manage secrets in Keychain |

---

## The fleet (verified on this machine)

| CLI | model | json | mcp-c | mcp-s | acp | auto |
|---|---|---|---|---|---|---|
| claude | ✓ | ✓ | ✓ | ✓ | | ✓ |
| codex | ✓ | ✓ | ✓ | ✓ | | ✓ |
| opencode | ✓ | ✓ | ✓ | ✓ | ✓ | |
| gemini | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| kimi | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| openclaude | ✓ | ✓ | ✓ | ✓ | | ✓ |
| pi | ✓ | ✓ | | | | |
| hermes | ✓ | ✓ | ✓ | ✓ | | ✓ |
| zcode | | ✓ | | ✓ | ✓ | ✓ |

`acp` agents get structured events via the ACP JSON-RPC session instead of
parsing each CLI's bespoke stream-json.

---

## Architecture

```
CLI / TUI / Web ──▶ KERNEL (scheduler · loop-engine · safety) ──▶ PATTERNS
                                                              ──▶ ADAPTERS (9 + dynamic)
                                                              ──▶ MEMORY (Obsidian · claude-mem · openclaw · graphify)
                                                              ──▶ MCP/ACP two-way bus
```

- **`src/types.ts`** — the shared `RunRequest`/`AgentEvent`/`AgentAdapter` vocabulary.
- **`src/adapters/`** — one adapter per CLI (`base.ts` shared machinery) + `generic.ts` for dynamic CLIs.
- **`src/kernel/`** — `scheduler.ts` (concurrency pool), `store.ts` (SQLite run store).
- **`src/patterns/`** — `solo.ts`, `ensemble.ts` (loop engine), `judge.ts` (rubric + verdict parser).
- **`src/models/router.ts`** — alias → per-CLI model id resolution.
- **`src/safety/policy.ts`** — cautious-by-default posture + hard guardrails.
- **`src/security/vault.ts`** — Keychain + AES-256-GCM file backend.
- **`src/memory/`** — `obsidian.ts` (vault_writer.py sink), `recall.ts` (claude-mem/openclaw/graphify), `run-logger.ts`.
- **`src/mcp/acp.ts`** — Agent Client Protocol client (JSON-RPC over stdio).
- **`src/cli/index.ts`** — the `stackai` command.

---

## Configuration

`config/` (edit freely):
- `agents.yaml` — per-CLI binary paths, defaults, enable flags, dynamic templates.
- `models.yaml` — alias → per-CLI model ids + per-pattern defaults.
- `patterns.yaml` — named pattern presets (ensemble width, budget, iters).

`data/` (gitignored): `run-store.sqlite`, run artifacts.
`.env` (gitignored): dev secrets — migrate to the vault.

---

## Status

- ✅ Phase 0–5 + 8: adapters, model router, dynamic fleet, safety, kernel (scheduler + run store), ensemble + judge loop engine, ACP integration, secure vault, Obsidian + memory recall, Tailscale mesh, web dashboard (:42719), MCP two-way bus, Fugu cloud judge.
- 🚧 Phase 6: Ink TUI (live orchestration + approvals).
- 🚧 Phase 9: pipeline/debate/divide-and-conquer patterns, full guardrails.

**65 tests green** (60 unit + 5 integration). See `docs/`.

## Documentation

- **[docs/AUTH.md](docs/AUTH.md)** — **authenticate your agents** (claude/codex/gemini/cline/deepseek/jcode). The one thing standing between you and a fully-live fleet.
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — system structure, core abstractions, the adapter/kernel/patterns/MCP design, ADRs, module reference.
- **[docs/DATA-FLOW.md](docs/DATA-FLOW.md)** — worked examples tracing solo/ACP/ensemble/MCP-recall/secure-key operations through every layer.
- **[docs/RESEARCH.md](docs/RESEARCH.md)** — OSS leverage analysis (ACP, Open Multi-Agent, Sakana Fugu).

---

## Design principles

1. **Your 9 CLIs *are* the agents.** No CrewAI/AutoGen dependency; we own a lean kernel.
2. **Adopt protocols, avoid frameworks.** MCP + ACP are the connective tissue.
3. **Reuse the memory stack.** Obsidian vault_writer, claude-mem, openclaw, graphify — never duplicate.
4. **Caps are enforced.** Budget/time/iteration limits never get exceeded.
5. **Secrets never touch the repo.** Keychain-first; the repo is public.

---

*Built for a Mac Studio fleet. Maintained by David.*

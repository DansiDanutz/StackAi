# Stack Ai OS — Data Flow

> Worked examples tracing real operations through every layer. Read alongside
> `ARCHITECTURE.md`. These reflect actual code paths, verified June 2026.

---

## Flow 1 — Solo run

```bash
stackai run "explain this function" --agent codex --model gpt5
```

```
CLI (cmdRun)
  ├─ loadConfig() → agents/models/patterns YAML
  ├─ createRegistry() → 10 adapters (9 + fugu) instantiated
  ├─ ModelRouterImpl(cfg.models)
  ├─ defaultPolicy()  [posture=cautious]
  └─ runSolo(adapter, router, opts, policy)
       │
       ├─ policy.validate(req)         ← guardrail check (throws on rm -rf / etc)
       ├─ req.posture = effectivePosture(req)   [cautious → no yolo flag]
       │
       └─ adapter.run(req, router)     ← CodexAdapter
            │
            ├─ capabilities.acpServer? NO (codex) → stream-json path
            ├─ buildCommand(req, router)
            │     cmd = /Users/davidai/.npm-global/bin/codex
            │     args = ["exec", "--json", "-m", "gpt-5-codex", "explain this function"]
            │
            └─ BaseAdapter.run():
                  spawn(cmd, args)
                  stdout → line-buffered → JSON.parse → parseEvent() → AgentEvent
                  on timeout: SIGTERM → SIGKILL
                  emit done{exitCode, finalText, sessionId}

  → result.finalText printed by the live renderer
  → exit(result.exitCode)
```

---

## Flow 2 — ACP-native run

```bash
stackai run "refactor X" --agent opencode
```

```
OpencodeAdapter.run()  (inherited from BaseAdapter)
  ├─ capabilities.acpServer = TRUE → check acpCommand()
  │     acpCommand() returns { cmd: "opencode", args: ["acp"] }
  │
  └─ runAcpSession()   ← src/mcp/acp.ts
       ├─ spawn("opencode", ["acp"])
       ├─ JsonRpcTransport: stdin/stdout JSON-RPC 2.0
       │
       ├─ request("initialize", {protocolVersion, clientCapabilities, clientInfo})
       ├─ request("session/new", {cwd, mode, config:{model}})
       ├─ request("session/prompt", {sessionId, prompt:[{type:"text",text}]})
       │
       ├─ meanwhile: "session/update" notifications buffer → mapSessionUpdate()
       │     task_start → system event
       │     agent_message → assistant(text)
       │     tool_call → tool_use
       │     tool_call_result → tool_result
       │     task_complete → system
       │
       └─ notify("session/close") + kill
          emit done{} (structured events, NOT stream-json parsing)
```

**Why this matters:** opencode/gemini/kimi/zcode get *reliable typed events*
without each CLI's bespoke stream-json shape being reverse-engineered.

---

## Flow 3 — Ensemble + Judge loop (the core)

```bash
stackai run "implement PKCE auth" --pattern ensemble --judge fugu --budget 1.00
```

```
runEnsembleCLI → runEnsemble()
  │
  ├─ createRun("ensemble", task, {budgetUsd:1.00})  → runId (SQLite)
  │
  └─ ITERATION 0:
       ├─ fanOut(): submit claude, codex, gemini to Scheduler (concurrency=4)
       │     Scheduler queues → runs ≤4 in parallel
       │     each → adapter.run() → RunResult{agent, finalText, costUsd}
       │     recordCandidate(runId, 0, result, model)  ← accumulates spend
       │
       ├─ budget check: spentUsd >= 1.00? stop if so
       │
       └─ judge():
            FuguAdapter.run()  ← cloud (SAKANA_API_KEY from vault)
              POST api.sakana.ai/v1/chat/completions {model:"fugu-ultra", stream:true}
              SSE deltas → assistant events → finalText (the verdict JSON)
            parseVerdict() → {scores, ranking, winner, action}
            onRound(iter, verdict)  ← CLI prints scores

       └─ action == "refine" && refineTarget set && caps remain?
            YES → refineOne(refineTarget):
              re-prompt the weakest agent with judge feedback + its prior output
              convergence check: similarity(before, after) >= 0.9? → stop
              recordCandidate(runId, iter, refined)
              → re-judge → loop

       action == "accept" → STOP (winner found)

  ├─ pick winner from final verdict's ranking
  ├─ updateRun(runId, {status:"done", winnerAgent, spentUsd, iterations, meta})
  │
  └─ logEnsembleRun(result):
       ObsidianSink.writeNote("ops", "Fleet/Stack-Ai-OS/Runs/<ts>-<id>", body, tags)
         → vault_writer.py write_note()  ← frontmatter + obsidian-git commit
       appendNote("ops", "Fleet/Stack-Ai-OS/INDEX", row)
       if failed: createIncident(...)

  → CLI prints: stoppedReason, scores, winner, spent, vault path
```

**Enforced caps:** budget (hard USD), iterations (max rounds), time (per-agent
timeout), convergence (≥90% token-overlap stops refinement). `stoppedReason`
records which one triggered.

---

## Flow 4 — MCP call-back (agents orchestrating agents)

A CLI agent (say, codex) is mid-task and wants a second opinion:

```
codex (running under Stack Ai OS, with injected mcp-config)
  └─ calls MCP tool "sao.ensemble"
       │
       └─ MCP server (src/mcp/server.ts, JSON-RPC over stdio)
            ├─ tools/call {name:"sao.ensemble", arguments:{task:"...", budgetUsd:0.5}}
            └─ dispatchTool("sao.ensemble"):
                 ├─ recursive runEnsemble()  ← the OS spawns a sub-ensemble!
                 └─ returns {winner, winnerText, scores} as tool result text

codex receives the ensemble's winning solution → continues its task
```

This is the loop-closing property: an agent, while working, can ask the OS to
spawn other agents. **Agents orchestrating agents.**

---

## Flow 5 — Memory recall (priming before solve)

```
stackai recall "how did we handle auth before"
  └─ recallAll(query):
       ├─ recallClaudeMem(query)  → HTTP :37777/search
       ├─ recallOpenclaw(query)   → `openclaw memory search --json`
       └─ recallGraphify(target)? → `graphify explain --json`
     formatContext(results) → context block (printed or prepended to a prompt)
```

Each backend degrades gracefully if offline (returns []).

---

## Flow 6 — Secure key access

```
adapter needs SAKANA_API_KEY
  └─ resolveSecret("SAKANA_API_KEY")   ← src/security/vault.ts
       ├─ macOS: keychainGet(key)  → `security find-generic-password -a SAKANA_API_KEY -s stack-ai-os -w`
       └─ fallback: fileGet(key, STACKAI_VAULT_PASS) → AES-256-GCM decrypt
       └─ final fallback: process.env[key]
     (never reads from the repo; .env is gitignored)
```

---

## Key invariant

**Every operation is observable and capped.** No run can exceed its budget,
no agent can bypass guardrails, every result is persisted (run store + Obsidian),
and every key is vaulted. The system fails safe: cloud down → degrade to local;
vault locked → clear error; CLI flags drift → doctor + unit tests catch it.

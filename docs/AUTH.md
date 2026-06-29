# Stack Ai OS — Authenticate Your Agents

> Most adapters are built but need their CLI's own credentials before they'll
> produce real output. This is the **only thing standing between you and a
> fully-live fleet.** Do these in any order; each unlocks one more agent for
> your ensembles.
>
> **Time:** ~10–15 min total if you have the keys ready.
>
> **Security:** store every key in the secure vault, never in the repo:
> ```bash
> stackai vault set <KEY_NAME>     # reads value from stdin, stores in macOS Keychain
> stackai vault list               # confirm it's stored (names only)
> ```

---

## Priority 1 — The cloud CLIs (highest value: true parallel multi-model ensembles)

These unlock the agents where the architecture shines: claude/codex/gemini
running *simultaneously* against different frontier models, judged, converged.

### claude (Claude Code) — Anthropic
Claude uses OAuth or an API key. The cleanest unattended path is an API key.

```bash
# 1. Get a key: https://console.anthropic.com/ → Settings → API Keys
# 2. Store it securely
stackai vault set ANTHROPIC_API_KEY     # paste the key, Enter

# 3. Make claude use it (export from vault in your shell profile)
echo 'export ANTHROPIC_API_KEY="$(stackai vault get ANTHROPIC_API_KEY 2>/dev/null)"' >> ~/.zshrc

# OR interactive OAuth login (opens browser):
claude auth      # follow the prompts
```
**Verify:** `claude -p "say OK"` → should print a response.

### codex (Codex CLI) — OpenAI
```bash
# 1. Get a key: https://platform.openai.com/api-keys
stackai vault set OPENAI_API_KEY
echo 'export OPENAI_API_KEY="$(stackai vault get OPENAI_API_KEY 2>/dev/null)"' >> ~/.zshrc

# OR interactive login:
codex login      # browser OAuth
```
**Verify:** `codex exec "say OK"` → response.

### gemini (Gemini CLI) — Google
Two options. The API key is the unattended path; OAuth needs a browser once.

```bash
# Option A — API key (best for headless/ensembles)
# Get one: https://aistudio.google.com/apikey
stackai vault set GEMINI_API_KEY
echo 'export GEMINI_API_KEY="$(stackai vault get GEMINI_API_KEY 2>/dev/null)"' >> ~/.zshrc

# Option B — OAuth (run once in a terminal)
gemini            # opens browser for Google login
```
**Verify:** `gemini -p "say OK"` → response.

---

## Priority 2 — The new fleet peers (cline, deepseek, jcode)

### cline — multi-provider (Anthropic/OpenAI/OpenRouter/Ollama/local)
Cline supports many providers. Two good options:

```bash
# Option A — point cline at your LOCAL ollama (no key needed!)
cline auth ollama \
  --baseurl http://127.0.0.1:11434 \
  --modelid qwen3-fast:latest

# Option B — Anthropic key (reuses the one from above)
cline auth anthropic \
  --apikey "$(stackai vault get ANTHROPIC_API_KEY)" \
  --modelid claude-sonnet-4-6
```
**Verify:** `cline -p "say OK" --json` → JSON with a `run_result` event.

### deepseek — DeepSeek model family (genuinely new models)
```bash
# 1. Get a key: https://platform.deepseek.com/ → API Keys
stackai vault set DEEPSEEK_API_KEY

# 2. Save it to deepseek's config
deepseek login --api-key "$(stackai vault get DEEPSEEK_API_KEY)"
```
**Verify:** `deepseek exec "say OK" --json` → response with `deepseek-chat`.

### jcode — Claude Max / ChatGPT subscription (different cost axis!)
Jcode's standout feature: it routes via your **subscriptions**, not API metering.
```bash
# Login interactively (OAuth) — picks up your Claude Max or ChatGPT Pro session
jcode login

# Check what you're connected to + usage limits
jcode usage
jcode auth           # status
```
**Verify:** `jcode run "say OK" --json` → response.
**Tip:** `jcode provider` lists 40+ providers; `jcode provider-doctor` debugs.

---

## Priority 3 — Local-only (already working, no cloud key needed)

These work **right now** without any auth — they're your baseline ensemble:

| Agent | Backend | Status |
|---|---|---|
| **openclaude** | local ollama (qwen3-fast) | ✅ live (proven in ensemble test) |
| **local-qwen3** | local ollama | ✅ live |
| **local-qwen-coder** | local ollama | ✅ live |
| **fugu** | cloud (Sakana) | needs `stackai vault set SAKANA_API_KEY` |

---

## After authenticating — run your first real multi-model ensemble

Once **2+ cloud CLIs** are unlocked (e.g. claude + codex), the system's full
design comes alive:

```bash
# 3 different frontier models solve the same task in parallel, judged by opus
stackai run "refactor auth.ts to use PKCE" \
  --pattern ensemble \
  --agents claude,codex,gemini \
  --judge claude \
  --model sonnet \
  --budget 1.00

# Or with the new agents for model diversity
stackai run "implement a rate limiter" \
  --pattern ensemble \
  --agents cline,deepseek,openclaude \
  --judge fugu
```

Watch it live:
- **Terminal:** events stream as each agent works, judge scores appear, winner is picked
- **Dashboard:** http://127.0.0.1:42719 → Runs tab fills in
- **Obsidian:** `Fleet/Stack-Ai-OS/Runs/` gets a note per ensemble (auto-committed)

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `401 Invalid authentication` | key not exported in this shell; re-source `~/.zshrc` or check `stackai vault get <KEY>` |
| `model 'X' not found` (cline+ollama) | model id mismatch — use exact `ollama list` name (e.g. `qwen3-fast:latest`, with colon) |
| agent hangs / no output | likely waiting on interactive login; run the agent's `login`/`auth` command once in a terminal |
| `stackai run` times out | ollama cold-start (~60s); warm it first: `curl http://127.0.0.1:11434/api/generate -d '{"model":"qwen3-fast:latest","prompt":"hi","stream":false}'` |
| Want to check which agents are ready | `stackai doctor` (probes binaries) + try each: `<agent> -p "say OK"` |

---

## Key reference (what goes in the vault)

| Key name | For | Where to get it |
|---|---|---|
| `ANTHROPIC_API_KEY` | claude, cline(anthropic) | console.anthropic.com |
| `OPENAI_API_KEY` | codex | platform.openai.com |
| `GEMINI_API_KEY` | gemini | aistudio.google.com/apikey |
| `DEEPSEEK_API_KEY` | deepseek | platform.deepseek.com |
| `SAKANA_API_KEY` | fugu (judge) | sakana.ai |
| `FIRECRAWL_API_KEY` | research (already stored) | firecrawl.dev |

All stored via `stackai vault set <NAME>`. Confirm with `stackai vault list`.

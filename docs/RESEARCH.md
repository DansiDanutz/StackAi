# Stack Ai OS — Leverage Research: Agent-to-Agent Orchestration OSS

Catalog of open-source projects found via Firecrawl research (2026-06-29) that
Stack Ai OS can learn from, interoperate with, or reuse. Each entry notes how
we leverage it.

> Source: research conducted via Firecrawl search across GitHub + docs. See the
> "How we use it" column — we adopt *ideas and protocols*, not hard dependencies,
> so Stack Ai OS stays self-contained and CLI-adapter-driven.

## Tier 1 — Direct leverage (adopt patterns / protocols)

| Project | Lang | Stars | What it is | How Stack Ai OS leverages it |
|---|---|---|---|---|
|---|---|---|---|---|
| **[Agent Client Protocol (ACP)](https://github.com/agentclientprotocol/agent-client-protocol)** | Rust/schema | 3.5k | The standardizing wire protocol for editor↔agent + agent↔agent (JSON-RPC, `initialize`, capabilities). Apache-2.0. | **4 of our CLIs already speak ACP** (opencode `acp`, gemini `--acp`, kimi `acp`, zcode). We map ACP → our `AgentEvent` type so ACP-native agents get structured events without stream-json parsing. Our MCP two-way bus (Phase 5) treats ACP as a first-class transport alongside MCP stdio. |
| **[Open Multi-Agent](https://github.com/open-multi-agent/open-multi-agent)** | TypeScript | — | "From a goal to a task DAG." A coordinator decomposes a goal into a DAG run on any LLM (Claude/OpenAI/Gemini/DeepSeek/local). Has a post-run dashboard. | **Same TS stack, same mission.** We adopt its **task-DAG decomposition** idea for our Phase 9 `divide-and-conquer` pattern (coordinator splits a task into a dependency graph of subtasks, fans out across agents, merges). Its DAG-executor + dashboard replay informed our web dashboard plan (Phase 7). |
| **Mysti** (HN: item 46365105) | — | — | "Claude, Codex, and Gemini debate your code, then synthesize." | **This is exactly our ensemble + judge + synthesize loop** (Phase 2), validating the architecture. We generalize it to all 9 CLIs + dynamic adapters, add budget/convergence caps, and persist results. |
| **[Sakana Fugu](https://sakana.ai/fugu/)** | API | — | Multi-agent orchestrator exposed as one OpenAI-compatible API. A "macro-level analogue of model merging" — composes frontier models (Claude/GPT/Gemini) at the system level. Two tiers: `fugu` (fast) + `fugu-ultra` (hard multi-step). [arXiv report](https://arxiv.org/html/2606.21228v1). | **Integrated as a cloud adapter + judge option** (`--judge fugu`). Fugu orchestrates *models*; Stack Ai OS orchestrates *tool-using CLIs* — complementary layers. Best fit: ranking our 9 CLI candidates (Fugu is built to evaluate/synthesize across frontier models). Opt-in and CLOUD (data leaves the machine): never used for private codebases by default. Key stored in the secure vault (`SAKANA_API_KEY`). |

## Tier 2 — Reference frameworks (study, don't depend on)

| Project | Lang | What | Take |
|---|---|---|---|
| **[microsoft/agent-framework (MAF)](https://github.com/microsoft/agent-framework)** | .NET/Py | Production multi-agent workflows, orchestrator patterns. | Orchestrator/agent-role abstractions for our pipeline + debate patterns. |
| **[VoltAgent](https://github.com/voltagent/voltagent)** | TS | Agent engineering platform w/ observability. | Observability hooks (step-level tracing) for our run store + web dashboard. |
| **[agent-orchestrator-ts (Kelsus)](https://github.com/Kelsus/agent-orchestrator-ts)** | TS | Lightweight TS orchestrator. | Minimal TS orchestration patterns to keep our kernel lean. |
| **[awesome-agent-orchestration](https://github.com/vivy-yi/awesome-agent-orchestration)** | — | Curated mega-list (AutoGen, CrewAI, MetaGPT, …). | Reference catalog for future pattern ideas (swarm, society-of-mind). |

## Tier 3 — Standards we interoperate with (not vendored)

| Standard | Status in Stack Ai OS |
|---|---|
| **MCP** (Model Context Protocol) | **Native.** Our two-way bus: OS exposes tools as an MCP server (Phase 5); injects shared MCP servers (context7, playwright, claude-mem:mcp-search, github) into agent runs. 8/9 CLIs are MCP clients. |
| **ACP** (Agent Client Protocol) | **Native.** Unified agent↔agent transport; ACP-native CLIs bypass stream-json parsing. |
| **OpenAI-compatible API** | Hermes exposes a local OpenAI-compatible proxy (`hermes proxy`); openclaw gateway is OpenAI-compatible. We can route to these as "model providers" in the model router. |

## Decisions (what we will NOT do)

- **No hard dependency on CrewAI / AutoGen / LangGraph.** They're Python, opinionated, and would fight our adapter-driven design. Our 9 CLIs *are* the agents.
- **No vendoring of MAF/VoltAgent.** They're platforms; we borrow patterns.
- **We own the kernel.** Orchestration logic (scheduler, loop-engine, judge) is ours, tailored to the "9 CLI fleet + budget caps + Obsidian memory" reality of this Mac Studio.

## Next research targets (when relevant)
- ACP v2 schema for agent↔agent messaging beyond editor↔agent.
- Swarm-intelligence / Mixture-of-Agents (MoA) patterns for the `debate` pattern.
- Cross-machine task routing policies for the Tailscale fleet mesh (Phase 4).

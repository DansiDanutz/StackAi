/**
 * Stack Ai OS — Run → Obsidian persistence
 *
 * After an ensemble (or solo) run completes, this writes a structured note to
 * the DansLab vault so the result joins the rest of your fleet's knowledge base.
 *
 * Layout under ops:Fleet/Stack-Ai-OS/:
 *   INDEX.md                      — running table of all runs (appended)
 *   Runs/<id>.md                  — per-run detail (task, candidates, winner, scores)
 *   Learnings/<slug>.md           — notable wins/insights (only when flagged)
 *
 * Uses the existing vault_writer.py so obsidian-git auto-commits everything.
 */
import { getObsidianSink, type VaultKey } from "./obsidian.js";
import type { EnsembleResult } from "../patterns/ensemble.js";
import type { RunResult } from "../types.js";

const VAULT: VaultKey = "ops";
const BASE = "Fleet/Stack-Ai-OS";

function dateStamp(): string {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
}

function shortDate(): string {
  return new Date().toISOString().slice(0, 16).replace("T", " ");
}

/** Log an ensemble run to Obsidian. Returns the note path written, or null. */
export function logEnsembleRun(result: EnsembleResult): string | null {
  const sink = getObsidianSink();
  if (!sink.enabled) return null;

  const runDate = dateStamp();
  const notePath = `${BASE}/Runs/${runDate}-${result.runId.slice(0, 8)}`;
  const winner = result.winner;
  const verdict = result.verdict;

  const body = [
    `**Run:** \`${result.runId}\``,
    `**Pattern:** ensemble`,
    `**Stopped:** ${result.stoppedReason}`,
    `**Iterations:** ${result.iterations}`,
    `**Task:**`,
    "",
    "> " + truncateForQuote(firstLine(result.allCandidates[0]?.result.finalText ?? "") || "(task captured in run store)"),
    "",
    "## Result",
    "",
    winner
      ? `- **Winner:** ${winner.result.agent}${winner.model ? ` (${winner.model})` : ""}`
      : "- **Winner:** (none)",
    `- **Spent:** $${(result.spentUsd ?? 0).toFixed(4)}`,
    "",
    "## Verdict",
    "",
    verdict
      ? `- Action: \`${verdict.action}\`\n- Ranking: ${verdict.ranking.join(" > ") || "—"}\n- Scores: ${JSON.stringify(verdict.scores)}`
      : "- (no judge verdict)",
    "",
    "## Candidates",
    "",
    "| Agent | Iter | Score | Exit | Duration |",
    "|-------|------|-------|------|----------|",
    ...result.allCandidates.map((c, i) => {
      const label = "ABCDEFGH"[i] ?? "?";
      const score = verdict?.scores[label] ?? "—";
      return `| ${c.result.agent} | ${0} | ${score} | ${c.result.exitCode} | ${(c.result.durationMs / 1000).toFixed(1)}s |`;
    }),
    "",
    "## Winner Output",
    "",
    "```",
    truncate(winner?.result.finalText ?? "(no output)", 4000),
    "```",
    "",
    `_Logged by Stack Ai OS · ${shortDate()}_`,
  ].join("\n");

  const written = sink.writeNote(VAULT, notePath, body, ["stack-ai-os", "ensemble", "run"]);

  // Append a row to the INDEX.
  if (written) {
    const row = `- [[${notePath}|${runDate}]] — ${result.stoppedReason} — winner: ${winner?.result.agent ?? "—"} — $${(result.spentUsd ?? 0).toFixed(3)}`;
    sink.appendNote(VAULT, `${BASE}/INDEX`, row + "\n");
  }

  // Failed runs → incident note (matches the fleet convention).
  if (result.stoppedReason === "error" || (!winner && result.stoppedReason !== "converged")) {
    sink.createIncident(VAULT, "stack-ai-os", `Ensemble run ${result.runId} ${result.stoppedReason}: ${firstLine(result.allCandidates[0]?.result.finalText ?? "").slice(0, 120)}`, ["stack-ai-os"]);
  }

  return written;
}

/** Log a solo run to Obsidian (lighter: a line in INDEX + optional note). */
export function logSoloRun(result: RunResult, task: string): string | null {
  const sink = getObsidianSink();
  if (!sink.enabled) return null;

  const row = `- ${dateStamp().slice(0, 16)} — solo ${result.agent} exit=${result.exitCode} ${(result.durationMs / 1000).toFixed(1)}s — ${firstLine(task).slice(0, 60)}`;
  return sink.appendNote(VAULT, `${BASE}/INDEX`, row + "\n");
}

/** Log a full chat session transcript to Obsidian. Returns the note path. */
export function logChatSession(session: {
  id: string; agent: string; title: string; startedAt: string; endedAt?: string;
  messages: { role: "user" | "assistant"; text: string; agent: string; ts: string }[];
  turnCount: number;
}): string | null {
  const sink = getObsidianSink();
  if (!sink.enabled) return null;

  const runDate = dateStamp();
  const slug = session.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  const notePath = `${BASE}/Chats/${runDate.slice(0, 10)}-${slug || session.id.slice(0, 8)}`;
  const duration = session.endedAt && session.startedAt
    ? `${Math.round((new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime()) / 1000)}s`
    : "—";

  const body = [
    `**Session:** \`${session.id}\``,
    `**Agent:** ${session.agent}`,
    `**Turns:** ${session.turnCount}`,
    `**Duration:** ${duration}`,
    `**Started:** ${session.startedAt}`,
    "",
    "## Transcript",
    "",
    ...session.messages.map((m) => {
      const who = m.role === "user" ? "🧑 **You**" : `🤖 **${m.agent}**`;
      return `### ${who}  · ${m.ts.slice(11, 19)}\n\n${m.text}`;
    }),
    "",
    `_Logged by Stack Ai OS · ${shortDate()}_`,
  ].join("\n");

  const written = sink.writeNote(VAULT, notePath, body, ["stack-ai-os", "chat"]);

  if (written) {
    const row = `- [[${notePath.slice(notePath.lastIndexOf("/") + 1)}|${runDate.slice(0, 16)}]] — chat ${session.agent} (${session.turnCount} turns) — ${truncate(firstLine(session.title), 50)}`;
    sink.appendNote(VAULT, `${BASE}/INDEX`, row + "\n");
  }
  return written;
}

/** Log a learning (insight worth keeping) to the Learnings folder. */
export function logLearning(title: string, content: string, tags: string[] = []): string | null {
  const sink = getObsidianSink();
  if (!sink.enabled) return null;
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
  return sink.writeNote(VAULT, `${BASE}/Learnings/${dateStamp().slice(0, 10)}-${slug}`, content, ["stack-ai-os", "learning", ...tags]);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "\n…(truncated)" : s;
}
function firstLine(s: string): string {
  return s.split("\n").find((l) => l.trim().length > 0) ?? "";
}
function truncateForQuote(s: string): string {
  return s.replace(/\n/g, "\n> ").slice(0, 200);
}

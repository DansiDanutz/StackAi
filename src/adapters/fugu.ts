/**
 * Stack Ai OS — Sakana Fugu adapter (CLOUD, OpenAI-compatible API)
 *
 * Fugu is itself a multi-agent orchestrator exposed as one OpenAI-compatible
 * endpoint. It's the highest-leverage fit for two roles in Stack Ai OS:
 *
 *   1. JUDGE:  Fugu is built to evaluate/synthesize across frontier models, so
 *      it ranks our CLI candidates well. `--judge fugu` routes the ensemble's
 *      judge step here instead of to claude.
 *   2. CANDIDATE (opt-in): for non-coding text/reasoning subtasks (planning,
 *      analysis), Fugu can be a candidate producer alongside local CLIs.
 *
 * Unlike the 9 local CLI adapters, Fugu is a pure HTTP API call — no child
 * process, no ACP, no file tools. It is CLOUD: data leaves the machine. It is
 * therefore OPT-IN and never used for private/secret codebases by default.
 *
 * API: POST https://api.sakana.ai/v1/chat/completions  (OpenAI shape)
 * Models: "fugu" (fast) | "fugu-ultra" (hard multi-step).
 * Key: resolved from the secure vault (SAKANA_API_KEY) — never hardcoded.
 */
import { resolveSecret } from "../security/vault.js";
import type { AgentEvent, ModelRouter, RunRequest } from "../types.js";
import type { AgentAdapter } from "../types.js";

const FUGU_BASE = process.env.FUGU_API_BASE ?? "https://api.sakana.ai/v1";

export class FuguAdapter implements AgentAdapter {
  readonly name = "fugu";
  readonly dynamic = false;
  displayName = "Sakana Fugu";
  readonly capabilities = {
    // Fugu is text-only via API: it can select model (fugu/fugu-ultra) and
    // streams, but has NO file tools, NO MCP, NO ACP, NO full-auto concept.
    jsonStream: true,
    modelSelection: true,
    mcpClient: false,
    mcpServer: false,
    sessionResume: false,
    fullAuto: false,
    acpServer: false,
  };

  /** Cloud adapters aren't local CLIs — they're API-backed. */
  get isCloud(): boolean { return true; }

  resolveModel(alias: string): string {
    if (!alias || alias === "auto") return "fugu"; // Fugu default = fast tier
    if (alias === "ultra" || alias === "fugu-ultra") return "fugu-ultra";
    if (alias === "fast" || alias === "fugu") return "fugu";
    return alias;
  }

  /**
   * For Fugu, buildCommand is not used (no child process). We implement run()
   * directly as an HTTP streaming call. Kept for interface parity — returns a
   * marker so callers know to use run() not spawn.
   */
  buildCommand(_req: RunRequest, _router: ModelRouter): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } {
    return { cmd: "fugu-api", args: ["(cloud — use run())"], env: {} };
  }

  parseEvent(_raw: unknown): AgentEvent | null {
    return null; // Fugu events are produced inline by run() below.
  }

  /** Run a prompt against Fugu, yielding normalized AgentEvents. */
  async *run(req: RunRequest, _router: ModelRouter): AsyncIterable<AgentEvent> {
    const key = resolveSecret("SAKANA_API_KEY");
    if (!key) {
      yield {
        type: "error",
        message:
          "SAKANA_API_KEY not set. Store it with: stackai vault set SAKANA_API_KEY <key> " +
          "(or set the SAKANA_API_KEY env var).",
        recoverable: false,
      };
      yield { type: "done", exitCode: 1, finalText: "" };
      return;
    }

    const model = this.resolveModel(req.model ?? "fugu");
    const timeoutMs = (req.timeoutSec ?? 300) * 1000;
    const start = Date.now();

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const resp = await fetch(`${FUGU_BASE}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: req.prompt }],
        stream: true,
      }),
      });

      clearTimeout(timer);

      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        yield {
          type: "error",
          message: `Fugu API ${resp.status}: ${errText.slice(0, 300)}`,
          recoverable: resp.status >= 500,
        };
        yield { type: "done", exitCode: 1, finalText: "" };
        return;
      }

      // Parse the SSE stream (OpenAI delta format).
      let finalText = "";
      const reader = resp.body?.getReader();
      if (!reader) throw new Error("no response body");

      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += new TextDecoder().decode(value);
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") continue;
          try {
            const evt = JSON.parse(data);
            const delta = evt.choices?.[0]?.delta?.content ?? "";
            if (delta) {
              finalText += delta;
              yield { type: "assistant", subtype: "text", text: delta };
            }
            if (evt.usage) {
              yield {
                type: "cost",
                inputTokens: evt.usage.prompt_tokens,
                outputTokens: evt.usage.completion_tokens,
              };
            }
          } catch {
            // partial JSON across chunks — skip, will complete next read
          }
        }
      }

      yield {
        type: "done",
        exitCode: 0,
        finalText,
      };
    } catch (e) {
      const timedOut = Date.now() - start >= timeoutMs;
      yield {
        type: "error",
        message: (e as Error).name === "AbortError" ? "Fugu request timed out" : (e as Error).message,
        recoverable: false,
      };
      yield { type: "done", exitCode: timedOut ? 124 : 1, finalText: "" };
    }
  }
}

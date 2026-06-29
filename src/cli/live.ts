/**
 * Stack Ai OS — CLI live event renderer
 *
 * Prints normalized AgentEvents to the terminal as they stream. The TUI (Phase
 * 6) replaces this with a full Ink interface; for now it makes `stackai run`
 * observable. Quiet mode emits only the final text.
 */
import { Writable } from "node:stream";
import type { AgentEvent, AgentName } from "../types.js";

const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";
const RESET = "\x1b[0m";

export function makeLiveRenderer(out: Writable, opts?: { agent?: AgentName; quiet?: boolean }) {
  const tag = opts?.agent ? `${MAGENTA}[${opts.agent}]${RESET} ` : "";
  const quiet = opts?.quiet ?? false;

  return (evt: AgentEvent) => {
    if (quiet) {
      if (evt.type === "done" && evt.finalText) {
        out.write(evt.finalText + "\n");
      }
      return;
    }
    switch (evt.type) {
      case "system":
        if (evt.subtype === "init") out.write(`${tag}${DIM}${evt.message}${RESET}\n`);
        break;
      case "assistant":
        if (evt.subtype === "thinking")
          out.write(`${tag}${DIM}thinking: ${truncate(evt.text, 160)}${RESET}\n`);
        else if (evt.text) out.write(`${tag}${evt.text}`);
        break;
      case "tool_use":
        out.write(`${tag}${CYAN}→ ${evt.name}${RESET}\n`);
        break;
      case "tool_result":
        if (evt.isError) out.write(`${tag}${RED}✗ ${truncate(evt.content, 200)}${RESET}\n`);
        else out.write(`${tag}${DIM}${truncate(evt.content, 120)}${RESET}\n`);
        break;
      case "cost":
        out.write(
          `${tag}${YELLOW}tokens: in=${evt.inputTokens ?? "?"} out=${evt.outputTokens ?? "?"}` +
            (evt.costUsd != null ? ` $${evt.costUsd.toFixed(4)}` : "") +
            `${RESET}\n`
        );
        break;
      case "error":
        out.write(`${tag}${RED}error: ${evt.message}${RESET}\n`);
        break;
      case "done":
        out.write(
          `${tag}${GREEN}done${RESET} ` +
            `${DIM}exit=${evt.exitCode}${evt.sessionId ? ` session=${evt.sessionId}` : ""}${RESET}\n`
        );
        break;
    }
  };
}

function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n) + "…" : one;
}

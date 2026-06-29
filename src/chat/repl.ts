/**
 * Stack Ai OS — Chat REPL (interactive terminal interface)
 *
 * A readline-based conversation loop. Each user message triggers one agent turn
 * (streamed live), with full conversation context carried across turns. Slash
 * commands manage the session. On exit (or /save), the transcript is documented
 * to Obsidian + the run store + a resumable history file.
 */
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { AgentName, ModelRouter } from "../types.js";
import type { AdapterRegistry } from "../adapters/registry.js";
import type { SafetyPolicy } from "../safety/policy.js";
import { ChatSession, newSessionId } from "./session.js";
import { saveSession, listSessions, loadSession, registerSessionInStore, recordTurnInStore, finalizeSessionInStore } from "./history.js";
import { logChatSession } from "../memory/run-logger.js";
import { makeLiveRenderer } from "../cli/live.js";

const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

export interface ChatReplOptions {
  registry: AdapterRegistry;
  router: ModelRouter;
  policy: SafetyPolicy;
  agent: AgentName;
  model?: string;
  cwd?: string;
  /** Resume an existing session by id. */
  resumeId?: string;
}

/** Start the interactive chat REPL. Returns when the user exits. */
export async function startChatRepl(opts: ChatReplOptions): Promise<void> {
  // Load or create the session.
  let session: ChatSession;
  if (opts.resumeId) {
    const loaded = loadSession(opts.resumeId);
    if (!loaded) {
      output.write(`${YELLOW}Session '${opts.resumeId}' not found.${RESET}\n`);
      return;
    }
    session = loaded;
    session.agent = opts.agent; // allow override on resume
    output.write(`${DIM}Resumed session: ${session.title} (${session.turnCount} turns)${RESET}\n`);
  } else {
    session = new ChatSession({
      id: newSessionId(),
      agent: opts.agent,
      model: opts.model,
      cwd: opts.cwd,
      title: "untitled chat",
      startedAt: new Date().toISOString(),
      messages: [],
    });
    await registerSessionInStore(session);
  }

  // Track turn index for run-store candidate recording.
  let turnIndex = session.turnCount;

  const rl = readline.createInterface({ input, output, prompt: "" });
  printBanner(session);
  printHelp();

  const ask = (): void => {
    rl.setPrompt(`${CYAN}> ${RESET}`);
    rl.prompt();
  };

  rl.on("SIGINT", () => { void exit(); });
  ask();

  // Track stdin EOF so we exit cleanly instead of prompting a closed readline.
  let stdinClosed = false;
  input.on("close", () => { stdinClosed = true; });

  for await (const line of rl) {
    const text = line.trim();
    if (!text) { ask(); continue; }

    // Slash commands.
    if (text.startsWith("/")) {
      const handled = await handleSlashCommand(text, session, opts.registry);
      if (handled === "exit") { await exit(); return; }
      if (handled) { ask(); continue; }
    }

    // Regular user message → run a turn.
    if (!session.title || session.title === "untitled chat") {
      session.title = ChatSession.deriveTitle(text);
    }

    const renderer = makeLiveRenderer(output, { agent: session.agent });
    output.write(`${DIM}── ${session.agent} thinking ──${RESET}\n`);
    const start = Date.now();
    try {
      const result = await session.turn(opts.registry, opts.router, opts.policy, text, {
        onEvent: (_agent, evt) => renderer(evt),
      });
      void renderer; // referenced
      await recordTurnInStore(session, turnIndex, {
        agent: result.agent, exitCode: result.exitCode, finalText: result.finalText,
        durationMs: Date.now() - start, sessionId: result.sessionId, timedOut: result.timedOut,
      });
      turnIndex++;
      output.write(`${GREEN}── done (${result.exitCode === 0 ? "ok" : `exit ${result.exitCode}`}, ${((Date.now() - start) / 1000).toFixed(1)}s) ──${RESET}\n`);
    } catch (e) {
      output.write(`${YELLOW}Error: ${(e as Error).message}${RESET}\n`);
    }

    // Auto-save the session after each turn (so a crash never loses history).
    await saveSession(session);
    // Guard: if stdin closed (EOF) during the turn, exit instead of prompting.
    if (stdinClosed) { await exit(); return; }
    ask();
  }

  // The for-await loop ended (stdin EOF or /exit didn't fire) — clean exit.
  await exit();

  async function exit(): Promise<void> {
    session.endedAt = new Date().toISOString();
    await saveSession(session);
    await finalizeSessionInStore(session);
    const vaultPath = logChatSession(session);
    output.write(`\n${DIM}Session saved.${RESET} ${vaultPath ? `${DIM}Transcript → ${vaultPath}${RESET}` : ""}\n`);
    rl.close();
  }
}

/** Handle a slash command. Returns true if handled, "exit" to quit, false if unknown. */
async function handleSlashCommand(text: string, session: ChatSession, registry: AdapterRegistry): Promise<boolean | "exit"> {
  const [cmd, ...rest] = text.slice(1).split(/\s+/);
  const arg = rest.join(" ").trim();

  switch (cmd) {
    case "help":
      printHelp();
      return true;
    case "exit":
    case "quit":
    case "q":
      return "exit";
    case "switch": {
      if (!arg) { output.write(`${YELLOW}Usage: /switch <agent>${RESET}\n`); return true; }
      if (!registry.get(arg as AgentName)) {
        output.write(`${YELLOW}Unknown agent: ${arg}. Try: /agents${RESET}\n`);
        return true;
      }
      session.switchAgent(arg as AgentName);
      output.write(`${GREEN}Switched to ${arg}.${RESET}\n`);
      return true;
    }
    case "agents": {
      output.write(`${DIM}Available agents:${RESET}\n`);
      for (const a of registry.enabled()) output.write(`  ${a.name.padEnd(14)} ${a.displayName}\n`);
      return true;
    }
    case "save": {
      session.endedAt = new Date().toISOString();
      await saveSession(session);
      const vaultPath = logChatSession(session);
      output.write(`${GREEN}Saved.${RESET} ${vaultPath ? `${DIM}Transcript → ${vaultPath}${RESET}` : ""}\n`);
      session.endedAt = undefined; // keep going
      return true;
    }
    case "clear":
      session.clear();
      output.write(`${GREEN}Context cleared (session continues, history reset).${RESET}\n`);
      return true;
    case "title": {
      if (!arg) { output.write(`${YELLOW}Current title: ${session.title}${RESET}\n`); return true; }
      session.title = arg;
      output.write(`${GREEN}Title set: ${arg}${RESET}\n`);
      return true;
    }
    case "history": {
      const sessions = listSessions();
      if (!sessions.length) { output.write(`${DIM}No saved sessions.${RESET}\n`); return true; }
      output.write(`${DIM}Recent sessions:${RESET}\n`);
      for (const s of sessions.slice(0, 10)) {
        output.write(`  ${s.id.padEnd(22)} ${s.agent.padEnd(10)} ${s.startedAt.slice(0, 16)} — ${s.title.slice(0, 40)} (${s.messageCount} msgs)\n`);
      }
      output.write(`${DIM}Resume with: stackai chat --resume <id>${RESET}\n`);
      return true;
    }
    case "info": {
      output.write(`${DIM}Session:  ${session.id}${RESET}\n`);
      output.write(`${DIM}Agent:    ${session.agent}${RESET}\n`);
      output.write(`${DIM}Title:    ${session.title}${RESET}\n`);
      output.write(`${DIM}Turns:    ${session.turnCount}${RESET}\n`);
      output.write(`${DIM}Messages: ${session.messages.length}${RESET}\n`);
      return true;
    }
    default:
      output.write(`${YELLOW}Unknown command: /${cmd}. Try /help${RESET}\n`);
      return true;
  }
}

function printBanner(session: ChatSession): void {
  output.write(`\n${BOLD}Stack ${CYAN}Ai OS${RESET} ${BOLD}— chat${RESET}\n`);
  output.write(`${DIM}agent: ${session.agent}  ·  session: ${session.id}  ·  type /help for commands${RESET}\n\n`);
}

function printHelp(): void {
  output.write(`${DIM}Commands: /help · /switch <agent> · /agents · /save · /clear · /title <text> · /history · /info · /exit${RESET}\n`);
}

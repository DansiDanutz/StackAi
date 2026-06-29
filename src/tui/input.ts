/**
 * Stack Ai OS — TUI keyboard input (raw mode)
 *
 * Puts the terminal in raw mode and decodes keypresses into semantic events.
 * The main app subscribes to a callback. Handles arrows, Enter, Esc, Ctrl+C,
 * Tab (command palette), and typed text (for the palette filter).
 */
import { stdin } from "node:process";
import { emitKeypressEvents } from "node:readline";

export interface KeyEvent {
  name: string;        // up/down/left/right/return/escape/tab/backspace/space
  ctrl: boolean;
  sequence?: string;   // raw chars (for typed text)
}

export class Input {
  private listener: ((e: KeyEvent) => void) | null = null;
  private active = false;

  start(onKey: (e: KeyEvent) => void): void {
    this.listener = onKey;
    if (stdin.isTTY) {
      stdin.setRawMode(true);
      stdin.resume();
      emitKeypressEvents(stdin);
      this.active = true;
      stdin.on("keypress", this.handler);
    }
  }

  private handler = (_str: string, key: any) => {
    if (!key) return;
    // Ctrl+C → exit cleanly
    if (key.ctrl && key.name === "c") {
      this.stop();
      process.exit(0);
      return;
    }
    this.listener?.({
      name: key.name ?? "",
      ctrl: Boolean(key.ctrl),
      sequence: key.sequence,
    });
  };

  stop(): void {
    if (this.active && stdin.isTTY) {
      stdin.removeListener("keypress", this.handler);
      stdin.setRawMode(false);
      stdin.pause();
      this.active = false;
    }
  }
}

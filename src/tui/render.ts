/**
 * Stack Ai OS — Lightweight TUI renderer (pure ANSI, no React/ink dep)
 *
 * A minimal immediate-mode terminal renderer: clear, draw boxes/text, flush.
 * Paired with a raw-mode keyboard handler (input.ts). This keeps the TUI
 * dependency-free (consistent with the web server's zero-dep approach) while
 * delivering a real, usable live interface.
 *
 * Coordinate system: 1-based rows/cols. The renderer tracks height to know
 * how many lines to clear on re-render.
 */
import { stdout } from "node:process";

const ESC = "\x1b[";
export const CLEAR = ESC + "2J" + ESC + "H";
export const CLEAR_LINE = ESC + "2K";
export const HIDE_CURSOR = ESC + "?25l";
export const SHOW_CURSOR = ESC + "?25h";

// Colors
export const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  bgBlue: "\x1b[44m",
  bgGray: "\x1b[48;5;236m",
};

export class Renderer {
  private lines: string[] = [];
  private lastHeight = 0;

  /** Begin a fresh frame. */
  begin(): void {
    this.lines = [];
  }

  /** Add a line to the current frame (ANSI codes allowed). */
  line(text = ""): void {
    this.lines.push(text);
  }

  /** Add a box with a title and body lines. */
  box(title: string, body: string[], color = C.blue): void {
    const width = Math.min(stdout.columns || 80, 100);
    const top = `${color}┌─ ${C.bold}${title}${C.reset}${color}${"─".repeat(Math.max(0, width - title.length - 3))}┐${C.reset}`;
    this.line(top);
    for (const b of body) {
      const truncated = b.length > width - 4 ? b.slice(0, width - 5) + "…" : b;
      this.line(`${color}│${C.reset} ${truncated}${color}${" ".repeat(Math.max(0, width - truncated.length - 4))}│${C.reset}`);
    }
    this.line(`${color}└${"─".repeat(width - 2)}┘${C.reset}`);
  }

  /** Flush the frame to the terminal. */
  flush(): void {
    // Move cursor up to the start of the previous frame and clear lines.
    if (this.lastHeight > 0) {
      stdout.write(ESC + `${this.lastHeight}A`);
    }
    for (let i = 0; i < this.lastHeight; i++) {
      stdout.write(ESC + "1E" + CLEAR_LINE);
    }
    stdout.write(this.lines.join("\n") + "\n");
    this.lastHeight = this.lines.length + 1;
  }

  /** Reset terminal state on exit. */
  destroy(): void {
    stdout.write(SHOW_CURSOR);
  }
}

/** Build a progress bar string: ▓▓▓▓░░░░ 50% */
export function progressBar(value: number, total: number, width = 16): string {
  const ratio = total > 0 ? Math.min(1, value / total) : 0;
  const filled = Math.round(ratio * width);
  return `${C.green}${"▓".repeat(filled)}${C.gray}${"░".repeat(width - filled)}${C.reset} ${Math.round(ratio * 100)}%`;
}

/** Truncate a string to fit, with ellipsis. */
export function trunc(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

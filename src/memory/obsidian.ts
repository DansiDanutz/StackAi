/**
 * Stack Ai OS — Obsidian sink
 *
 * Writes run results + learnings to the DansLab Obsidian vault by calling the
 * EXISTING vault_writer.py (the canonical write path Claude/Codex/Hermes/etc.
 * already use on this Mac Studio). Reusing it means: proper frontmatter,
 * obsidian-git auto-commit, and the same schema the rest of your fleet expects.
 *
 * Refs:
 *   ~/DansLab-Vault/VAULT_INTEGRATION.md   (the contract)
 *   ~/.openclaw/scripts/vault_writer.py     (the implementation)
 *
 * vault keys: "ops" → ~/DansLab-Vault , "wiki" → iCloud My-Wiki.
 *
 * Stack Ai OS writes to:  ops:Fleet/Stack-Ai-OS/  (runs, learnings, index)
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const VAULT_WRITER = "/Users/davidai/.openclaw/scripts/vault_writer.py";
const REDIS_HOST_FALLBACK = "127.0.0.1";
const REDIS_PORT = 6379;
const REDIS_STREAM = "dls.obsidian.requests";

export type VaultKey = "ops" | "wiki";

export interface ObsidianSinkOptions {
  /** Use the local vault_writer.py (Mac Studio). Default true. */
  local?: boolean;
  /** Python binary. Default "python3". */
  python?: string;
  /** Redis host for the remote/droplet path. Default 127.0.0.1. */
  redisHost?: string;
  /** Disable writes entirely (no-op sink). */
  disabled?: boolean;
}

/**
 * Obsidian sink. On the Mac Studio it writes via vault_writer.py directly; on
 * droplets/remote peers it would push to the Redis stream that the obsidian-bridge
 * daemon consumes (same contract, different transport).
 */
export class ObsidianSink {
  constructor(private opts: ObsidianSinkOptions = {}) {}

  get enabled(): boolean {
    return !this.opts.disabled && (this.localAvailable() || this.redisAvailable());
  }

  private localAvailable(): boolean {
    return this.opts.local !== false && existsSync(VAULT_WRITER);
  }

  private redisAvailable(): boolean {
    // Best-effort: we assume redis-cli exists. Actual availability checked at call.
    return this.opts.local === false;
  }

  /** Create or overwrite a note (with frontmatter). Returns the written path. */
  writeNote(vault: VaultKey, notePath: string, content: string, tags?: string[]): string | null {
    if (!this.enabled) return null;
    if (this.localAvailable()) {
      return this.runWriter(
        "write_note", [vault, notePath, content],
        tags ? { tags } : undefined
      );
    }
    return this.redisWrite("write", vault, notePath, content, tags);
  }

  /** Append to a note (creates if missing, bumps updated date). */
  appendNote(vault: VaultKey, notePath: string, content: string): string | null {
    if (!this.enabled) return null;
    if (this.localAvailable()) {
      return this.runWriter("append_note", [vault, notePath, content]);
    }
    return this.redisWrite("append", vault, notePath, content);
  }

  /** Create a timestamped incident note (used for failed runs / alerts). */
  createIncident(vault: VaultKey, agent: string, content: string, tags?: string[]): string | null {
    if (!this.enabled) return null;
    if (this.localAvailable()) {
      return this.runWriter("create_incident", [vault, agent, content], tags ? { tags } : undefined);
    }
    return this.redisWrite("create-incident", vault, "", content, tags, agent);
  }

  // ---- internal: invoke vault_writer.py --------------------------------

  private runWriter(fn: string, positional: string[], kw?: Record<string, unknown>): string | null {
    const py = this.opts.python ?? "python3";
    // Pass the Python script via stdin (-) and args as JSON, avoiding all shell
    // escaping pitfalls with arbitrary note content.
    const kwJson = kw ? JSON.stringify(kw) : "{}";
    const posJson = JSON.stringify(positional);
    const script = `import json, sys\nsys.path.insert(0, "/Users/davidai/.openclaw/scripts")\nfrom vault_writer import ${fn}\n_args = json.loads(sys.argv[1])\n_kw = json.loads(sys.argv[2])\nprint(${fn}(*_args, **_kw))\n`;
    try {
      const res = spawnSync(py, ["-", posJson, kwJson], {
        input: script,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
      if (res.status !== 0) {
        console.error(`[obsidian] ${fn} failed: ${res.stderr?.slice(0, 300) ?? "nonzero exit"}`);
        return null;
      }
      return (res.stdout ?? "").trim() || null;
    } catch (e) {
      // Non-fatal — a vault write failure must never break a run.
      console.error(`[obsidian] ${fn} failed: ${(e as Error).message}`);
      return null;
    }
  }

  // ---- internal: Redis bridge (remote peers) ---------------------------

  private redisWrite(
    action: string, vault: VaultKey, query: string, content: string,
    tags?: string[], agent?: string
  ): string | null {
    const host = this.opts.redisHost ?? REDIS_HOST_FALLBACK;
    const fields = [
      "action", action, "vault", vault, "query", query,
      "content", content, "agent", agent ?? "stack-ai-os",
    ];
    if (tags?.length) fields.push("tags", tags.join(","));
    try {
      // XADD with '*' for server-assigned id.
      const args = fields.map((f) => JSON.stringify(f)).join(" ");
      execSync(
        `redis-cli -h ${host} -p ${REDIS_PORT} XADD ${REDIS_STREAM} '*' ${args}`,
        { encoding: "utf8", stdio: ["ignore", "ignore", "ignore"] }
      );
      return query || null;
    } catch (e) {
      console.error(`[obsidian] redis write failed: ${(e as Error).message}`);
      return null;
    }
  }
}

let _sink: ObsidianSink | null = null;
export function getObsidianSink(opts?: ObsidianSinkOptions): ObsidianSink {
  return (_sink ??= new ObsidianSink(opts));
}

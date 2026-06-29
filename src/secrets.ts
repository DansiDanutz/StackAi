/**
 * Stack Ai OS — Secrets loader
 *
 * Reads the gitignored .env file at the repo root (if present) and merges it
 * into process.env. After load(), read secrets via process.env or getSecret().
 *
 * The .env file is NEVER committed (see .gitignore). For a public repo this is
 * the only acceptable place for API keys.
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let loaded = false;

/** Locate the .env file by walking up from this module to the repo root. */
function findEnvFile(): string | null {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, ".env");
    if (existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return null;
}

/** Parse a simple KEY=VALUE .env file (handles quotes; ignores # comments). */
function parseDotenv(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    // strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/** Load .env into process.env (idempotent). Safe to call multiple times. */
export function loadSecrets(): void {
  if (loaded) return;
  loaded = true;
  const file = findEnvFile();
  if (!file) return;
  try {
    const parsed = parseDotenv(readFileSync(file, "utf8"));
    for (const [k, v] of Object.entries(parsed)) {
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch {
    // ignore — fall back to process.env only
  }
}

/** Get a secret, loading .env first. */
export function getSecret(key: string): string | undefined {
  loadSecrets();
  return process.env[key];
}

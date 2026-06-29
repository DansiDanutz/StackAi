/**
 * Stack Ai OS — Secure vault for API keys & secrets
 *
 * PRIMARY store: macOS Keychain (encrypted at rest by the OS, bound to your
 * user account, no plaintext on disk). Access via the `security` CLI.
 *
 * FALLBACK store: AES-256-GCM encrypted file at data/vault.enc (gitignored),
 * unlocked by a master passphrase. Used on non-macOS or when Keychain is
 * unavailable. The file is unreadable without the passphrase.
 *
 * Both stores keep secrets OUT of the repo (which is public). The gitignored
 * .env file remains supported as a dev convenience but the vault is the secure
 * path — prefer `stackai vault set`.
 *
 * Service prefix in Keychain: "stack-ai-os"  (account = the key name).
 */
import { execFileSync } from "node:child_process";
import {
  existsSync, readFileSync, writeFileSync, mkdirSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  scryptSync, randomBytes, createCipheriv, createDecipheriv,
} from "node:crypto";
import { CONFIG_DIR } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEYCHAIN_SERVICE = "stack-ai-os";
const DATA_DIR = process.env.STACKAI_DATA_DIR ?? path.resolve(CONFIG_DIR, "..", "data");
const VAULT_FILE = path.join(DATA_DIR, "vault.enc");

const isMac = process.platform === "darwin";

// -------------------------- public API ------------------------------------

export interface VaultBackend {
  /** Name of the active backend. */
  name: "keychain" | "file";
  /** True if this backend can be used right now. */
  available: boolean;
  /** Whether a master passphrase is required (file backend only). */
  needsPassphrase: boolean;
}

export function detectBackend(): VaultBackend {
  if (isMac) return { name: "keychain", available: true, needsPassphrase: false };
  const hasFile = existsSync(VAULT_FILE);
  return { name: "file", available: true, needsPassphrase: !hasFile ? true : true };
}

/** Store a secret. For the file backend, passphrase is required. */
export function setSecret(key: string, value: string, passphrase?: string): void {
  validateKey(key);
  if (isMac) return keychainSet(key, value);
  return fileSet(key, value, passphrase ?? requirePassphrase());
}

/** Read a secret, or undefined if not present. */
export function getSecret(key: string, passphrase?: string): string | undefined {
  validateKey(key);
  if (isMac) return keychainGet(key);
  return fileGet(key, passphrase ?? requirePassphrase())?.[key];
}

/** Delete a secret. Returns true if something was removed. */
export function deleteSecret(key: string, passphrase?: string): boolean {
  validateKey(key);
  if (isMac) return keychainDelete(key);
  const all = fileGetAll(passphrase ?? requirePassphrase());
  if (!(key in all)) return false;
  delete all[key];
  fileWrite(all, requirePassphrase());
  return true;
}

/** List stored key names (never values). */
export function listSecrets(passphrase?: string): string[] {
  if (isMac) return keychainList();
  return Object.keys(fileGetAll(passphrase ?? requirePassphrase()));
}

/**
 * Resolve a secret with a fallback chain: vault → process.env → .env file.
 * This is what the rest of the system should call to obtain credentials.
 */
export function resolveSecret(key: string): string | undefined {
  try {
    const v = isMac
      ? keychainGet(key)
      : fileGet(key, process.env.STACKAI_VAULT_PASS ?? "")?.[key];
    if (v) return v;
  } catch {
    // vault not ready / locked — fall through
  }
  if (process.env[key]) return process.env[key];
  return undefined;
}

// -------------------------- Keychain backend ------------------------------

function keychainSet(key: string, value: string): void {
  // delete first to avoid duplicates, then add. Writes to the user's login keychain.
  try { keychainDelete(key); } catch { /* ok if absent */ }
  execFileSync("security", [
    "add-generic-password", "-a", key, "-s", KEYCHAIN_SERVICE,
    "-U", "-w", value,
  ], { stdio: ["ignore", "ignore", "ignore"] });
  keychainIndexAdd(key);
}

function keychainIndexAdd(key: string): void {
  const cur = new Set(keychainIndex());
  cur.add(key);
  keychainIndexWrite([...cur]);
}

function keychainIndexRemove(key: string): void {
  const cur = new Set(keychainIndex());
  cur.delete(key);
  keychainIndexWrite([...cur]);
}

function keychainIndex(): string[] {
  try {
    const out = execFileSync("security", [
      "find-generic-password", "-a", "__index__", "-s", KEYCHAIN_SERVICE, "-w",
    ], { encoding: "utf8" });
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function keychainIndexWrite(keys: string[]): void {
  try {
    execFileSync("security", [
      "delete-generic-password", "-a", "__index__", "-s", KEYCHAIN_SERVICE,
    ], { stdio: ["ignore", "ignore", "ignore"] });
  } catch { /* ok if absent */ }
  if (keys.length) {
    execFileSync("security", [
      "add-generic-password", "-a", "__index__", "-s", KEYCHAIN_SERVICE,
      "-U", "-w", keys.join("\n"),
    ], { stdio: ["ignore", "ignore", "ignore"] });
  }
}

function keychainList(): string[] {
  return keychainIndex();
}

function keychainGet(key: string): string | undefined {
  try {
    const out = execFileSync("security", [
      "find-generic-password", "-a", key, "-s", KEYCHAIN_SERVICE, "-w",
    ], { encoding: "utf8" });
    return out.trim() || undefined;
  } catch {
    return undefined;
  }
}

function keychainDelete(key: string): boolean {
  let removed = false;
  try {
    execFileSync("security", [
      "delete-generic-password", "-a", key, "-s", KEYCHAIN_SERVICE,
    ], { stdio: ["ignore", "ignore", "ignore"] });
    removed = true;
  } catch {
    removed = false;
  }
  keychainIndexRemove(key);
  return removed;
}

// -------------------------- Encrypted-file backend ------------------------

function fileSet(key: string, value: string, passphrase: string): void {
  const all = fileGetAll(passphrase);
  all[key] = value;
  fileWrite(all, passphrase);
}

function fileGet(key: string, passphrase: string): Record<string, string> | undefined {
  const all = fileGetAll(passphrase);
  return key in all ? all : undefined;
}

function fileGetAll(passphrase: string): Record<string, string> {
  if (!existsSync(VAULT_FILE)) return {};
  const raw = readFileSync(VAULT_FILE);
  try {
    return decrypt(raw, passphrase);
  } catch {
    throw new Error("Failed to unlock vault (wrong passphrase or corrupted file).");
  }
}

function fileWrite(data: Record<string, string>, passphrase: string): void {
  mkdirSync(DATA_DIR, { recursive: true });
  // also persist a names index for keychain-style listing
  if (isMac) keychainSet("__index__", Object.keys(data).join("\n"));
  writeFileSync(VAULT_FILE, encrypt(data, passphrase), { mode: 0o600 });
}

function requirePassphrase(): string {
  const p = process.env.STACKAI_VAULT_PASS;
  if (!p) {
    throw new Error(
      "Vault passphrase required. Set STACKAI_VAULT_PASS env var or pass --passphrase.\n" +
      "On macOS the Keychain backend is preferred (no passphrase needed): run on macOS."
    );
  }
  return p;
}

// -------------------------- crypto helpers --------------------------------

const SALT_LEN = 16;
const IV_LEN = 12;
const KEY_LEN = 32;
const N = 2 ** 15, r = 8, p = 1; // scrypt cost — ~0.1s, strong offline resistance

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LEN, { N, r, p, maxmem: 64 * 1024 * 1024 });
}

/** Format: [salt(16)][iv(12)][ciphertext][tag(16)]. Authenticated. */
function encrypt(data: Record<string, string>, passphrase: string): Buffer {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(data), "utf8");
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, ct, tag]);
}

function decrypt(blob: Buffer, passphrase: string): Record<string, string> {
  const salt = blob.subarray(0, SALT_LEN);
  const iv = blob.subarray(SALT_LEN, SALT_LEN + IV_LEN);
  const tag = blob.subarray(blob.length - 16);
  const ct = blob.subarray(SALT_LEN + IV_LEN, blob.length - 16);
  const key = deriveKey(passphrase, salt);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(pt.toString("utf8"));
}

function validateKey(key: string): void {
  if (!/^[A-Z0-9_]{1,128}$/i.test(key)) {
    throw new Error(
      "Invalid vault key: use UPPER_SNAKE_CASE, alphanumeric + underscore (e.g. FIRECRAWL_API_KEY)."
    );
  }
}

/**
 * Stack Ai OS — vllm-mlx local model server control
 *
 * vllm-mlx is the fastest local inference path on Apple Silicon (MLX backend),
 * distinct from ollama/llama.cpp. It exposes an OpenAI-compatible API. This
 * module lets Stack Ai OS start/stop/check the server so agents can hit fast
 * local MLX models via the model router's openai-compatible provider path.
 *
 * This is a BACKEND, not an agent adapter — agents don't spawn vllm-mlx; they
 * call its HTTP API when routed to an mlx-* model.
 *
 * Managed via: stackai mlx {serve|status|stop}
 */
import { spawn, execSync } from "node:child_process";
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "../config.js";

const VLLM_MLX = "/Users/davidai/.local/bin/vllm-mlx";
const PID_FILE = path.resolve(CONFIG_DIR, "..", "data", "vllm-mlx.pid");
const LOG_FILE = path.resolve(CONFIG_DIR, "..", "data", "vllm-mlx.log");
const DEFAULT_MODEL = "mlx-community/Llama-3.2-3B-Instruct-4bit";
const DEFAULT_PORT = 8765;

export function vllmMlxAvailable(): boolean {
  return existsSync(VLLM_MLX);
}

/** Start the vllm-mlx server in the background. Returns the pid. */
export function startVllmMlx(opts?: { model?: string; port?: number }): number {
  if (!vllmMlxAvailable()) throw new Error(`vllm-mlx not found at ${VLLM_MLX}`);
  if (isRunning()) throw new Error("vllm-mlx already running (see status)");

  const model = opts?.model ?? DEFAULT_MODEL;
  const port = opts?.port ?? DEFAULT_PORT;

  const out = spawn(VLLM_MLX, ["serve", model, "--port", String(port), "--host", "127.0.0.1"], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  out.unref();
  writeFileSync(PID_FILE, String(out.pid ?? ""));
  return out.pid ?? 0;
}

/** Stop the running vllm-mlx server, if any. */
export function stopVllmMlx(): boolean {
  const pid = readPid();
  if (!pid) return false;
  try {
    process.kill(pid, "SIGTERM");
    writeFileSync(PID_FILE, ""); // clear
    return true;
  } catch {
    writeFileSync(PID_FILE, "");
    return false;
  }
}

/** Is the server currently running? */
export function isRunning(): boolean {
  const pid = readPid();
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Status object for display. */
export function status(): { running: boolean; pid: number | null; port: number; model: string } {
  return {
    running: isRunning(),
    pid: readPid(),
    port: DEFAULT_PORT,
    model: DEFAULT_MODEL,
  };
}

function readPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const raw = readFileSync(PID_FILE, "utf8").trim();
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export { DEFAULT_MODEL as VLLM_MLX_DEFAULT_MODEL, DEFAULT_PORT as VLLM_MLX_DEFAULT_PORT, LOG_FILE };

/**
 * Stack Ai OS — Safety policy
 *
 * Default posture is CAUTIOUS: agents run without skip-permissions flags and
 * will pause on risky ops. Full-auto is opt-in (--full-auto / TUI toggle /
 * per-agent config). Even in full-auto, hard guardrails below stay enforced.
 *
 * Each adapter translates the global posture into its CLI's vocabulary; this
 * module owns the *decision* (is full-auto allowed here?) and the guardrails.
 */
import type { RunRequest, SafetyPosture } from "../types.js";

/** Hard-blocked command patterns — enforced even in full-auto. */
const BLOCKED_PATTERNS: RegExp[] = [
  /\brm\s+-rf\s+\/(\s|$)/, // rm -rf /
  /\brm\s+-rf\s+~(\/|\s|$)/, // rm -rf ~
  /\brm\s+-rf\s+\*(\s|$)/, // rm -rf *
  /\bmkfs\b/,
  /\bdd\s+.*of=\/dev\/(disk|sd|nvme)/i, // dd to a whole disk
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;/, // fork bomb
  /git\s+push\s+.*--force\s+.*origin\s+main/i, // force-push main
  /git\s+push\s+-f\s+.*origin\s+master/i, // force-push master
  /\bsudo\s+rm\b/,
  /\bshutdown\b|\breboot\b|\bhalt\b/,
];

/** Directories agents are allowed to operate in. Empty = unrestricted. */
export class SafetyPolicy {
  posture: SafetyPosture;
  private cwdAllowlist: string[];
  private blocked: RegExp[];

  constructor(opts?: {
    posture?: SafetyPosture;
    cwdAllowlist?: string[];
    blocked?: RegExp[];
  }) {
    this.posture = opts?.posture ?? "cautious";
    this.cwdAllowlist = opts?.cwdAllowlist ?? [];
    this.blocked = opts?.blocked ?? BLOCKED_PATTERNS;
  }

  /** Resolve the effective posture for a request (request can escalate within policy). */
  effectivePosture(req: RunRequest): SafetyPosture {
    // Request posture never relaxes below the policy posture.
    if (this.posture === "full-auto") return req.posture ?? "full-auto";
    return req.posture ?? "cautious";
  }

  /** Validate a prompt/cwd before dispatch. Throws on violation. */
  validate(req: RunRequest): void {
    const cwd = req.cwd ?? process.cwd();
    if (this.cwdAllowlist.length > 0) {
      const ok = this.cwdAllowlist.some((d) => cwd === d || cwd.startsWith(d + "/"));
      if (!ok) {
        throw new Error(
          `cwd '${cwd}' is outside the safety allowlist. Add it to the allowlist or change --cwd.`
        );
      }
    }
    // Scan the prompt for blocked patterns.
    for (const re of this.blocked) {
      if (re.test(req.prompt)) {
        throw new Error(
          `Safety guardrail: prompt matches a blocked command pattern (${re.source}). ` +
            `Refusing to dispatch. Edit safety/policy.ts to adjust.`
        );
      }
    }
  }

  /** Quick check used by the TUI/web to show whether full-auto is on. */
  isFullAuto(): boolean {
    return this.posture === "full-auto";
  }
}

/** Default singleton, configurable via STACKAI_FULL_AUTO=1 env or constructor. */
export function defaultPolicy(): SafetyPolicy {
  const posture: SafetyPosture = process.env.STACKAI_FULL_AUTO === "1" ? "full-auto" : "cautious";
  return new SafetyPolicy({ posture });
}

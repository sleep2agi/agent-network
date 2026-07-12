// RFC-030 Wave 1A P0.2 — tui-child-launcher.ts
//
// NARROW injection seam for the codex TUI child process. The A tranche
// does NOT ship a real production launcher — spawning `codex --remote
// ws://...` with the correct env-allowlist + stdio-redactor wiring is
// Wave 2 material and is explicitly locked in 副指挥 7034c5ce item #7.
//
// What lives here:
//   - `TuiChildLauncher` interface (the seam)
//   - `LaunchRequest` shape (bearer plaintext + WS host + env allowlist)
//   - `NoopTuiChildLauncher` — a fake for tests, exposes what it saw
//     so integration tests can assert env allowlisting and that the
//     bearer plaintext arrived intact.
//
// What does NOT live here (Wave 2):
//   - `child_process.spawn` of the real codex binary
//   - PTY handling
//   - Stdio pass-through wiring (uses `SecretRedactor` from bearer.ts)
//   - Exit-code / signal handling / re-spawn strategy

import type { SecretRedactor } from "./bearer";

/**
 * The shape lifecycle hands to `TuiChildLauncher.launch(...)` when it
 * has a WS server listening and a fresh bearer minted.
 *
 * `env` is an EXPLICIT ALLOWLIST. The launcher MUST NOT dump
 * `process.env` and add these; it must construct the child env from
 * an empty object and then set exactly the keys the allowlist names.
 */
export interface LaunchRequest {
  /**
   * `ws://127.0.0.1:<port>` — port is the OS-assigned ephemeral bound
   * to the loopback. Never includes a path (real Codex 0.144.0
   * rejects any suffix — 副指挥 967a0010).
   */
  readonly wsUrl: string;

  /**
   * Symbolic env var name Codex is invoked with via
   * `--remote-auth-token-env`. The value at this key in `env` is the
   * bearer plaintext. Naming the ENV VAR (not the value) in argv is
   * how Codex reads secrets without them showing up in `ps`.
   */
  readonly bearerEnvName: string;

  /**
   * Explicit env allowlist. Every key the child process is allowed to
   * see. The launcher constructs the child env from
   * `Object.fromEntries(Object.entries(this.env))` — no parent env
   * inheritance, no `...process.env`.
   */
  readonly env: Readonly<Record<string, string>>;

  /**
   * Optional stdio redactor. When set, launcher pipes child stdout+stderr
   * through it before forwarding. In the fake this is captured but not
   * exercised.
   */
  readonly stdioRedactor?: SecretRedactor;
}

/**
 * Outcome of a launch request. `spawned` is always false in the fake;
 * a Wave 2 production launcher would return a handle/child-pid.
 */
export interface LaunchOutcome {
  readonly spawned: boolean;
  /** Symbolic reason for a failed launch. Fake never fails. */
  readonly reason?: string;
}

/**
 * The seam. Lifecycle passes a `TuiChildLauncher` in. Test harnesses
 * inject `NoopTuiChildLauncher` (below); Wave 2 will supply the real
 * spawn implementation.
 */
export interface TuiChildLauncher {
  launch(req: LaunchRequest): Promise<LaunchOutcome>;
  /**
   * Called by lifecycle on shutdown so a real launcher can send SIGTERM
   * and await. The fake just records the call.
   */
  terminate(): Promise<void>;
}

// ────────────────────────────────────────────────────────────────────────
// NoopTuiChildLauncher — interface-level fake, INTEGRATION-LEVEL EVIDENCE
// ────────────────────────────────────────────────────────────────────────

/**
 * Fake launcher used by the integration tests. Records every launch
 * request so tests can assert:
 *   - the bearer plaintext arrived at the launcher exactly once
 *   - the env is an allowlist (no parent-env leaks)
 *   - the wsUrl uses `ws://127.0.0.1:<port>` with no path suffix
 *
 * This class is a fake — it does NOT spawn any real codex process.
 * All evidence produced with this class is `interface-level fake`,
 * clearly labeled as such in test names and commit messages.
 */
export class NoopTuiChildLauncher implements TuiChildLauncher {
  readonly seenRequests: LaunchRequest[] = [];
  readonly terminateCalls: number[] = [];
  private terminateCallCount = 0;

  async launch(req: LaunchRequest): Promise<LaunchOutcome> {
    this.seenRequests.push(req);
    return { spawned: false, reason: "noop_launcher_never_spawns" };
  }

  async terminate(): Promise<void> {
    this.terminateCallCount++;
    this.terminateCalls.push(this.terminateCallCount);
  }

  /** Test helper — total number of terminate() calls seen. */
  terminatesObserved(): number {
    return this.terminateCallCount;
  }
}

// ────────────────────────────────────────────────────────────────────────
// Env allowlist helpers
// ────────────────────────────────────────────────────────────────────────

/**
 * Build a child env from an EXPLICIT set of key/value pairs. This is a
 * belt-and-braces helper so no caller is tempted to spread
 * `process.env` in one place and forget to filter. Returns a plain
 * frozen object.
 *
 * `bearerEnvName` and `bearerValue` MUST be present; the launcher
 * refuses to launch without them.
 */
export function buildAllowlistEnv(
  bearerEnvName: string,
  bearerValue: string,
  additional: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> {
  if (typeof bearerEnvName !== "string" || bearerEnvName.length === 0) {
    throw new Error("bearerEnvName must be a non-empty string");
  }
  if (typeof bearerValue !== "string" || bearerValue.length === 0) {
    throw new Error("bearerValue must be a non-empty string");
  }
  // Verify none of the `additional` keys name a CommHub-shape env slot
  // — a defensive guard against future refactor drift. Denied keys
  // land in a static list; a new CommHub key elsewhere in the codebase
  // will need to be added here explicitly.
  for (const k of Object.keys(additional)) {
    if (COMMHUB_ENV_DENYLIST.has(k) || COMMHUB_ENV_DENY_PATTERNS.some((rx) => rx.test(k))) {
      throw new Error(`env key '${k}' is on the CommHub-token denylist`);
    }
  }
  return Object.freeze({
    ...additional,
    [bearerEnvName]: bearerValue,
  });
}

const COMMHUB_ENV_DENYLIST = new Set<string>([
  "ANET_CODEX_COMMHUB_TOKEN",
  "COMMHUB_MCP_TOKEN",
  "ANET_TOKEN",
  "COMMHUB_ADMIN_TOKEN",
  "COMMHUB_UTOK",
]);

/**
 * Regex patterns for env slots that should never travel to the codex
 * child. Prefix-based classes (`NTOK*`, `UTOK*`, `NTOK_*`).
 */
const COMMHUB_ENV_DENY_PATTERNS: readonly RegExp[] = [
  /^NTOK_/i,
  /^UTOK_/i,
  /^NTOK$/i,
  /^UTOK$/i,
  /^ANET_COMMHUB_/i,
];

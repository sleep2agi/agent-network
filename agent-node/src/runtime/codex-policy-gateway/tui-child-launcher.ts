// RFC-030 Wave 1A P0.2 Commit 1 corrective — tui-child-launcher.ts
//
// NARROW injection seam for the codex TUI child process. A tranche
// does NOT ship a real production launcher (Wave 2 locked).
//
// Corrective (副指挥 a1ed1589 items #9, #10):
//   - `buildAllowlistEnv` accepts a NARROW typed struct, not an
//     arbitrary `Record + denylist`. Only these keys are allowed
//     on the child env: `PATH`, `HOME`, `TMPDIR`, `CODEX_HOME`, plus
//     the pinned bearer slot. Any other input has no entry point.
//   - Bearer env slot is HARD-PINNED to `ANET_CODEX_TUI_BEARER`.
//     There is no per-call name override.
//   - `NoopTuiChildLauncher` never stores the plaintext bearer. It
//     retains only a redacted observation record: digest of the
//     bearer, whether the bearer env slot was present, and the WS
//     URL — never the plaintext.

import * as crypto from "node:crypto";

/**
 * The single env var name Codex is invoked with via
 * `--remote-auth-token-env ANET_CODEX_TUI_BEARER`. Hard-pinned.
 */
export const TUI_BEARER_ENV_NAME = "ANET_CODEX_TUI_BEARER";

/**
 * Typed shape the caller hands to `buildAllowlistEnv`. Every field is
 * OPTIONAL because the caller is expected to only supply what the
 * child truly needs. Unknown fields on the type are a compile-time
 * error; unknown keys at runtime are refused.
 */
export interface AllowedChildEnv {
  readonly PATH?: string;
  readonly HOME?: string;
  readonly TMPDIR?: string;
  readonly CODEX_HOME?: string;
}

/** Total set of allowed env keys (bearer + typed struct). */
const ALLOWED_ENV_KEYS: readonly string[] = [
  TUI_BEARER_ENV_NAME,
  "PATH",
  "HOME",
  "TMPDIR",
  "CODEX_HOME",
];

/**
 * Launch request the seam receives. `wsUrl` is the bare
 * `ws://127.0.0.1:<port>` (no path — real 0.144.0 CLI rejects any
 * path). `env` is already a fully-constructed frozen record (built
 * via `buildAllowlistEnv`).
 */
export interface LaunchRequest {
  readonly wsUrl: string;
  /**
   * Frozen record built via `buildAllowlistEnv`. Always includes the
   * pinned bearer slot under `ANET_CODEX_TUI_BEARER` and zero or
   * more of the four allowed slots.
   */
  readonly env: Readonly<Record<string, string>>;
}

export interface LaunchOutcome {
  readonly spawned: boolean;
  readonly reason?: string;
}

export interface TuiChildLauncher {
  launch(req: LaunchRequest): Promise<LaunchOutcome>;
  terminate(): Promise<void>;
}

// ────────────────────────────────────────────────────────────────────────
// buildAllowlistEnv — narrow, allowlisted, unknown keys rejected
// ────────────────────────────────────────────────────────────────────────

/**
 * Build a frozen child env from the pinned bearer slot + the four
 * typed fields. Refuses:
 *   - empty bearer value
 *   - any key in `env` that is not in `ALLOWED_ENV_KEYS`
 *   - any prototype-poisoned key (`__proto__` / `constructor` /
 *     `prototype`)
 *
 * A caller cannot pass a `Record<string, string>` with arbitrary
 * keys — the `AllowedChildEnv` type limits it at compile time. The
 * runtime check is defense-in-depth against a hostile cast /
 * dynamic caller.
 */
export function buildAllowlistEnv(
  bearerValue: string,
  env: AllowedChildEnv = {},
): Readonly<Record<string, string>> {
  if (typeof bearerValue !== "string" || bearerValue.length === 0) {
    throw new Error("bearerValue must be a non-empty string");
  }
  // The typed field set is a compile-time allowlist. Reject any
  // runtime key that snuck in via a hostile cast.
  const asRecord = env as Record<string, string>;
  for (const k of Object.keys(asRecord)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") {
      throw new Error(`env key ${JSON.stringify(k)} is not allowed`);
    }
    if (!ALLOWED_ENV_KEYS.includes(k)) {
      throw new Error(`env key ${JSON.stringify(k)} is not in the allowlist`);
    }
    if (k === TUI_BEARER_ENV_NAME) {
      throw new Error(`env key ${TUI_BEARER_ENV_NAME} is reserved; supply bearer via the first arg`);
    }
    if (typeof asRecord[k] !== "string") {
      throw new Error(`env value for ${JSON.stringify(k)} must be a string`);
    }
  }
  const out: Record<string, string> = {};
  // Copy allowed typed fields.
  for (const k of ALLOWED_ENV_KEYS) {
    if (k === TUI_BEARER_ENV_NAME) continue;
    const v = asRecord[k];
    if (typeof v === "string") out[k] = v;
  }
  out[TUI_BEARER_ENV_NAME] = bearerValue;
  return Object.freeze(out);
}

// ────────────────────────────────────────────────────────────────────────
// NoopTuiChildLauncher — records redacted observation only
// ────────────────────────────────────────────────────────────────────────

/**
 * Bearer-observation record retained by the fake launcher. NEVER
 * contains the plaintext or the digest bytes; only booleans + safe
 * numerics.
 */
export interface RedactedLaunchObservation {
  readonly wsUrlHostPort: string;
  readonly bearerPresent: boolean;
  readonly bearerLen: number;
  /** Base64url of a truncated (first 4 bytes) SHA-256 of the bearer
   *  — a shape identifier that lets tests distinguish two distinct
   *  bearers without exposing either. */
  readonly bearerFingerprint4: string;
  readonly envKeys: readonly string[];
}

/**
 * Fake launcher for tests. Corrective (副指挥 a1ed1589 item #10):
 * the fake NEVER stores the full `LaunchRequest`. The plaintext
 * bearer is projected to a 4-byte fingerprint before storage.
 */
export class NoopTuiChildLauncher implements TuiChildLauncher {
  private readonly observations: RedactedLaunchObservation[] = [];
  private terminateCallCount = 0;

  async launch(req: LaunchRequest): Promise<LaunchOutcome> {
    const bearer = req.env[TUI_BEARER_ENV_NAME] ?? "";
    // Compute a redacted observation.
    const hostPort = extractHostPort(req.wsUrl);
    const fp = fingerprint4(bearer);
    const obs: RedactedLaunchObservation = {
      wsUrlHostPort: hostPort,
      bearerPresent: bearer.length > 0,
      bearerLen: bearer.length,
      bearerFingerprint4: fp,
      envKeys: Object.keys(req.env).sort(),
    };
    this.observations.push(obs);
    return { spawned: false, reason: "noop_launcher_never_spawns" };
  }

  async terminate(): Promise<void> {
    this.terminateCallCount++;
  }

  /** Test helper. Observations contain NO plaintext. */
  seenObservations(): readonly RedactedLaunchObservation[] {
    return this.observations;
  }

  terminatesObserved(): number {
    return this.terminateCallCount;
  }
}

function extractHostPort(wsUrl: string): string {
  // Strip `ws://` prefix; take everything before the next `/` if any.
  const m = wsUrl.match(/^ws:\/\/([^/]+)/);
  return m ? m[1] : "";
}

function fingerprint4(bearer: string): string {
  if (bearer.length === 0) return "";
  const digest = crypto.createHash("sha256").update(bearer, "utf8").digest();
  return digest.subarray(0, 4).toString("base64url");
}

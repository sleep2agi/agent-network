// RFC-030 Wave 1A P0.2 — bearer.ts
//
// One-shot bearer token for the native Codex TUI WebSocket upgrade.
//
// Contract (副指挥 7034c5ce):
//   - Hard 32 bytes CSPRNG, base64url-encoded (43 chars). No length option.
//   - Single-use: state transitions `pending -> consumed` exactly once on a
//     successful `Authorization: Bearer <bearer>` upgrade.
//   - Unused TTL 30s: if no upgrade has consumed it within `ttlMs` from mint,
//     the bearer moves to `rotated_out` and every subsequent presentation is
//     refused, including the correct value.
//   - `lifecycle.stop()` rotates the bearer to `rotated_out`; there is NO
//     same-lifecycle reconnect. Disconnect -> supervisor spawns a new
//     lifecycle with a fresh instance + port + token.
//   - Server retains only a domain-separated SHA-256 digest; the plaintext
//     is handed to the injected `TuiChildLauncher` seam once and dropped.
//   - Every wire-facing failure is a uniform generic 401. Detailed reason
//     (`bearer_absent`, `bearer_invalid`, `bearer_already_consumed`,
//     `bearer_ttl_expired`, `bearer_rotated_out`) is emitted only into a
//     scrubbed diagnostics sink.
//
// Constant-time compare is performed on 32-byte SHA-256 digests, not on the
// plaintext, so length differences do not create a distinguishable path.
// Domain separation prefixes the SHA-256 input so a bearer digest is not
// interchangeable with, say, the backend capability digest.

import * as crypto from "node:crypto";

/**
 * Default hard-coded per-bearer TTL. The launcher has 30 seconds from
 * bearer mint to complete the TCP + HTTP + Upgrade round-trip. Any
 * later presentation is refused as `bearer_ttl_expired`, even with
 * the correct value. Non-configurable in production; kept as a
 * `Symbol.for` accessor for tests so a fast tick doesn't slow every
 * test run.
 */
export const BEARER_TTL_MS = 30_000;

/**
 * Fresh bearer byte count. 32 bytes = 256 bits of CSPRNG entropy.
 * Non-configurable per the tranche instruction (no `bearerLength` option).
 */
export const BEARER_BYTES = 32;

/** Stable domain-separation label for the bearer digest. Keeps a bearer
 *  digest from ever colliding with any other 32-byte SHA-256 value in
 *  the codebase (backend capability, network keys, ledger keys...). */
export const BEARER_DIGEST_DOMAIN = "rfc030-tui-bearer:";

/**
 * Bearer lifecycle state. Once `consumed` or `rotated_out`, the bearer
 * is terminal; no path back to `pending`. A supervisor that wants a
 * fresh session mints a whole new `TuiBearer` instance.
 */
export type BearerState = "pending" | "consumed" | "rotated_out";

/**
 * The failure surface for `presentBearer`. Wire response is always a
 * generic 401 with a stable short body; the specific reason lands ONLY
 * in the diagnostics sink so the peer cannot learn which check tripped.
 */
export type BearerRejectReason =
  | "bearer_absent"
  | "bearer_invalid"
  | "bearer_already_consumed"
  | "bearer_ttl_expired"
  | "bearer_rotated_out";

/** Present-outcome discriminant. `ok` on the ONE successful path;
 *  `reject` with an internal reason on every other path. */
export type PresentBearerOutcome =
  | { readonly kind: "ok" }
  | { readonly kind: "reject"; readonly reason: BearerRejectReason };

/**
 * One-shot bearer holder. Owns:
 *   - the plaintext (short-lived, exposed once via `takePlaintextForLauncher`)
 *   - the domain-separated SHA-256 digest (retained for the whole life)
 *   - the lifecycle state
 *   - the mint timestamp for TTL enforcement
 *
 * NEVER logs, echoes, serializes, or persists the plaintext. `toString`
 * / `toJSON` are intentionally NOT overridden — the default Object
 * `toString` returns `"[object Object]"` which is safe. The plaintext
 * is stored as a private property whose only exit is
 * `takePlaintextForLauncher()`, which clears the internal reference
 * atomically. All other public methods work on the digest.
 */
export class TuiBearer {
  private state: BearerState = "pending";
  private plaintext: string | null;
  private readonly digest: Buffer;
  private readonly nowFn: () => number;
  private readonly ttlMs: number;
  private readonly mintedAtMs: number;

  private constructor(plaintext: string, digest: Buffer, nowFn: () => number, ttlMs: number) {
    this.plaintext = plaintext;
    this.digest = digest;
    this.nowFn = nowFn;
    this.ttlMs = ttlMs;
    this.mintedAtMs = nowFn();
  }

  /**
   * Mint a fresh bearer with 32 bytes of CSPRNG entropy.
   *
   * `nowFn` is injectable ONLY so tests can advance the TTL clock
   * cheaply. Production callers omit it and get `Date.now`.
   */
  static mint(opts?: { nowFn?: () => number; ttlMs?: number }): TuiBearer {
    const bytes = crypto.randomBytes(BEARER_BYTES);
    const plaintext = bytes.toString("base64url");
    const digest = TuiBearer.computeDigest(plaintext);
    // Wipe the transient bytes buffer.
    bytes.fill(0);
    return new TuiBearer(
      plaintext,
      digest,
      opts?.nowFn ?? Date.now,
      opts?.ttlMs ?? BEARER_TTL_MS,
    );
  }

  private static computeDigest(plaintext: string): Buffer {
    return crypto.createHash("sha256")
      .update(BEARER_DIGEST_DOMAIN, "utf8")
      .update(plaintext, "utf8")
      .digest();
  }

  /**
   * Return the plaintext exactly ONCE, then wipe the private field.
   * The caller (a `TuiChildLauncher` injection point) MUST place it
   * into the child process env slot immediately and drop its own
   * reference. Second call returns `null`.
   */
  takePlaintextForLauncher(): string | null {
    const p = this.plaintext;
    this.plaintext = null;
    return p;
  }

  /**
   * Constant-time check of a presented bearer value. Runs in this
   * order:
   *   1. state guard (`consumed` -> `bearer_already_consumed`;
   *      `rotated_out` -> `bearer_rotated_out`)
   *   2. TTL guard (mintedAt + ttlMs < now -> `bearer_ttl_expired`;
   *      transitions state to `rotated_out` before returning)
   *   3. absent-value guard (`bearer_absent`)
   *   4. constant-time digest compare via `crypto.timingSafeEqual`
   *      on 32-byte SHA-256 digests. Length differences never reach
   *      this compare (both sides are always 32 bytes).
   *
   * On success, state transitions `pending -> consumed` atomically
   * BEFORE returning `ok`. A concurrent presentation therefore sees
   * `consumed` on the second call; only one path ever hits `ok`.
   *
   * The received value is NEVER echoed or stored beyond the digest
   * computation.
   */
  presentBearer(presented: string | undefined | null): PresentBearerOutcome {
    if (this.state === "consumed") return { kind: "reject", reason: "bearer_already_consumed" };
    if (this.state === "rotated_out") return { kind: "reject", reason: "bearer_rotated_out" };
    if (this.nowFn() - this.mintedAtMs > this.ttlMs) {
      this.state = "rotated_out";
      return { kind: "reject", reason: "bearer_ttl_expired" };
    }
    if (typeof presented !== "string" || presented.length === 0) {
      return { kind: "reject", reason: "bearer_absent" };
    }
    const presentedDigest = TuiBearer.computeDigest(presented);
    let ok: boolean;
    try {
      ok = crypto.timingSafeEqual(presentedDigest, this.digest);
    } catch {
      ok = false;
    }
    if (!ok) return { kind: "reject", reason: "bearer_invalid" };
    // Atomic transition. Node.js is single-threaded so a re-entry from
    // the same tick can't race this; different-tick re-entries see
    // `consumed`.
    this.state = "consumed";
    return { kind: "ok" };
  }

  /**
   * Rotate the bearer to the terminal `rotated_out` state. Idempotent.
   * Called by `lifecycle.stop()` so any pending upgrade attempt is
   * refused even if it presents the (still technically valid)
   * plaintext.
   */
  rotate(): void {
    if (this.state === "pending") {
      this.state = "rotated_out";
    }
    // If already `consumed` or `rotated_out`, no-op.
  }

  currentState(): BearerState {
    return this.state;
  }
}

// ────────────────────────────────────────────────────────────────────────
// Cross-chunk redactor (exact-secret variant per 副指挥 7034c5ce item #7)
// ────────────────────────────────────────────────────────────────────────

/**
 * A ridiculously narrow secret redactor for stdio pass-through.
 * Replaces every occurrence of the bearer plaintext with a fixed
 * marker, correctly handling the case where the secret straddles a
 * chunk boundary in a byte stream.
 *
 * Refused alternative: a heuristic `≥40 char base64url` regex would
 * misfire on legitimate Codex debug output (many things look base64-ish).
 * This implementation matches the EXACT secret bytes and only those.
 *
 * The redactor holds a rolling window equal to `secret.length - 1`
 * so a secret split across two chunks still gets caught. On close
 * (`flush()`), the tail buffer is emitted verbatim; a partial-secret
 * tail is left in place (it can't be a complete secret by definition,
 * so redaction was not required).
 *
 * `secret` is stored as a Buffer. `wipe()` zeros the buffer when the
 * redactor is no longer needed (e.g., after bearer rotation).
 */
export class SecretRedactor {
  private secretBuf: Buffer;
  private readonly marker: string;
  private tail: Buffer = Buffer.alloc(0);
  private wiped = false;

  constructor(secret: string, marker = "[REDACTED bearer]") {
    if (typeof secret !== "string" || secret.length === 0) {
      throw new Error("SecretRedactor requires a non-empty secret");
    }
    this.secretBuf = Buffer.from(secret, "utf8");
    this.marker = marker;
  }

  /**
   * Push a chunk of stdio bytes through the redactor. Returns the
   * (possibly redacted) bytes to forward downstream.
   */
  push(chunk: Buffer): Buffer {
    if (this.wiped) return chunk; // no more redaction after wipe
    // Compose the search window with any tail we held for boundary
    // straddle protection.
    const window = this.tail.length === 0 ? chunk : Buffer.concat([this.tail, chunk]);
    const sLen = this.secretBuf.length;
    // Search for the secret from the very start.
    let scanStart = 0;
    const out: Buffer[] = [];
    while (scanStart <= window.length - sLen) {
      const idx = window.indexOf(this.secretBuf, scanStart);
      if (idx === -1) break;
      out.push(window.subarray(scanStart, idx));
      out.push(Buffer.from(this.marker, "utf8"));
      scanStart = idx + sLen;
    }
    // Everything up to `scanStart` is fully processed. The tail
    // (last `sLen - 1` bytes) is held over in case the next chunk
    // completes a straddle.
    const consumedUpTo = Math.max(scanStart, window.length - (sLen - 1));
    const safeStart = Math.min(consumedUpTo, window.length);
    out.push(window.subarray(scanStart, safeStart));
    this.tail = window.subarray(safeStart);
    return Buffer.concat(out);
  }

  /** Return any held tail bytes verbatim and clear internal state.
   *  Called on stream end. */
  flush(): Buffer {
    const t = this.tail;
    this.tail = Buffer.alloc(0);
    return t;
  }

  /** Zero out the secret bytes. Idempotent. After wipe, `push` is a
   *  pass-through. */
  wipe(): void {
    if (this.wiped) return;
    this.wiped = true;
    this.secretBuf.fill(0);
    this.secretBuf = Buffer.alloc(0);
  }
}

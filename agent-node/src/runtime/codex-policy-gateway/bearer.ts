// RFC-030 Wave 1A P0.2 Commit 1 corrective — bearer.ts
//
// Single-use bearer for the native Codex TUI WebSocket Upgrade.
//
// Corrective changes vs 9e6706c (副指挥 a1ed1589):
//   - Plaintext + digest are non-enumerable + non-writable so
//     `JSON.stringify` / `Object.keys` / `util.inspect` / spread do
//     NOT expose them. `toJSON` returns a stable safe view.
//   - Every terminal transition (consumed, TTL-expired, rotated)
//     atomically clears the plaintext buffer. `takePlaintextForLauncher`
//     after terminal returns `null`.
//   - Production `mint()` accepts NO configuration. Length is a hard
//     32 bytes; TTL is a hard 30 s. Tests use `_mintForTest` which is
//     `@internal` — kept out of the public documented API surface.
//   - `SecretRedactor.wipe()` clears the held tail and zeros the
//     secret bytes. After wipe, `push()` returns the input verbatim
//     BUT still clears its internal tail so no partial secret is
//     retained. A new call to `push` after `wipe` cannot reassemble
//     an incomplete secret because the secret bytes are gone.
//   - `finish()` returns any residual tail exactly ONCE, then the
//     redactor becomes an idempotent pass-through. Prevents the
//     "wipe -> push cross-chunk -> tail concatenates with new bytes"
//     class of leak.

import * as crypto from "node:crypto";

/** Production TTL. Non-configurable (副指挥 a1ed1589 item #6). */
export const BEARER_TTL_MS = 30_000;

/** Production entropy width. Non-configurable. */
export const BEARER_BYTES = 32;

/** Domain-separation label for the bearer digest — makes the digest
 *  unequal to any other 32-byte SHA-256 in the codebase. */
export const BEARER_DIGEST_DOMAIN = "rfc030-tui-bearer:";

export type BearerState = "pending" | "consumed" | "rotated_out";

export type BearerRejectReason =
  | "bearer_absent"
  | "bearer_invalid"
  | "bearer_already_consumed"
  | "bearer_ttl_expired"
  | "bearer_rotated_out";

export type PresentBearerOutcome =
  | { readonly kind: "ok" }
  | { readonly kind: "reject"; readonly reason: BearerRejectReason };

// Internal-only slot for the plaintext buffer + digest. Kept OFF the
// TuiBearer instance's own-property list via `defineProperty`.
const PLAINTEXT = Symbol("bearer.plaintext");
const DIGEST = Symbol("bearer.digest");
const NOW_FN = Symbol("bearer.now");
const TTL_MS = Symbol("bearer.ttl");
const MINTED_AT_MS = Symbol("bearer.mintedAt");

/**
 * One-shot bearer. Public API surface:
 *   - `mint()` (production; no options)
 *   - `takePlaintextForLauncher()` (one-shot)
 *   - `presentBearer(value)` (constant-time compare)
 *   - `rotate()`
 *   - `currentState()`
 *   - `toJSON()` (safe: never exposes plaintext or digest)
 *
 * `@internal` API (used by tests only, not part of the documented
 * surface; the docstring on `_mintForTest` warns):
 *   - `_mintForTest(nowFn, ttlMs)`
 */
export class TuiBearer {
  private state: BearerState = "pending";

  private constructor(plaintext: string, digest: Buffer, nowFn: () => number, ttlMs: number) {
    // Non-enumerable + non-writable slots — JSON.stringify /
    // Object.keys / spread all skip these. `configurable: false`
    // so a hostile caller can't redefine to expose them.
    Object.defineProperty(this, PLAINTEXT, {
      value: Buffer.from(plaintext, "utf8"),
      writable: true,
      configurable: false,
      enumerable: false,
    });
    Object.defineProperty(this, DIGEST, {
      value: digest,
      writable: true,
      configurable: false,
      enumerable: false,
    });
    Object.defineProperty(this, NOW_FN, { value: nowFn, writable: false, configurable: false, enumerable: false });
    Object.defineProperty(this, TTL_MS, { value: ttlMs, writable: false, configurable: false, enumerable: false });
    Object.defineProperty(this, MINTED_AT_MS, { value: nowFn(), writable: false, configurable: false, enumerable: false });
  }

  static mint(): TuiBearer {
    const bytes = crypto.randomBytes(BEARER_BYTES);
    const plaintext = bytes.toString("base64url");
    const digest = computeBearerDigest(plaintext);
    bytes.fill(0);
    return new TuiBearer(plaintext, digest, Date.now, BEARER_TTL_MS);
  }

  /**
   * @internal Test helper. NOT part of the documented public API.
   * Injects a fake now() + custom TTL so tests advance the TTL clock
   * cheaply. Production code MUST use `mint()`.
   */
  static _mintForTest(nowFn: () => number, ttlMs = BEARER_TTL_MS): TuiBearer {
    const bytes = crypto.randomBytes(BEARER_BYTES);
    const plaintext = bytes.toString("base64url");
    const digest = computeBearerDigest(plaintext);
    bytes.fill(0);
    return new TuiBearer(plaintext, digest, nowFn, ttlMs);
  }

  /**
   * Return the plaintext once, then clear the internal buffer. Second
   * call returns `null`. Also returns `null` if the bearer has moved
   * to any terminal state (`consumed` / `rotated_out`).
   */
  takePlaintextForLauncher(): string | null {
    if (this.state !== "pending") return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buf: Buffer | null = (this as any)[PLAINTEXT];
    if (buf === null || buf.length === 0) return null;
    const p = buf.toString("utf8");
    this.wipePlaintext();
    return p;
  }

  presentBearer(presented: string | undefined | null): PresentBearerOutcome {
    if (this.state === "consumed") return { kind: "reject", reason: "bearer_already_consumed" };
    if (this.state === "rotated_out") return { kind: "reject", reason: "bearer_rotated_out" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((this as any)[NOW_FN]() - (this as any)[MINTED_AT_MS] > (this as any)[TTL_MS]) {
      this.transitionTo("rotated_out");
      return { kind: "reject", reason: "bearer_ttl_expired" };
    }
    if (typeof presented !== "string" || presented.length === 0) {
      return { kind: "reject", reason: "bearer_absent" };
    }
    const presentedDigest = computeBearerDigest(presented);
    let ok: boolean;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ok = crypto.timingSafeEqual(presentedDigest, (this as any)[DIGEST]);
    } catch {
      ok = false;
    }
    if (!ok) return { kind: "reject", reason: "bearer_invalid" };
    this.transitionTo("consumed");
    return { kind: "ok" };
  }

  rotate(): void {
    if (this.state === "pending") this.transitionTo("rotated_out");
  }

  currentState(): BearerState {
    return this.state;
  }

  /**
   * Safe view. Never exposes plaintext or digest. Only the current
   * lifecycle state is public. Callers that stringify a TuiBearer
   * for a log line always get exactly this shape.
   */
  toJSON(): { readonly state: BearerState } {
    return { state: this.state };
  }

  private transitionTo(next: Exclude<BearerState, "pending">): void {
    this.state = next;
    this.wipePlaintext();
  }

  private wipePlaintext(): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buf: Buffer | null = (this as any)[PLAINTEXT];
    if (buf !== null && buf.length > 0) {
      buf.fill(0);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this as any)[PLAINTEXT] = Buffer.alloc(0);
  }
}

function computeBearerDigest(plaintext: string): Buffer {
  return crypto.createHash("sha256")
    .update(BEARER_DIGEST_DOMAIN, "utf8")
    .update(plaintext, "utf8")
    .digest();
}

// ────────────────────────────────────────────────────────────────────────
// SecretRedactor
// ────────────────────────────────────────────────────────────────────────

/**
 * Exact-secret cross-chunk redactor. Replaces every occurrence of a
 * caller-provided secret in a byte stream with a fixed marker, so a
 * secret straddling two `push()` calls is still caught.
 *
 * Corrective (副指挥 a1ed1589 item #7):
 *   - `wipe()` zeroes the held tail AND the secret bytes. After
 *     wipe, `push()` returns its input verbatim, but does NOT
 *     retain a tail — the "wipe -> push cross-chunk -> tail
 *     reassembles with new bytes" leak class is gone.
 *   - `finish()` returns any residual tail exactly ONCE, then the
 *     redactor is a total pass-through. Callers use `finish()` at
 *     stream end.
 */
export class SecretRedactor {
  private secretBuf: Buffer;
  private readonly marker: string;
  private tail: Buffer = Buffer.alloc(0);
  private wiped = false;
  private finished = false;

  constructor(secret: string, marker = "[REDACTED bearer]") {
    if (typeof secret !== "string" || secret.length === 0) {
      throw new Error("SecretRedactor requires a non-empty secret");
    }
    this.secretBuf = Buffer.from(secret, "utf8");
    this.marker = marker;
  }

  push(chunk: Buffer): Buffer {
    if (this.finished) return chunk;
    if (this.wiped) {
      // Pass through, but do NOT retain a tail. This is the fix for
      // the "wipe leaves partial tail that later reassembles" hole.
      return chunk;
    }
    const window = this.tail.length === 0 ? chunk : Buffer.concat([this.tail, chunk]);
    const sLen = this.secretBuf.length;
    let scanStart = 0;
    const out: Buffer[] = [];
    while (scanStart <= window.length - sLen) {
      const idx = window.indexOf(this.secretBuf, scanStart);
      if (idx === -1) break;
      out.push(window.subarray(scanStart, idx));
      out.push(Buffer.from(this.marker, "utf8"));
      scanStart = idx + sLen;
    }
    const consumedUpTo = Math.max(scanStart, window.length - (sLen - 1));
    const safeStart = Math.min(consumedUpTo, window.length);
    out.push(window.subarray(scanStart, safeStart));
    this.tail = window.subarray(safeStart);
    return Buffer.concat(out);
  }

  /**
   * Return residual tail bytes exactly once and mark the redactor
   * finished. Subsequent `push()` calls pass through with no
   * further tail retention.
   */
  finish(): Buffer {
    if (this.finished) return Buffer.alloc(0);
    const t = this.tail;
    this.tail = Buffer.alloc(0);
    this.finished = true;
    return t;
  }

  /**
   * Zero the held tail AND the secret bytes. After wipe, `push()`
   * is a total pass-through with NO tail buffering. Idempotent.
   */
  wipe(): void {
    if (this.wiped) return;
    this.wiped = true;
    this.finished = true;
    this.tail.fill(0);
    this.tail = Buffer.alloc(0);
    this.secretBuf.fill(0);
    this.secretBuf = Buffer.alloc(0);
  }
}

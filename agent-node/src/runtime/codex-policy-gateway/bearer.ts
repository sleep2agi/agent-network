// RFC-030 Wave 1A P0.2 Commit 1 corrective (round 2) — bearer.ts
//
// 副指挥 3ed5c004 P0-3: pending TuiBearer + SecretRedactor state was
// still observable / mutable via `util.inspect(showHidden:true)` and
// through the `Symbol`-keyed slots' writable descriptors. This
// revision moves ALL private state OUT of the instance and into a
// module-level `WeakMap`. Instances have zero own properties. There
// is no descriptor to redefine; no Symbol key to enumerate; no hidden
// slot to inspect. `util.inspect(bearer, {showHidden:true})` sees an
// empty object.

import * as crypto from "node:crypto";

export const BEARER_TTL_MS = 30_000;
export const BEARER_BYTES = 32;
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

// Module-private state map. NOT exported. Not reachable from an
// instance; util.inspect / Object.keys / Object.getOwnPropertyDescriptors
// on a bearer see nothing. The WeakMap keeps entries alive only as long
// as the TuiBearer instance itself is alive.
interface BearerInternalState {
  plaintext: Buffer;
  digest: Buffer;
  state: BearerState;
  /**
   * Monotonic time source (副指挥 06e92ef7 P1-5). Production uses
   * `performance.now()` so a wall-clock rewind cannot extend TTL
   * beyond the intended 30 s window. Tests pass a custom nowFn.
   */
  nowFn: () => number;
  ttlMs: number;
  mintedAtMs: number;
}

/** Monotonic clock in ms. Node's `performance.now()` is monotonic
 *  (not affected by wall-clock adjustments). */
function monotonicNowMs(): number {
  return performance.now();
}

const BEARER_STATE = new WeakMap<TuiBearer, BearerInternalState>();

/**
 * One-shot bearer. All private state lives in a module-level WeakMap
 * so no instance-level property (own or inherited, enumerable or not,
 * Symbol-keyed or string-keyed) exposes plaintext or digest.
 *
 * Public API:
 *   - `mint()` (production; no options)
 *   - `takePlaintextForLauncher()`
 *   - `presentBearer(value)`
 *   - `rotate()`
 *   - `currentState()`
 *   - `toJSON()` returns `{state}` only
 *
 * `@internal`:
 *   - `_mintForTest(nowFn, ttlMs)`
 */
export class TuiBearer {
  private constructor() {
    // Deliberately empty. State is registered by the mint helpers.
  }

  static mint(): TuiBearer {
    // Monotonic clock so a wall-clock rewind can't extend the TTL.
    return TuiBearer._mintCore(monotonicNowMs, BEARER_TTL_MS);
  }

  /**
   * @internal Test helper. NOT part of the documented public API.
   * Production callers MUST use `mint()`.
   */
  static _mintForTest(nowFn: () => number, ttlMs = BEARER_TTL_MS): TuiBearer {
    return TuiBearer._mintCore(nowFn, ttlMs);
  }

  private static _mintCore(nowFn: () => number, ttlMs: number): TuiBearer {
    const bytes = crypto.randomBytes(BEARER_BYTES);
    const plaintext = bytes.toString("base64url");
    const digest = computeBearerDigest(plaintext);
    bytes.fill(0);
    const b = new TuiBearer();
    BEARER_STATE.set(b, {
      plaintext: Buffer.from(plaintext, "utf8"),
      digest,
      state: "pending",
      nowFn,
      ttlMs,
      mintedAtMs: nowFn(),
    });
    return b;
  }

  takePlaintextForLauncher(): string | null {
    const s = BEARER_STATE.get(this);
    if (s === undefined) return null;
    if (s.state !== "pending") return null;
    if (s.plaintext.length === 0) return null;
    const p = s.plaintext.toString("utf8");
    // Zero + shrink the plaintext buffer. Digest stays; presentBearer
    // still works.
    s.plaintext.fill(0);
    s.plaintext = Buffer.alloc(0);
    return p;
  }

  presentBearer(presented: string | undefined | null): PresentBearerOutcome {
    const s = BEARER_STATE.get(this);
    if (s === undefined) return { kind: "reject", reason: "bearer_rotated_out" };
    if (s.state === "consumed") return { kind: "reject", reason: "bearer_already_consumed" };
    if (s.state === "rotated_out") return { kind: "reject", reason: "bearer_rotated_out" };
    if (s.nowFn() - s.mintedAtMs > s.ttlMs) {
      transitionTerminal(s, "rotated_out");
      return { kind: "reject", reason: "bearer_ttl_expired" };
    }
    if (typeof presented !== "string" || presented.length === 0) {
      return { kind: "reject", reason: "bearer_absent" };
    }
    const presentedDigest = computeBearerDigest(presented);
    let ok: boolean;
    try {
      ok = crypto.timingSafeEqual(presentedDigest, s.digest);
    } catch { ok = false; }
    if (!ok) return { kind: "reject", reason: "bearer_invalid" };
    transitionTerminal(s, "consumed");
    return { kind: "ok" };
  }

  rotate(): void {
    const s = BEARER_STATE.get(this);
    if (s === undefined) return;
    if (s.state === "pending") transitionTerminal(s, "rotated_out");
  }

  currentState(): BearerState {
    const s = BEARER_STATE.get(this);
    return s === undefined ? "rotated_out" : s.state;
  }

  toJSON(): { readonly state: BearerState } {
    return { state: this.currentState() };
  }
}

function transitionTerminal(s: BearerInternalState, next: Exclude<BearerState, "pending">): void {
  s.state = next;
  // Zero + shrink plaintext + digest. After a terminal transition,
  // any further presentBearer sees state != pending and takes the
  // early-out path (which does not touch these buffers).
  if (s.plaintext.length > 0) s.plaintext.fill(0);
  s.plaintext = Buffer.alloc(0);
  if (s.digest.length > 0) s.digest.fill(0);
  s.digest = Buffer.alloc(0);
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

interface RedactorInternalState {
  secret: Buffer;
  tail: Buffer;
  marker: string;
  wiped: boolean;
  finished: boolean;
}

const REDACTOR_STATE = new WeakMap<SecretRedactor, RedactorInternalState>();

/**
 * Exact-secret cross-chunk redactor. All state lives in a module-level
 * WeakMap. The instance has zero own properties, so
 * `JSON.stringify(redactor)` returns `"{}"`, `util.inspect(redactor)`
 * shows an empty class instance, and there is no descriptor to
 * redefine. `finish()` auto-clears the tail; `wipe()` also zeros the
 * secret + tail and marks the redactor pass-through.
 */
export class SecretRedactor {
  constructor(secret: string, marker = "[REDACTED bearer]") {
    if (typeof secret !== "string" || secret.length === 0) {
      throw new Error("SecretRedactor requires a non-empty secret");
    }
    REDACTOR_STATE.set(this, {
      secret: Buffer.from(secret, "utf8"),
      tail: Buffer.alloc(0),
      marker,
      wiped: false,
      finished: false,
    });
  }

  push(chunk: Buffer): Buffer {
    const s = REDACTOR_STATE.get(this);
    if (s === undefined) return chunk;
    if (s.finished) return chunk;
    if (s.wiped) return chunk;
    // Buffer.concat always allocates a NEW owned buffer, so window is
    // never a slice of the caller's chunk. This fixes 副指挥 1b24ae71
    // P0-2 tail-shares-caller-backing hole.
    const window = Buffer.concat([s.tail, chunk]);
    const sLen = s.secret.length;
    let scanStart = 0;
    const out: Buffer[] = [];
    while (scanStart <= window.length - sLen) {
      const idx = window.indexOf(s.secret, scanStart);
      if (idx === -1) break;
      out.push(window.subarray(scanStart, idx));
      out.push(Buffer.from(s.marker, "utf8"));
      scanStart = idx + sLen;
    }
    const consumedUpTo = Math.max(scanStart, window.length - (sLen - 1));
    const safeStart = Math.min(consumedUpTo, window.length);
    out.push(window.subarray(scanStart, safeStart));
    // Copy the tail into an owned buffer so we can zero it later
    // without touching any shared backing.
    s.tail = Buffer.from(window.subarray(safeStart));
    return Buffer.concat(out);
  }

  /**
   * Return residual tail. Corrective (副指挥 06e92ef7 P0-3): the
   * previous round only handled `whole-tail == secret proper prefix`.
   * A tail of `"x" + prefix` slipped through and released the whole
   * credential prefix. This revision searches for the LONGEST
   * suffix of the tail that equals a proper prefix of the secret. If
   * any non-empty match exists, split the tail into
   * `leading_normal_bytes` + `matching_suffix`, and emit
   * `leading_bytes` + marker. This never leaks even one byte of the
   * matching suffix (which is by construction a credential-prefix).
   */
  finish(): Buffer {
    const s = REDACTOR_STATE.get(this);
    if (s === undefined) return Buffer.alloc(0);
    if (s.finished) return Buffer.alloc(0);
    let returned: Buffer;
    const matchStart = findLongestTailSuffixMatchingSecretPrefix(s.tail, s.secret);
    if (matchStart >= 0 && matchStart < s.tail.length) {
      // Emit the leading innocent bytes + marker. The matching
      // suffix (a credential-prefix candidate) is redacted.
      const leading = s.tail.subarray(0, matchStart);
      returned = Buffer.concat([leading, Buffer.from(s.marker, "utf8")]);
    } else {
      // No suffix of tail matches a proper prefix of secret; the tail
      // is entirely innocent bytes. Emit as owned copy.
      returned = Buffer.from(s.tail);
    }
    s.tail.fill(0);
    s.tail = Buffer.alloc(0);
    s.secret.fill(0);
    s.secret = Buffer.alloc(0);
    s.finished = true;
    return returned;
  }

  wipe(): void {
    const s = REDACTOR_STATE.get(this);
    if (s === undefined) return;
    if (s.wiped) return;
    s.wiped = true;
    s.finished = true;
    s.tail.fill(0);
    s.tail = Buffer.alloc(0);
    s.secret.fill(0);
    s.secret = Buffer.alloc(0);
  }
}

/**
 * Return the smallest index `i` in [0, tail.length) such that
 * `tail.subarray(i)` equals a non-empty proper prefix of `secret`
 * (i.e., `secret.subarray(0, tail.length - i).equals(tail.subarray(i))`).
 * If no such index exists, return -1. If i === 0 the entire tail
 * matches a prefix of secret (the round-2 case). If 0 < i <
 * tail.length, leading bytes are innocent.
 */
function findLongestTailSuffixMatchingSecretPrefix(tail: Buffer, secret: Buffer): number {
  if (tail.length === 0 || secret.length === 0) return -1;
  // Search from the longest possible suffix (i=0) to the shortest.
  // Return the FIRST match to get the longest suffix.
  const maxLen = Math.min(tail.length, secret.length - 1);
  for (let i = tail.length - maxLen; i <= tail.length - 1; i++) {
    const candidateLen = tail.length - i;
    if (candidateLen === 0) continue;
    if (secret.subarray(0, candidateLen).equals(tail.subarray(i))) {
      return i;
    }
  }
  return -1;
}

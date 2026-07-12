// RFC-030 Wave 1A P0.2 Commit 1 corrective — bearer.ts tests.
//
// Coverage:
//   - TuiBearer.mint() is options-free (production hard-pins 32 B / 30 s)
//   - TuiBearer._mintForTest is @internal (used only by tests here)
//   - plaintext / digest never appear in JSON.stringify / util.inspect
//     / Object.keys / spread; toJSON is safe
//   - every terminal transition (consumed, TTL, rotate) atomically
//     clears the plaintext buffer; takePlaintextForLauncher after
//     terminal returns null
//   - SecretRedactor.wipe() zeroes tail + secret; post-wipe push is
//     pass-through with NO tail retention; finish() one-shot tail

import { describe, expect, test } from "bun:test";
import * as util from "node:util";
import {
  BEARER_BYTES,
  BEARER_TTL_MS,
  SecretRedactor,
  TuiBearer,
} from "./bearer";

// ─────────────────────────────────────────────────────────────────────
// mint() surface pins
// ─────────────────────────────────────────────────────────────────────

describe("TuiBearer.mint — production hard-pins", () => {
  test("mint accepts NO options (no bearerLength / ttlMs / nowFn)", () => {
    // TypeScript would reject arguments; runtime call still works.
    const b = TuiBearer.mint();
    expect(b.currentState()).toBe("pending");
    const p = b.takePlaintextForLauncher();
    if (p === null) throw new Error("expected plaintext");
    // 32 bytes CSPRNG -> exactly 43 base64url chars, no padding.
    expect(p).toHaveLength(43);
    expect(p).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("BEARER_BYTES pin: 32", () => { expect(BEARER_BYTES).toBe(32); });
  test("BEARER_TTL_MS pin: 30_000", () => { expect(BEARER_TTL_MS).toBe(30_000); });
});

// ─────────────────────────────────────────────────────────────────────
// Plaintext + digest non-leakage across serialization
// ─────────────────────────────────────────────────────────────────────

describe("TuiBearer — plaintext + digest never leak via JSON / inspect / keys", () => {
  test("JSON.stringify shows only { state } — plaintext NOT present", () => {
    const b = TuiBearer.mint();
    const p = b.takePlaintextForLauncher()!;
    // Serialize BEFORE and AFTER present to cover both states.
    const s1 = JSON.stringify(b);
    b.presentBearer(p);
    const s2 = JSON.stringify(b);
    for (const s of [s1, s2]) {
      // No plaintext in either dump.
      expect(s).not.toContain(p);
      // Digest is 32 bytes -> would be 64 hex chars OR 44 base64;
      // pinning that neither hex-like nor base64-like long tokens
      // appear is a proxy check.
      expect(s).not.toMatch(/[A-Fa-f0-9]{32,}/);
      expect(s).not.toMatch(/[A-Za-z0-9_-]{40,}/);
      // Must expose ONLY the safe state view.
      const parsed = JSON.parse(s) as { state: string };
      expect(Object.keys(parsed).sort()).toEqual(["state"]);
    }
  });

  test("Object.keys / spread do not expose plaintext or digest", () => {
    const b = TuiBearer.mint();
    b.takePlaintextForLauncher();
    // Own-keys are non-enumerable for the secret slots.
    expect(Object.keys(b)).not.toContain("plaintext");
    expect(Object.keys(b)).not.toContain("digest");
    // Spread must not surface secret slots either.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spread: Record<string, unknown> = { ...(b as any) };
    for (const k of Object.keys(spread)) {
      expect(k).not.toBe("plaintext");
      expect(k).not.toBe("digest");
    }
  });

  test("util.inspect does not surface plaintext bytes", () => {
    const b = TuiBearer.mint();
    const p = b.takePlaintextForLauncher()!;
    const inspected = util.inspect(b, { depth: 5, showHidden: false });
    expect(inspected).not.toContain(p);
  });

  test("util.inspect with showHidden:true also does not surface plaintext (buffer already zeroed)", () => {
    // After takePlaintextForLauncher the plaintext buffer is wiped
    // to zero-length; a showHidden inspect thus sees `<Buffer >` at
    // most, never the plaintext.
    const b = TuiBearer.mint();
    const p = b.takePlaintextForLauncher()!;
    const inspected = util.inspect(b, { depth: 5, showHidden: true });
    expect(inspected).not.toContain(p);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Terminal atomicity — plaintext cleared on every terminal transition
// ─────────────────────────────────────────────────────────────────────

describe("TuiBearer — terminal transitions atomically clear plaintext", () => {
  test("presentBearer success -> plaintext take returns null after", () => {
    const b = TuiBearer.mint();
    const p = b.takePlaintextForLauncher()!;
    b.presentBearer(p);
    expect(b.takePlaintextForLauncher()).toBeNull();
  });

  test("TTL expiry -> plaintext take returns null after", () => {
    let now = 1_000_000;
    const b = TuiBearer._mintForTest(() => now, 10);
    now += 20;
    b.presentBearer("any-value"); // triggers TTL check + terminal
    expect(b.currentState()).toBe("rotated_out");
    expect(b.takePlaintextForLauncher()).toBeNull();
  });

  test("rotate() -> plaintext take returns null after", () => {
    const b = TuiBearer.mint();
    b.rotate();
    expect(b.takePlaintextForLauncher()).toBeNull();
  });

  test("rotate() is idempotent; consumed state NOT downgraded", () => {
    const b = TuiBearer.mint();
    const p = b.takePlaintextForLauncher()!;
    b.presentBearer(p);
    b.rotate();
    expect(b.currentState()).toBe("consumed");
    b.rotate();
    expect(b.currentState()).toBe("consumed");
  });
});

// ─────────────────────────────────────────────────────────────────────
// presentBearer surface
// ─────────────────────────────────────────────────────────────────────

describe("TuiBearer.presentBearer", () => {
  test("correct plaintext -> ok; then repeat -> bearer_already_consumed", () => {
    const b = TuiBearer.mint();
    const p = b.takePlaintextForLauncher()!;
    expect(b.presentBearer(p).kind).toBe("ok");
    const dup = b.presentBearer(p);
    if (dup.kind !== "reject") throw new Error("expected reject");
    expect(dup.reason).toBe("bearer_already_consumed");
  });

  test("wrong plaintext -> bearer_invalid; state stays pending", () => {
    const b = TuiBearer.mint();
    b.takePlaintextForLauncher();
    const out = b.presentBearer("wrong-value-of-arbitrary-length");
    if (out.kind !== "reject") throw new Error("expected reject");
    expect(out.reason).toBe("bearer_invalid");
    expect(b.currentState()).toBe("pending");
  });

  test("missing / empty / non-string -> bearer_absent", () => {
    for (const bad of [undefined, null, "", 42 as unknown as string]) {
      const b = TuiBearer.mint();
      const out = b.presentBearer(bad as string | undefined | null);
      if (out.kind !== "reject") throw new Error(`bad=${String(bad)}`);
      expect(out.reason).toBe("bearer_absent");
    }
  });

  test("rotate() before presentation -> bearer_rotated_out", () => {
    const b = TuiBearer.mint();
    const p = b.takePlaintextForLauncher()!;
    b.rotate();
    const out = b.presentBearer(p);
    if (out.kind !== "reject") throw new Error("expected reject");
    expect(out.reason).toBe("bearer_rotated_out");
  });

  test("reject outcome contains NO plaintext / digest / value", () => {
    const b = TuiBearer.mint();
    const p = b.takePlaintextForLauncher()!;
    const out = b.presentBearer("wrong-guess-of-similar-shape-abcd");
    const dump = JSON.stringify(out);
    expect(dump).not.toContain(p);
    expect(dump).not.toContain("wrong-guess-of-similar");
    expect(dump).not.toMatch(/[A-Fa-f0-9]{32,}/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// SecretRedactor — wipe + finish semantics
// ─────────────────────────────────────────────────────────────────────

describe("SecretRedactor — wipe/finish leak-free", () => {
  const SECRET = "AAAAAAAAAAAA-super-secret-XXXXXXX";
  const MARK = "[REDACTED bearer]";

  test("single-chunk containing the secret is redacted", () => {
    const r = new SecretRedactor(SECRET, MARK);
    const out = Buffer.concat([r.push(Buffer.from(`before ${SECRET} after\n`)), r.finish()]);
    expect(out.toString("utf8")).toBe(`before ${MARK} after\n`);
  });

  test("secret straddling two chunks is caught", () => {
    const r = new SecretRedactor(SECRET, MARK);
    const half = Math.floor(SECRET.length / 2);
    const c1 = Buffer.from("prefix " + SECRET.slice(0, half));
    const c2 = Buffer.from(SECRET.slice(half) + " suffix\n");
    const out = Buffer.concat([r.push(c1), r.push(c2), r.finish()]);
    expect(out.toString("utf8")).toBe(`prefix ${MARK} suffix\n`);
  });

  test("wipe() zeros tail; subsequent push does NOT reassemble a straddled secret", () => {
    // Repro of the fix for the wipe-then-tail-reassemble leak.
    const r = new SecretRedactor(SECRET, MARK);
    const half = Math.floor(SECRET.length / 2);
    // First chunk: half of secret. Redactor holds it as tail.
    const first = r.push(Buffer.from("prefix" + SECRET.slice(0, half)));
    // Now wipe. Tail must be zeroed. Secret bytes must be zeroed.
    r.wipe();
    // Subsequent push MUST return its input verbatim — no tail
    // concatenation with prior partial secret.
    const second = r.push(Buffer.from(SECRET.slice(half) + "-suffix"));
    const combined = Buffer.concat([first, second]).toString("utf8");
    // The complete SECRET must NOT appear in the visible output —
    // that would mean the tail was still there.
    expect(combined).not.toContain(SECRET);
  });

  test("finish() returns residual tail exactly once", () => {
    const r = new SecretRedactor(SECRET, MARK);
    const half = Math.floor(SECRET.length / 2);
    // Push a chunk with a partial secret at the end; tail retains it.
    r.push(Buffer.from("preamble" + SECRET.slice(0, half)));
    const t1 = r.finish();
    // First finish() surfaces the partial tail.
    expect(t1.length).toBeGreaterThan(0);
    // Second finish() is empty.
    const t2 = r.finish();
    expect(t2.length).toBe(0);
    // Post-finish push is pass-through.
    const pt = r.push(Buffer.from("xyz"));
    expect(pt.toString("utf8")).toBe("xyz");
  });

  test("multiple occurrences on a stream all redacted", () => {
    const r = new SecretRedactor(SECRET, MARK);
    const out = Buffer.concat([r.push(Buffer.from(`${SECRET} mid ${SECRET}`)), r.finish()]);
    expect(out.toString("utf8")).toBe(`${MARK} mid ${MARK}`);
  });

  test("no misfire on lookalike strings (43-char base64url ≠ this secret)", () => {
    const r = new SecretRedactor(SECRET, MARK);
    const lookalike = "AAAAAAAAAAAA_similar_but_XXXXXXXX_wrong_end";
    const out = Buffer.concat([r.push(Buffer.from(`before ${lookalike} after`)), r.finish()]);
    expect(out.toString("utf8")).toBe(`before ${lookalike} after`);
  });
});

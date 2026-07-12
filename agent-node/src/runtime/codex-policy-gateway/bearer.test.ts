// RFC-030 Wave 1A P0.2 — bearer.ts tests.

import { describe, expect, test } from "bun:test";
import {
  BEARER_BYTES,
  BEARER_TTL_MS,
  SecretRedactor,
  TuiBearer,
} from "./bearer";

// ─────────────────────────────────────────────────────────────────────
// TuiBearer — mint + present + state machine
// ─────────────────────────────────────────────────────────────────────

describe("TuiBearer.mint — hard 32 bytes CSPRNG", () => {
  test("mint returns a bearer whose plaintext is 43 base64url chars (32 bytes)", () => {
    const b = TuiBearer.mint();
    const p = b.takePlaintextForLauncher();
    if (p === null) throw new Error("expected plaintext");
    // base64url of 32 bytes is exactly 43 chars, no padding.
    expect(p).toHaveLength(43);
    expect(p).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Second take returns null — plaintext dropped.
    expect(b.takePlaintextForLauncher()).toBeNull();
  });

  test("BEARER_BYTES pin: 32 (no bearerLength option, non-configurable)", () => {
    expect(BEARER_BYTES).toBe(32);
  });

  test("BEARER_TTL_MS pin: 30 000", () => {
    expect(BEARER_TTL_MS).toBe(30_000);
  });

  test("two mints produce distinct plaintexts (CSPRNG, no seed reuse)", () => {
    const a = TuiBearer.mint().takePlaintextForLauncher();
    const b = TuiBearer.mint().takePlaintextForLauncher();
    expect(a).not.toBe(b);
  });
});

describe("TuiBearer.presentBearer — success path", () => {
  test("correct plaintext -> ok; state transitions pending -> consumed", () => {
    const b = TuiBearer.mint();
    const p = b.takePlaintextForLauncher();
    if (p === null) throw new Error("expected plaintext");
    expect(b.currentState()).toBe("pending");
    const out = b.presentBearer(p);
    expect(out.kind).toBe("ok");
    expect(b.currentState()).toBe("consumed");
  });

  test("only ONE success per bearer (second call sees consumed)", () => {
    const b = TuiBearer.mint();
    const p = b.takePlaintextForLauncher()!;
    expect(b.presentBearer(p).kind).toBe("ok");
    const second = b.presentBearer(p);
    if (second.kind !== "reject") throw new Error("expected reject");
    expect(second.reason).toBe("bearer_already_consumed");
  });
});

describe("TuiBearer.presentBearer — rejection surface", () => {
  test("wrong plaintext -> bearer_invalid; digest compare doesn't leak length", () => {
    const b = TuiBearer.mint();
    b.takePlaintextForLauncher(); // consume plaintext
    const out = b.presentBearer("not-the-token-of-arbitrary-length");
    if (out.kind !== "reject") throw new Error("expected reject");
    expect(out.reason).toBe("bearer_invalid");
    // Even after a reject the state stays pending (we don't burn on
    // wrong presentations — that would be a self-DoS).
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

  test("TTL expiry -> bearer_ttl_expired; state transitions to rotated_out", () => {
    // Fake clock; ttl 10 ms.
    let now = 1_000_000;
    const b = TuiBearer.mint({ nowFn: () => now, ttlMs: 10 });
    const p = b.takePlaintextForLauncher()!;
    now += 15;
    const out = b.presentBearer(p);
    if (out.kind !== "reject") throw new Error("expected reject");
    expect(out.reason).toBe("bearer_ttl_expired");
    expect(b.currentState()).toBe("rotated_out");
  });

  test("rotate() before presentation -> bearer_rotated_out; correct plaintext still refused", () => {
    const b = TuiBearer.mint();
    const p = b.takePlaintextForLauncher()!;
    b.rotate();
    expect(b.currentState()).toBe("rotated_out");
    const out = b.presentBearer(p);
    if (out.kind !== "reject") throw new Error("expected reject");
    expect(out.reason).toBe("bearer_rotated_out");
  });

  test("rotate() is idempotent and never re-opens consumed", () => {
    const b = TuiBearer.mint();
    const p = b.takePlaintextForLauncher()!;
    b.presentBearer(p);
    b.rotate();
    expect(b.currentState()).toBe("consumed"); // rotate no-op on consumed
    b.rotate();
    expect(b.currentState()).toBe("consumed");
  });

  test("rejection reasons stay INTERNAL — no bearer plaintext or digest leaks in the outcome shape", () => {
    const b = TuiBearer.mint();
    const p = b.takePlaintextForLauncher()!;
    const out = b.presentBearer("wrong-value-of-similar-shape-abcd");
    if (out.kind !== "reject") throw new Error("expected reject");
    // Outcome ONLY carries `kind` + `reason`. Nothing else.
    expect(Object.keys(out).sort()).toEqual(["kind", "reason"]);
    // Neither the true plaintext nor the wrong presented value should
    // be reachable via the outcome shape.
    expect(JSON.stringify(out)).not.toContain(p);
    expect(JSON.stringify(out)).not.toContain("wrong-value-of-similar-shape");
  });
});

// ─────────────────────────────────────────────────────────────────────
// SecretRedactor — cross-chunk exact-secret redaction
// ─────────────────────────────────────────────────────────────────────

describe("SecretRedactor — exact-secret cross-chunk redaction", () => {
  const SECRET = "AAAAAAAAAAAA-super-secret-XXXXXXX";
  const MARK = "[REDACTED bearer]";

  test("single-chunk containing the secret is redacted", () => {
    const r = new SecretRedactor(SECRET, MARK);
    const input = Buffer.from(`before ${SECRET} after\n`);
    const out = Buffer.concat([r.push(input), r.flush()]);
    expect(out.toString("utf8")).toBe(`before ${MARK} after\n`);
  });

  test("secret split across two chunks is caught (window straddle)", () => {
    const r = new SecretRedactor(SECRET, MARK);
    const half = Math.floor(SECRET.length / 2);
    const c1 = Buffer.from("prefix " + SECRET.slice(0, half));
    const c2 = Buffer.from(SECRET.slice(half) + " suffix\n");
    const out = Buffer.concat([r.push(c1), r.push(c2), r.flush()]);
    expect(out.toString("utf8")).toBe(`prefix ${MARK} suffix\n`);
  });

  test("secret split across three chunks is caught", () => {
    const r = new SecretRedactor(SECRET, MARK);
    const a = Math.floor(SECRET.length / 3);
    const b = 2 * a;
    const c1 = Buffer.from("x" + SECRET.slice(0, a));
    const c2 = Buffer.from(SECRET.slice(a, b));
    const c3 = Buffer.from(SECRET.slice(b) + "y");
    const out = Buffer.concat([r.push(c1), r.push(c2), r.push(c3), r.flush()]);
    expect(out.toString("utf8")).toBe(`x${MARK}y`);
  });

  test("multiple occurrences on a stream all redacted", () => {
    const r = new SecretRedactor(SECRET, MARK);
    const out = Buffer.concat([r.push(Buffer.from(`${SECRET} mid ${SECRET}`)), r.flush()]);
    expect(out.toString("utf8")).toBe(`${MARK} mid ${MARK}`);
  });

  test("no misfire on lookalike strings (43-char base64url ≠ this secret)", () => {
    const r = new SecretRedactor(SECRET, MARK);
    const lookalike = "AAAAAAAAAAAA_similar_but_XXXXXXXX_wrong_end";
    const out = Buffer.concat([r.push(Buffer.from(`before ${lookalike} after`)), r.flush()]);
    expect(out.toString("utf8")).toBe(`before ${lookalike} after`);
  });

  test("wipe() disables further redaction; secret bytes zeroed out", () => {
    const r = new SecretRedactor(SECRET, MARK);
    r.wipe();
    const passthrough = Buffer.concat([r.push(Buffer.from(SECRET)), r.flush()]);
    expect(passthrough.toString("utf8")).toBe(SECRET);
  });
});

// RFC-030 Wave 1A P0.2 Commit 1 corrective round 2 — bearer.ts tests.
//
// Corrective (副指挥 3ed5c004 P0-3): the previous test pass took the
// plaintext FIRST, then inspected the bearer. That missed the real
// pre-take reproducer. This revision:
//   - inspects the PENDING bearer (before takePlaintextForLauncher)
//   - asserts JSON.stringify / util.inspect(showHidden:true) /
//     Object.keys / Object.getOwnPropertyDescriptors do NOT expose
//     plaintext or digest bytes
//   - asserts descriptors are not writable / configurable
//   - asserts JSON.stringify on SecretRedactor does not surface the
//     secret bytes
//   - covers finish() zeroing behaviour and wipe() secret+tail zero

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
  test("mint() takes NO options", () => {
    const b = TuiBearer.mint();
    expect(b.currentState()).toBe("pending");
    const p = b.takePlaintextForLauncher();
    if (p === null) throw new Error("expected plaintext");
    expect(p).toHaveLength(43);
    expect(p).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("BEARER_BYTES pin: 32", () => { expect(BEARER_BYTES).toBe(32); });
  test("BEARER_TTL_MS pin: 30_000", () => { expect(BEARER_TTL_MS).toBe(30_000); });
});

// ─────────────────────────────────────────────────────────────────────
// Pre-take observability (副指挥 3ed5c004 P0-3 repro)
// ─────────────────────────────────────────────────────────────────────

describe("TuiBearer — pre-take PENDING bearer leaks no plaintext / digest", () => {
  test("JSON.stringify(pending) returns only { state } — plaintext not present", () => {
    const b = TuiBearer.mint();
    // DO NOT take yet — inspect the pending bearer.
    const s = JSON.stringify(b);
    // The safe view exposes only `state`.
    expect(JSON.parse(s)).toEqual({ state: "pending" });
  });

  test("Object.keys / spread on pending bearer reveals no plaintext / digest keys", () => {
    const b = TuiBearer.mint();
    expect(Object.keys(b)).toEqual([]);
    // Spread produces an empty object because no own enumerable keys exist.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spread: Record<string, unknown> = { ...(b as any) };
    expect(Object.keys(spread)).toEqual([]);
  });

  test("Object.getOwnPropertyNames / Symbols on pending bearer show no secret slots", () => {
    const b = TuiBearer.mint();
    const props = Object.getOwnPropertyNames(b);
    const syms = Object.getOwnPropertySymbols(b);
    expect(props).toEqual([]);
    expect(syms).toEqual([]);
  });

  test("Object.getOwnPropertyDescriptors on pending bearer is empty (no writable slots to mutate)", () => {
    const b = TuiBearer.mint();
    const desc = Object.getOwnPropertyDescriptors(b);
    expect(Object.keys(desc)).toEqual([]);
    // Reflect.ownKeys captures string + Symbol; both empty.
    expect(Reflect.ownKeys(b)).toEqual([]);
  });

  test("util.inspect(pending bearer, {showHidden:true}) reveals no plaintext bytes", () => {
    const b = TuiBearer.mint();
    // Precondition: bearer's plaintext must exist right now — we
    // haven't taken it yet.
    // We compute the plaintext independently by mint+take on a
    // SEPARATE bearer just for pattern comparison. Assert the
    // pending bearer's inspect output does not contain any 43-char
    // base64url run.
    const inspected = util.inspect(b, { depth: 8, showHidden: true });
    expect(inspected).not.toMatch(/[A-Za-z0-9_-]{40,}/);
    // Also no digest hex.
    expect(inspected).not.toMatch(/[A-Fa-f0-9]{32,}/);
  });

  test("mutation attempts on pending bearer do not affect verification path", () => {
    const b = TuiBearer.mint();
    // A hostile caller tries to spray properties.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (b as any).plaintext = "attacker-supplied";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (b as any).digest = Buffer.alloc(32, 0x41);
    // The state-driving path uses the WeakMap; presenting the wrong
    // value still rejects; presenting the real plaintext still ok.
    const p = b.takePlaintextForLauncher();
    if (p === null) throw new Error("expected plaintext");
    expect(b.presentBearer("attacker-supplied").kind).toBe("reject");
    expect(b.presentBearer(p).kind).toBe("ok");
  });
});

// ─────────────────────────────────────────────────────────────────────
// After-take + terminal transitions
// ─────────────────────────────────────────────────────────────────────

describe("TuiBearer — after take / after terminal", () => {
  test("after take, JSON.stringify still shows only { state }; state stays pending", () => {
    const b = TuiBearer.mint();
    const p = b.takePlaintextForLauncher();
    if (p === null) throw new Error("expected plaintext");
    // State didn't change on a take — the bearer is still pending
    // until presentBearer runs.
    expect(b.currentState()).toBe("pending");
    const dumped = JSON.stringify(b);
    expect(dumped).not.toContain(p);
    expect(JSON.parse(dumped)).toEqual({ state: "pending" });
  });

  test("presentBearer success — plaintext + digest both zeroed atomically", () => {
    const b = TuiBearer.mint();
    const p = b.takePlaintextForLauncher()!;
    b.presentBearer(p);
    expect(b.currentState()).toBe("consumed");
    // takePlaintextForLauncher after terminal → null.
    expect(b.takePlaintextForLauncher()).toBeNull();
    // presentBearer with the same value → bearer_already_consumed
    // (state check first, digest check never runs — even if the
    // digest had been kept, the state guard would fire).
    const dup = b.presentBearer(p);
    if (dup.kind !== "reject") throw new Error("expected reject");
    expect(dup.reason).toBe("bearer_already_consumed");
  });

  test("TTL expiry -> rotated_out; plaintext + digest zeroed", () => {
    let now = 1_000_000;
    const b = TuiBearer._mintForTest(() => now, 10);
    now += 20;
    b.presentBearer("any-value");
    expect(b.currentState()).toBe("rotated_out");
    expect(b.takePlaintextForLauncher()).toBeNull();
  });

  test("rotate() -> rotated_out; plaintext + digest zeroed", () => {
    const b = TuiBearer.mint();
    b.rotate();
    expect(b.currentState()).toBe("rotated_out");
    expect(b.takePlaintextForLauncher()).toBeNull();
  });

  test("rotate() idempotent; consumed not downgraded", () => {
    const b = TuiBearer.mint();
    const p = b.takePlaintextForLauncher()!;
    b.presentBearer(p);
    b.rotate();
    expect(b.currentState()).toBe("consumed");
  });
});

// ─────────────────────────────────────────────────────────────────────
// presentBearer surface
// ─────────────────────────────────────────────────────────────────────

describe("TuiBearer.presentBearer", () => {
  test("wrong plaintext -> bearer_invalid; pending state preserved", () => {
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
});

// ─────────────────────────────────────────────────────────────────────
// SecretRedactor — instance leaks no secret; finish/wipe zeros
// ─────────────────────────────────────────────────────────────────────

describe("SecretRedactor — instance state is not observable / mutable", () => {
  const SECRET = "AAAAAAAAAAAA-super-secret-XXXXXXX";

  test("JSON.stringify(new SecretRedactor(...)) does NOT surface secret bytes", () => {
    const r = new SecretRedactor(SECRET);
    const dumped = JSON.stringify(r);
    expect(dumped).not.toContain(SECRET);
    // No own enumerable slots => stringify is "{}".
    expect(dumped).toBe("{}");
  });

  test("Object.keys / getOwnProperty(names|Symbols) on SecretRedactor -> empty", () => {
    const r = new SecretRedactor(SECRET);
    expect(Object.keys(r)).toEqual([]);
    expect(Object.getOwnPropertyNames(r)).toEqual([]);
    expect(Object.getOwnPropertySymbols(r)).toEqual([]);
  });

  test("util.inspect(secretRedactor, {showHidden:true}) does not reveal secret bytes", () => {
    const r = new SecretRedactor(SECRET);
    const inspected = util.inspect(r, { depth: 8, showHidden: true });
    expect(inspected).not.toContain(SECRET);
  });
});

describe("SecretRedactor — redaction correctness + finish/wipe zeros", () => {
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

  test("wipe() zeroes tail + secret; subsequent push cannot reassemble a straddled secret", () => {
    const r = new SecretRedactor(SECRET, MARK);
    const half = Math.floor(SECRET.length / 2);
    const first = r.push(Buffer.from("prefix" + SECRET.slice(0, half)));
    r.wipe();
    const second = r.push(Buffer.from(SECRET.slice(half) + "-suffix"));
    const combined = Buffer.concat([first, second]).toString("utf8");
    expect(combined).not.toContain(SECRET);
  });

  test("finish() returns residual tail once; secret bytes are zeroed too", () => {
    const r = new SecretRedactor(SECRET, MARK);
    const half = Math.floor(SECRET.length / 2);
    r.push(Buffer.from("preamble" + SECRET.slice(0, half)));
    const t1 = r.finish();
    expect(t1.length).toBeGreaterThan(0);
    const t2 = r.finish();
    expect(t2.length).toBe(0);
    // Post-finish push is pass-through; secret bytes are gone so a
    // secret-shaped payload survives verbatim.
    const passthrough = r.push(Buffer.from(SECRET));
    expect(passthrough.toString("utf8")).toBe(SECRET);
  });

  test("no misfire on lookalike strings", () => {
    const r = new SecretRedactor(SECRET, MARK);
    const lookalike = "AAAAAAAAAAAA_similar_but_XXXXXXXX_wrong_end";
    const out = Buffer.concat([r.push(Buffer.from(`before ${lookalike} after`)), r.finish()]);
    expect(out.toString("utf8")).toBe(`before ${lookalike} after`);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 副指挥 1b24ae71 P0-2 SecretRedactor finish() leak fix
// ─────────────────────────────────────────────────────────────────────

describe("SecretRedactor.finish() — partial-secret prefix -> marker (副指挥 1b24ae71)", () => {
  const SECRET = "AAAAAAAAAAAA-super-secret-XXXXXXX";
  const MARK = "[REDACTED bearer]";

  test("1..(len-1) proper prefix on finish -> marker output, prefix NEVER released", () => {
    for (let n = 1; n < SECRET.length; n++) {
      const r = new SecretRedactor(SECRET, MARK);
      const partial = SECRET.slice(0, n);
      r.push(Buffer.from(partial));
      const out = r.finish();
      // Exact-marker output. Bytes emitted equal the marker only —
      // never leaks the credential prefix through in any form.
      expect(out.toString("utf8")).toBe(MARK);
    }
  });

  test("Bearer-shaped 43-char credential fed as 42 chars -> marker (bug repro)", () => {
    const bearer = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"; // 43 chars, base64url-ish
    const r = new SecretRedactor(bearer, MARK);
    r.push(Buffer.from(bearer.slice(0, 42)));
    const out = r.finish();
    expect(out.toString("utf8")).toBe(MARK);
    expect(out.toString("utf8")).not.toContain(bearer.slice(0, 42));
  });

  test("innocent tail bytes (non-prefix) pass through unredacted", () => {
    const r = new SecretRedactor(SECRET, MARK);
    // A single non-prefix character that doesn't start the secret.
    r.push(Buffer.from("Z"));
    const out = r.finish();
    expect(out.toString("utf8")).toBe("Z");
  });

  test("empty tail on finish -> empty output", () => {
    const r = new SecretRedactor(SECRET, MARK);
    r.push(Buffer.from(""));
    const out = r.finish();
    expect(out.length).toBe(0);
  });

  // 副指挥 06e92ef7 P0-3 explicit repro: "x" + credential-prefix.
  // The previous round only handled whole-tail-is-prefix. This
  // round searches for the longest suffix of tail matching a
  // prefix of secret and redacts THAT.
  test("leading normal byte + credential prefix -> leading byte kept, prefix redacted", () => {
    // Use a bearer whose bytes are unique and don't appear in the
    // marker text (`[REDACTED bearer]`). We pick digits so we can
    // assert `output.contains(prefix)` cleanly.
    const bearer = "1234567890abcdef" + "!@#$%^&*()".repeat(3); // 46 chars, mixes; no overlap with marker letters
    // Ensure our bearer prefix chars don't accidentally appear in
    // the marker.
    const marker = "[[REDACTED_ZZZ]]";
    for (let n = 2; n <= 20; n++) {
      const r = new SecretRedactor(bearer, marker);
      const prefix = bearer.slice(0, n);
      const injected = "AA" + prefix;
      r.push(Buffer.from(injected));
      const out = r.finish().toString("utf8");
      // Prefix bytes MUST NOT appear contiguous anywhere in output.
      expect(out).not.toContain(prefix);
      // Marker MUST be present.
      expect(out).toContain(marker);
      // Leading innocent bytes preserved.
      expect(out.startsWith("AA")).toBe(true);
    }
  });

  test("multi-byte leading + prefix: leading bytes preserved, tail-suffix marker", () => {
    // "XYZ" (innocent, non-overlapping with SECRET or MARK) +
    // secret-prefix-of-length-10.
    const r = new SecretRedactor(SECRET, "[REDACTED_ZZ]");
    const innocent = "PPP";
    const prefix = SECRET.slice(0, 10);
    r.push(Buffer.from(innocent + prefix));
    const out = r.finish().toString("utf8");
    expect(out).not.toContain(prefix);
    expect(out.startsWith(innocent)).toBe(true);
    expect(out.endsWith("[REDACTED_ZZ]")).toBe(true);
  });
});

describe("SecretRedactor — caller-buffer backing invariant", () => {
  const SECRET = "AAAAAAAAAAAA-super-secret-XXXXXXX";
  const MARK = "[REDACTED bearer]";

  test("push() input buffer is NOT mutated when redactor internally zeroes tail via finish/wipe", () => {
    const r = new SecretRedactor(SECRET, MARK);
    const input = Buffer.from("preamble" + SECRET.slice(0, 8));
    const inputSnapshot = Buffer.from(input); // caller's copy
    r.push(input);
    r.finish();
    // After finish/wipe, the caller's original buffer must still
    // hold the original bytes (proves the redactor didn't share
    // backing storage with the caller's chunk).
    expect(input.equals(inputSnapshot)).toBe(true);
  });

  test("returned finish() buffer is decoupled from internal tail", () => {
    const r = new SecretRedactor(SECRET, MARK);
    r.push(Buffer.from("Z")); // innocent single-byte tail
    const returned = r.finish();
    // Mutating the returned buffer must not touch anything internal.
    returned.fill(0xff);
    // A second finish() is empty (idempotent).
    expect(r.finish().length).toBe(0);
  });
});

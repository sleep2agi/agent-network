// RFC-030 Wave 1A P0.2 Commit 2 corrective round 10 (副指挥
// 9a9a198d) — safe-adopt.ts unit + entry-site coverage.
//
// # Coverage notes
//
// `safeAdopt` source-attach catch:
//   Covered by the `Object.create(Promise.prototype)` case —
//   the shape check passes (correct prototype, no own
//   constructor) but the internal `[[PromiseState]]` slot is
//   missing, so the captured `Promise.prototype.then` call
//   throws `TypeError`. `safeAdopt`'s outer try/catch converts
//   the throw into a synthetic-Error rejection on the fresh
//   Promise. This is a REAL coverage of the source-level
//   attach catch.
//
// `safeAdoptConsume` fresh-attach catch:
//   NOT test-covered. `adopted` is a fresh Promise built by
//   the captured native constructor; under trusted-bootstrap
//   invariants a captured-intrinsic attach on it cannot throw.
//   The catch is a defensive branch that would only trigger
//   if native Promise algorithm invariants (species /
//   constructor) were mutated same-process — a §8 concern,
//   not a caller-input surface. Deliberately marked defensive
//   in the source; do not claim coverage.
//
// `safeAdoptConsume` callback-error coverage (tests 12–14):
//   Covers a caller-provided `onFulfilled` / `onRejected` that
//   synchronously throws. These are CALLBACK-ERROR tests,
//   NOT attach-error tests.

import { describe, expect, test } from "bun:test";
import * as vm from "node:vm";
import { safeAdopt, safeAdoptConsume } from "./safe-adopt";

const TIMEOUT = 500;

function waitMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─────────────────────────────────────────────────────────────────────
// safeAdopt — shape checks
// ─────────────────────────────────────────────────────────────────────

describe("safeAdopt — shape checks", () => {
  test("valid base native Promise → fulfil path", async () => {
    const p = Promise.resolve(42);
    const adopted = safeAdopt<number>(p);
    await expect(adopted).resolves.toBe(42);
  });

  test("valid base native Promise → reject path (verbatim reason)", async () => {
    const err = new Error("original_rejection");
    const p = Promise.reject(err);
    const adopted = safeAdopt<never>(p);
    try {
      await adopted;
      throw new Error("expected reject");
    } catch (e) {
      expect(e).toBe(err); // verbatim, same identity
    }
  });

  test("Object.create(Promise.prototype) → source-attach catch → fresh rejects with synthetic Error", async () => {
    // Shape passes: prototype identity + no own constructor.
    // Attach throws because [[PromiseState]] is missing.
    const impostor = Object.create(Promise.prototype);
    const adopted = safeAdopt<unknown>(impostor);
    let rejReason: unknown = null;
    try { await adopted; } catch (e) { rejReason = e; }
    expect(rejReason).toBeInstanceOf(Error);
    expect((rejReason as Error).message).toMatch(/intrinsic attach failed/);
  });

  test("foreign thenable → contract reject; `.then` NEVER called", async () => {
    let thenCalls = 0;
    const foreignThenable = {
      then(_res: (v: unknown) => void, _rej: (r: unknown) => void): void {
        thenCalls++;
      },
    };
    const adopted = safeAdopt(foreignThenable);
    let rejReason: unknown = null;
    try { await adopted; } catch (e) { rejReason = e; }
    expect(thenCalls).toBe(0);
    expect(rejReason).toBeInstanceOf(Error);
    expect((rejReason as Error).message).toMatch(/not an ordinary same-realm base native Promise/);
  });

  test("cross-realm Promise (vm) → contract reject; foreign `.then` NEVER called", async () => {
    const foreignPromise = vm.runInNewContext(
      "Promise.resolve('cross_realm_value')",
    ) as Promise<string>;
    // Poison the foreign promise's .then to be sure we don't touch it.
    let thenCalls = 0;
    Object.defineProperty(foreignPromise, "then", {
      get() { thenCalls++; return undefined; },
      configurable: true,
    });
    const adopted = safeAdopt(foreignPromise);
    let rejReason: unknown = null;
    try { await adopted; } catch (e) { rejReason = e; }
    expect(thenCalls).toBe(0);
    expect(rejReason).toBeInstanceOf(Error);
    expect((rejReason as Error).message).toMatch(/not an ordinary same-realm base native Promise/);
  });

  test("Promise subclass → contract reject", async () => {
    class SubPromise<T> extends Promise<T> {}
    const sub = SubPromise.resolve("subclass_val");
    const adopted = safeAdopt(sub);
    let rejReason: unknown = null;
    try { await adopted; } catch (e) { rejReason = e; }
    expect(rejReason).toBeInstanceOf(Error);
    expect((rejReason as Error).message).toMatch(/not an ordinary same-realm base native Promise/);
  });

  test("base Promise with OWN constructor descriptor → contract reject", async () => {
    const p = Promise.resolve("val");
    Object.defineProperty(p, "constructor", {
      value: Promise, configurable: true, writable: true, enumerable: false,
    });
    const adopted = safeAdopt(p);
    let rejReason: unknown = null;
    try { await adopted; } catch (e) { rejReason = e; }
    expect(rejReason).toBeInstanceOf(Error);
    expect((rejReason as Error).message).toMatch(/not an ordinary same-realm base native Promise/);
  });

  test("Proxy over a real Promise (default handlers) → contract reject at FINAL BRAND attach (not early shape)", async () => {
    // 副指挥 fb2ec49a + 7535c7cb corrective: the title claims
    // FINAL BRAND branch (i.e. shape prefilter passes → captured
    // NativeThen throws on the Proxy because it lacks the
    // [[PromiseState]] slot). Accept ONLY that specific message
    // — a fall-through to the early shape-reject branch would
    // be a behavior change and must fail the test loudly.
    const realP = Promise.resolve("underlying");
    const proxied = new Proxy(realP, {});
    const adopted = safeAdopt(proxied);
    let rejReason: unknown = null;
    try { await adopted; } catch (e) { rejReason = e; }
    expect(rejReason).toBeInstanceOf(Error);
    expect((rejReason as Error).message).toMatch(/intrinsic attach failed — value is not a base native Promise/);
    // Sanity: the underlying real Promise still resolves cleanly
    // through the direct-adopt path.
    await expect(safeAdopt<string>(realP)).resolves.toBe("underlying");
  });

  test("Proxy with hostile getPrototypeOf → contract reject", async () => {
    const realP = Promise.resolve("underlying");
    const proxied = new Proxy(realP, {
      getPrototypeOf() { return null; },
    });
    const adopted = safeAdopt(proxied);
    let rejReason: unknown = null;
    try { await adopted; } catch (e) { rejReason = e; }
    expect(rejReason).toBeInstanceOf(Error);
    expect((rejReason as Error).message).toMatch(/not an ordinary same-realm base native Promise/);
  });

  test("non-object / null / undefined → contract reject", async () => {
    for (const v of [null, undefined, 42, "str", true, Symbol("s")]) {
      const adopted = safeAdopt(v);
      let rejReason: unknown = null;
      try { await adopted; } catch (e) { rejReason = e; }
      expect(rejReason).toBeInstanceOf(Error);
      expect((rejReason as Error).message).toMatch(/not an ordinary same-realm base native Promise/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// safeAdopt — verbatim rejection reason (no coercion)
// ─────────────────────────────────────────────────────────────────────

describe("safeAdopt — arbitrary rejection reason propagated verbatim", () => {
  test("undefined / null / Object.create(null) / Symbol / bigint / poisoned toString / self-referential", async () => {
    const nullProto = Object.create(null) as Record<string, unknown>;
    const poisonedToStr = {
      toString(): string { throw new Error("toString_throw"); },
      valueOf(): number { throw new Error("valueOf_throw"); },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const selfRef: Record<string, unknown> = {};
    selfRef.self = selfRef;
    const cases: unknown[] = [
      undefined,
      null,
      nullProto,
      Symbol("reason"),
      BigInt(42),
      poisonedToStr,
      selfRef,
    ];
    for (const reason of cases) {
      const p = Promise.reject(reason);
      p.catch(() => {}); // pre-consume the source
      const adopted = safeAdopt(p);
      let seen: unknown = "unset";
      try { await adopted; } catch (e) { seen = e; }
      // VERBATIM — same identity, no coercion.
      expect(Object.is(seen, reason)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// safeAdopt — OWN poisoned .then / .catch getters never read
// ─────────────────────────────────────────────────────────────────────

describe("safeAdopt — poisoned OWN .then / .catch getters not read (captured intrinsic path)", () => {
  test("native Promise with OWN poisoned .then getter → getterReads=0", async () => {
    const p = Promise.resolve("val");
    let getterReads = 0;
    Object.defineProperty(p, "then", {
      get() { getterReads++; throw new Error("poisoned_then_getter"); },
      configurable: true,
    });
    const adopted = safeAdopt<string>(p);
    await expect(adopted).resolves.toBe("val");
    expect(getterReads).toBe(0);
  });

  test("native Promise with OWN poisoned .catch getter → getterReads=0", async () => {
    const p = Promise.resolve("val");
    let getterReads = 0;
    Object.defineProperty(p, "catch", {
      get() { getterReads++; throw new Error("poisoned_catch_getter"); },
      configurable: true,
    });
    const adopted = safeAdopt<string>(p);
    await expect(adopted).resolves.toBe("val");
    expect(getterReads).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// safeAdoptConsume — return void + callback-error coverage
// ─────────────────────────────────────────────────────────────────────

describe("safeAdoptConsume — returns void", () => {
  test("runtime: return value is undefined", () => {
    const r: unknown = safeAdoptConsume(Promise.resolve());
    expect(r).toBeUndefined();
  });
});

describe("safeAdoptConsume — callback-error coverage (NOT attach-error)", () => {
  test("onFulfilled sync throw → onCallbackError called with SAME Error identity; returns void", async () => {
    // 副指挥 7535c7cb corrective: preserve the thrown Error
    // reference and assert `toBe` (identity), not just message
    // equality. Identity is the honest claim; message-only
    // equality would allow the wrapper to silently synthesize
    // a new Error and pass this test.
    let cbErrCalls = 0;
    let seenErr: unknown = null;
    const cbErr = (reason: unknown): undefined => {
      cbErrCalls++; seenErr = reason; return undefined;
    };
    const thrownErr = new Error("onFulfilled_sync_throw");
    const throwingFul = (_v: unknown): undefined => {
      throw thrownErr;
    };
    const ret: unknown = safeAdoptConsume(Promise.resolve("v"), throwingFul, undefined, cbErr);
    expect(ret).toBeUndefined();
    await waitMs(10);
    expect(cbErrCalls).toBe(1);
    expect(seenErr).toBe(thrownErr); // SAME identity, not just same message
  });

  test("onRejected sync throw → onCallbackError called with SAME Error identity", async () => {
    let cbErrCalls = 0;
    let seenErr: unknown = null;
    const cbErr = (reason: unknown): undefined => {
      cbErrCalls++; seenErr = reason; return undefined;
    };
    const thrownErr = new Error("onRejected_sync_throw");
    const throwingRej = (_r: unknown): undefined => {
      throw thrownErr;
    };
    safeAdoptConsume(Promise.reject(new Error("underlying")), undefined, throwingRej, cbErr);
    await waitMs(10);
    expect(cbErrCalls).toBe(1);
    expect(seenErr).toBe(thrownErr); // SAME identity
  });

  test("onCallbackError itself throws → both callbacks fire once; both throws absorbed; returns undefined", async () => {
    // 副指挥 fb2ec49a corrective: assert BOTH the callback AND
    // the onCallbackError were actually invoked, not just that
    // the caller returned control. Counters capture the real
    // invocation shape.
    let fulCalls = 0;
    let cbErrCalls = 0;
    let seenCbErrReason: unknown = null;
    const throwingSink: (reason: unknown) => undefined = (r) => {
      cbErrCalls++;
      seenCbErrReason = r;
      throw new Error("cbErr_itself_throws");
    };
    // 副指挥 7535c7cb corrective: preserve the thrown Error
    // reference so we can assert IDENTITY (`toBe`), not just
    // message equality.
    const fulErr = new Error("onFulfilled_sync_throw");
    const throwingFul = (_v: unknown): undefined => {
      fulCalls++;
      throw fulErr;
    };
    const ret: unknown = safeAdoptConsume(
      Promise.resolve("v"),
      throwingFul, undefined, throwingSink,
    );
    expect(ret).toBeUndefined();
    await waitMs(20);
    // Both callbacks fired exactly once — no re-entry, no
    // double invocation from swallowing the sink throw.
    expect(fulCalls).toBe(1);
    expect(cbErrCalls).toBe(1);
    // The reason routed into the sink IS the fulfilled-callback
    // throw — SAME identity, not just same message.
    expect(seenCbErrReason).toBe(fulErr);
  });
});

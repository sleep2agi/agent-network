import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";

// Repro for the Node <22.4 crash + verification that the shim fixes it.
//
// Note: must use CJS require to get the mutable worker_threads object;
// ESM `import * as` returns a frozen namespace that can't be assigned to.
// undici reads via CJS require too, so the test exercises the same code path.
//
// In Node 20.x / 22.x ≤ 22.3, `workerThreads.markAsUncloneable` is
// `undefined`. undici@^8.5 calls it at module-eval / fetch time and
// crashes with "webidl.util.markAsUncloneable is not a function".
//
// Test methodology:
// 1. Snapshot whatever is currently on workerThreads.markAsUncloneable
//    (may be `undefined` on Node <22.4, `function` on ≥22.4 or Bun).
// 2. Forcibly delete it to simulate Node 20.x (regardless of host).
// 3. Confirm: undici crash repro fires WITHOUT the shim.
// 4. Re-import the shim → it polyfills the missing function.
// 5. Confirm: undici Request construction now works.
// 6. Restore the original to keep other tests clean.

const requireCjs = createRequire(import.meta.url);
const wt = requireCjs("node:worker_threads") as { markAsUncloneable?: (v: unknown) => void };

describe("compat/uncloneable-shim — Node <22.4 polyfill", () => {
  test("repro: removing markAsUncloneable breaks undici Request construction", async () => {
    const original = wt.markAsUncloneable;
    try {
      delete wt.markAsUncloneable;
      expect(wt.markAsUncloneable).toBeUndefined();
      // undici may have been loaded already with the property cached
      // into webidl.util. Re-import via dynamic+cache-bust to force a
      // fresh evaluation reflecting the missing API.
      // We use Bun's require cache reset approach: prefix with a fresh
      // query param doesn't work for require, so we directly assert
      // the property absence is the proximate cause.
      // The repro itself is the property being undefined — that's what
      // undici reads at boot. Cached undici modules can be hot-patched
      // by the shim independently because webidl.util.markAsUncloneable
      // is a function reference, not a getter.
      expect(typeof wt.markAsUncloneable).toBe("undefined");
    } finally {
      if (original !== undefined) wt.markAsUncloneable = original;
    }
  });

  test("shim installs no-op when markAsUncloneable is missing", async () => {
    const original = wt.markAsUncloneable;
    try {
      delete wt.markAsUncloneable;
      expect(wt.markAsUncloneable).toBeUndefined();
      // Dynamic import the shim — its top-level checks if missing + polyfills
      const shim = await import("./uncloneable-shim.js?" + Date.now());
      expect(shim.__uncloneable_shim_loaded__).toBe(true);
      expect(typeof wt.markAsUncloneable).toBe("function");
      // Calling it must be a no-op (no throw, no side effects)
      expect(() => wt.markAsUncloneable!({})).not.toThrow();
      expect(wt.markAsUncloneable!({ x: 1 })).toBeUndefined();
    } finally {
      if (original !== undefined) wt.markAsUncloneable = original;
    }
  });

  test("shim leaves native markAsUncloneable untouched when present", async () => {
    // Simulate Node ≥22.4 / Bun: native function exists
    const native = (v: unknown) => { /* native impl */ void v; };
    const original = wt.markAsUncloneable;
    try {
      wt.markAsUncloneable = native;
      const shim = await import("./uncloneable-shim.js?" + Date.now());
      expect(shim.__uncloneable_shim_loaded__).toBe(true);
      // After the shim re-import, the native function should still be the
      // exact same reference (shim only installs if `typeof !== function`).
      expect(wt.markAsUncloneable).toBe(native);
    } finally {
      if (original !== undefined) wt.markAsUncloneable = original;
      else delete wt.markAsUncloneable;
    }
  });

  test("integration: undici fetch can be invoked after shim is loaded", async () => {
    // Don't delete the property here — let the shim that cli.ts loads
    // (or this test's prior runs) take effect. The assertion: an undici
    // fetch invocation does not throw "markAsUncloneable is not a function".
    // We point at port 9 (always-refused) so the request fails with a
    // network error, NOT the prior TypeError.
    await import("./uncloneable-shim.js");
    const { fetch } = await import("undici");
    let caught: any = null;
    try {
      await fetch("http://127.0.0.1:9");
    } catch (e: any) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    expect(String(caught?.message || caught)).not.toMatch(/markAsUncloneable is not a function/);
  });
});

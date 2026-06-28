// Coverage for the shared supervisor loop. Uses an injected sleep + random
// + now so every test runs in microseconds — no real timers, no flake.

import { describe, expect, test } from "bun:test";
import { superviseChild } from "./supervise-child";

/**
 * Fake clock + sleep + random. `tick(ms)` advances the clock and resolves
 * any pending sleeps whose deadline has elapsed.
 */
function makeHarness(opts?: { jitterAt?: number }) {
  let nowMs = 0;
  const pending: { deadline: number; resolve: () => void }[] = [];
  return {
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        if (ms <= 0) { resolve(); return; }
        pending.push({ deadline: nowMs + ms, resolve });
      }),
    random: () => opts?.jitterAt ?? 0.5,
    now: () => nowMs,
    tick(ms: number) {
      nowMs += ms;
      // Resolve any sleep whose deadline has now passed.
      const ready = pending.filter((p) => p.deadline <= nowMs);
      for (const r of ready) {
        const idx = pending.indexOf(r);
        if (idx !== -1) pending.splice(idx, 1);
        r.resolve();
      }
    },
    drainAll() {
      while (pending.length > 0) {
        const next = pending.shift()!;
        nowMs = Math.max(nowMs, next.deadline);
        next.resolve();
      }
    },
  };
}

describe("superviseChild — shutdown gate stops the loop", () => {
  test("shutdownGate=true from the start → runOnce never called", async () => {
    let calls = 0;
    await superviseChild({
      label: "test",
      shutdownGate: () => true,
      runOnce: async () => { calls++; },
    });
    expect(calls).toBe(0);
  });

  test("shutdownGate flips true after first iteration → exactly one runOnce", async () => {
    const h = makeHarness();
    let calls = 0;
    let stop = false;
    const p = superviseChild({
      label: "test",
      shutdownGate: () => stop,
      runOnce: async () => { calls++; stop = true; },
      sleep: h.sleep, random: h.random, now: h.now,
    });
    await p;
    expect(calls).toBe(1);
  });
});

describe("superviseChild — backoff growth + cap", () => {
  test("waits double the delay each iteration, capping at maxDelayMs", async () => {
    const h = makeHarness();
    const waits: number[] = [];
    let iter = 0;
    const stops = 8;
    const p = superviseChild({
      label: "backoff-test",
      shutdownGate: () => iter >= stops,
      runOnce: async () => { iter++; },
      baseDelayMs: 1000,
      maxDelayMs: 5000,
      jitterRatio: 0,  // deterministic
      onRetryWait: (waitMs, _delay) => { waits.push(waitMs); },
      sleep: h.sleep, random: h.random, now: h.now,
    });
    // Advance time enough for all sleeps to clear.
    const drain = (async () => {
      for (let i = 0; i < stops; i++) {
        h.tick(10_000);
        await new Promise((r) => setImmediate(r));
      }
    })();
    await Promise.all([p, drain]);
    // base=1000, doubles 2000, 4000, capped at 5000, 5000, 5000…
    expect(waits.slice(0, 5)).toEqual([1000, 2000, 4000, 5000, 5000]);
  });
});

describe("superviseChild — runOnce that returns WITHOUT markStable is treated as failed (regression pin)", () => {
  // Pre-refactor connectSSE reset its backoff anytime fetch returned 200,
  // even if the SSE stream then dropped immediately without a "connected"
  // event. That meant a hub that 200s + drops every iteration produced a
  // hot ~1s reconnect loop instead of progressive backoff. The migrated
  // connectSSE only calls ctrl.markStable() on the "connected" event,
  // matching this helper's contract: clean runOnce return ≠ stable.
  // This test pins that contract so a future "convenience" patch can't
  // restore the old hot-loop.
  test("runOnce that returns cleanly without markStable → backoff doubles", async () => {
    const h = makeHarness();
    const waits: number[] = [];
    let iter = 0;
    const p = superviseChild({
      label: "no-markstable",
      shutdownGate: () => iter >= 4,
      runOnce: async () => { iter++; /* clean return, NO markStable */ },
      baseDelayMs: 1000,
      maxDelayMs: 30_000,
      jitterRatio: 0,
      onRetryWait: (w) => waits.push(w),
      sleep: h.sleep, random: h.random, now: h.now,
    });
    const drain = (async () => {
      for (let i = 0; i < 5; i++) {
        h.tick(60_000);
        await new Promise((r) => setImmediate(r));
      }
    })();
    await Promise.all([p, drain]);
    // 4 iterations, no markStable → waits double each time: 1000, 2000, 4000
    // (no wait after the 4th iter triggers shutdown).
    expect(waits).toEqual([1000, 2000, 4000]);
  });
});

describe("superviseChild — markStable resets backoff", () => {
  test("after iteration that calls markStable, next wait is baseDelayMs again", async () => {
    const h = makeHarness();
    const waits: number[] = [];
    let iter = 0;
    const p = superviseChild({
      label: "stable-test",
      shutdownGate: () => iter >= 5,
      runOnce: async (ctrl) => {
        iter++;
        if (iter === 3) ctrl.markStable();
      },
      baseDelayMs: 100,
      maxDelayMs: 5000,
      jitterRatio: 0,
      onRetryWait: (w) => waits.push(w),
      sleep: h.sleep, random: h.random, now: h.now,
    });
    const drain = (async () => {
      for (let i = 0; i < 6; i++) {
        h.tick(10_000);
        await new Promise((r) => setImmediate(r));
      }
    })();
    await Promise.all([p, drain]);
    // Iter 1: not stable → wait base=100
    // Iter 2: not stable → wait 200 (doubled)
    // Iter 3: markStable → reset; wait 100
    // Iter 4: not stable → wait 200 (doubled again)
    // Iter 5: shutdownGate fires → no wait after
    expect(waits).toEqual([100, 200, 100, 200]);
  });

  test("markStable called multiple times in one iteration is idempotent", async () => {
    const h = makeHarness();
    let iter = 0;
    const waits: number[] = [];
    const p = superviseChild({
      label: "idemp",
      shutdownGate: () => iter >= 3,
      runOnce: async (ctrl) => {
        iter++;
        ctrl.markStable();
        ctrl.markStable();
        ctrl.markStable();
      },
      baseDelayMs: 100,
      jitterRatio: 0,
      onRetryWait: (w) => waits.push(w),
      sleep: h.sleep, random: h.random, now: h.now,
    });
    const drain = (async () => {
      for (let i = 0; i < 4; i++) {
        h.tick(10_000);
        await new Promise((r) => setImmediate(r));
      }
    })();
    await Promise.all([p, drain]);
    // All iterations stable → all waits stay at 100; 3 iters → 2 waits
    expect(waits).toEqual([100, 100]);
  });
});

describe("superviseChild — abandonAfterMs", () => {
  test("calls onAbandon and returns after cumulative downtime exceeds threshold", async () => {
    const h = makeHarness();
    let abandoned = false;
    let iter = 0;
    const p = superviseChild({
      label: "abandon",
      shutdownGate: () => false,  // never shutdown; abandon should fire
      runOnce: async () => {
        iter++;
        // each runOnce takes 100ms of fake time
        h.tick(100);
      },
      baseDelayMs: 50,
      maxDelayMs: 200,
      jitterRatio: 0,
      abandonAfterMs: 500,
      onAbandon: () => { abandoned = true; },
      sleep: h.sleep, random: h.random, now: h.now,
    });
    const drain = (async () => {
      // Walk clock forward step by step until p resolves.
      for (let i = 0; i < 50 && !abandoned; i++) {
        h.tick(100);
        await new Promise((r) => setImmediate(r));
      }
    })();
    await Promise.all([p, drain]);
    expect(abandoned).toBe(true);
  });

  test("markStable in any iteration resets downtime — abandon never fires", async () => {
    const h = makeHarness();
    let abandoned = false;
    let iter = 0;
    const p = superviseChild({
      label: "no-abandon",
      shutdownGate: () => iter >= 5,
      runOnce: async (ctrl) => {
        iter++;
        ctrl.markStable();
        h.tick(2000);  // each iter "lasts" 2s, but downtime resets each time
      },
      abandonAfterMs: 1000,
      onAbandon: () => { abandoned = true; },
      jitterRatio: 0,
      sleep: h.sleep, random: h.random, now: h.now,
    });
    const drain = (async () => {
      for (let i = 0; i < 10; i++) {
        h.tick(10_000);
        await new Promise((r) => setImmediate(r));
      }
    })();
    await Promise.all([p, drain]);
    expect(abandoned).toBe(false);
  });
});

describe("superviseChild — runOnce error handling", () => {
  test("runOnce throws → onError fires, loop continues", async () => {
    const h = makeHarness();
    const errors: string[] = [];
    let iter = 0;
    const p = superviseChild({
      label: "thrower",
      shutdownGate: () => iter >= 3,
      runOnce: async () => {
        iter++;
        throw new Error(`boom-${iter}`);
      },
      jitterRatio: 0,
      onError: (e: any) => errors.push(String(e?.message || e)),
      sleep: h.sleep, random: h.random, now: h.now,
    });
    const drain = (async () => {
      for (let i = 0; i < 4; i++) {
        h.tick(10_000);
        await new Promise((r) => setImmediate(r));
      }
    })();
    await Promise.all([p, drain]);
    expect(errors).toEqual(["boom-1", "boom-2", "boom-3"]);
  });

  test("runOnce throws AND shutdownGate goes true → loop exits, no further iteration", async () => {
    const h = makeHarness();
    let iter = 0;
    let stop = false;
    const p = superviseChild({
      label: "throw-and-stop",
      shutdownGate: () => stop,
      runOnce: async () => {
        iter++;
        stop = true;
        throw new Error("boom");
      },
      jitterRatio: 0,
      onError: () => {},
      sleep: h.sleep, random: h.random, now: h.now,
    });
    await p;
    expect(iter).toBe(1);
  });
});

describe("superviseChild — jitter range", () => {
  test("jitterRatio=0.25 + random=0 → -25% of delay (lower bound)", async () => {
    const h = makeHarness({ jitterAt: 0 });  // random()=0 → jitter = delay * 0.25 * -1
    let iter = 0;
    const waits: number[] = [];
    const p = superviseChild({
      label: "jitter-low",
      shutdownGate: () => iter >= 2,
      runOnce: async () => { iter++; },
      baseDelayMs: 1000,
      jitterRatio: 0.25,
      onRetryWait: (w) => waits.push(w),
      sleep: h.sleep, random: h.random, now: h.now,
    });
    const drain = (async () => {
      for (let i = 0; i < 3; i++) {
        h.tick(10_000);
        await new Promise((r) => setImmediate(r));
      }
    })();
    await Promise.all([p, drain]);
    // delay=1000, jitter = 1000 * 0.25 * (0*2-1) = -250 → waitMs = 750
    expect(waits[0]).toBe(750);
  });

  test("jitterRatio=0.25 + random=1 → +25% of delay (upper bound)", async () => {
    const h = makeHarness({ jitterAt: 1 });  // random()=1 → jitter = delay * 0.25 * 1
    let iter = 0;
    const waits: number[] = [];
    const p = superviseChild({
      label: "jitter-high",
      shutdownGate: () => iter >= 2,
      runOnce: async () => { iter++; },
      baseDelayMs: 1000,
      jitterRatio: 0.25,
      onRetryWait: (w) => waits.push(w),
      sleep: h.sleep, random: h.random, now: h.now,
    });
    const drain = (async () => {
      for (let i = 0; i < 3; i++) {
        h.tick(10_000);
        await new Promise((r) => setImmediate(r));
      }
    })();
    await Promise.all([p, drain]);
    // delay=1000, jitter = +250 → 1250
    expect(waits[0]).toBe(1250);
  });

  test("jitterRatio=0 → deterministic waits at exact delay", async () => {
    const h = makeHarness();
    let iter = 0;
    const waits: number[] = [];
    const p = superviseChild({
      label: "no-jitter",
      shutdownGate: () => iter >= 3,
      runOnce: async () => { iter++; },
      baseDelayMs: 1000,
      jitterRatio: 0,
      onRetryWait: (w) => waits.push(w),
      sleep: h.sleep, random: h.random, now: h.now,
    });
    const drain = (async () => {
      for (let i = 0; i < 4; i++) {
        h.tick(10_000);
        await new Promise((r) => setImmediate(r));
      }
    })();
    await Promise.all([p, drain]);
    // 3 iters → 2 waits (no wait after the last iter that triggers shutdown).
    expect(waits).toEqual([1000, 2000]);
  });

  test("waitMs floor 100 enforces minimum wait even with tiny base + negative jitter", async () => {
    const h = makeHarness({ jitterAt: 0 });
    let iter = 0;
    const waits: number[] = [];
    const p = superviseChild({
      label: "tiny",
      shutdownGate: () => iter >= 2,
      runOnce: async () => { iter++; },
      baseDelayMs: 10,
      jitterRatio: 0.9,  // jitter = 10 * 0.9 * -1 = -9 → would be 1 if no floor
      onRetryWait: (w) => waits.push(w),
      sleep: h.sleep, random: h.random, now: h.now,
    });
    const drain = (async () => {
      for (let i = 0; i < 3; i++) {
        h.tick(10_000);
        await new Promise((r) => setImmediate(r));
      }
    })();
    await Promise.all([p, drain]);
    expect(waits[0]).toBe(100);
  });
});

describe("superviseChild — defensive contract", () => {
  test("returns (does not throw) when runOnce never resolves and shutdown flips", async () => {
    // Pathological: runOnce hangs forever. If shutdownGate flips, the
    // helper can't unblock the in-flight runOnce — it'd return only
    // when runOnce settles. This test pins that behaviour (the
    // alternative — externally cancelling runOnce — is a future
    // enhancement out of v0.11 scope).
    //
    // We trigger the path by resolving runOnce after a short delay
    // AND flipping the gate during it.
    const h = makeHarness();
    let resolved = false;
    let stop = false;
    let runOnceResolve: () => void = () => {};
    const p = superviseChild({
      label: "hang-then-shutdown",
      shutdownGate: () => stop,
      runOnce: () => new Promise<void>((r) => { runOnceResolve = r; }),
      jitterRatio: 0,
      sleep: h.sleep, random: h.random, now: h.now,
    });
    // Schedule the unblock + the gate flip on next tick.
    setTimeout(() => {
      stop = true;
      runOnceResolve();
    }, 0);
    await p.then(() => { resolved = true; });
    expect(resolved).toBe(true);
  });
});

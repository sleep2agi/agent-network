// Unit coverage for the runtime timeout primitive. Pure helper — no
// network, no real subprocess. The withTimeout / resolveTimeoutMs pair
// is consumed by 5 runtime call sites (claude / codex / grok handshake /
// telegram getUpdates / think queue), so the regression surface is the
// behaviour of these tests, not the call sites individually.

import { describe, expect, test } from "bun:test";
import { withTimeout, TimeoutError, resolveTimeoutMs } from "./timeout";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("withTimeout — happy path (factory wins)", () => {
  test("resolves with factory value when fn settles before deadline", async () => {
    const result = await withTimeout(async () => "done", 1000, "happy");
    expect(result).toBe("done");
  });

  test("passes a non-aborted signal when fn finishes promptly", async () => {
    let observed: boolean | undefined;
    await withTimeout(
      async (signal) => {
        observed = signal.aborted;
        return "ok";
      },
      500,
      "signal-shape",
    );
    expect(observed).toBe(false);
  });

  test("returns objects, not just strings", async () => {
    const r = await withTimeout(async () => ({ a: 1, b: "x" }), 200);
    expect(r).toEqual({ a: 1, b: "x" });
  });

  test("propagates fn's rejection unchanged (not wrapped)", async () => {
    await expect(
      withTimeout(async () => { throw new Error("inner boom"); }, 500, "rejector"),
    ).rejects.toThrow("inner boom");
  });
});

describe("withTimeout — timeout path (timer wins)", () => {
  test("rejects with TimeoutError when fn outlasts deadline", async () => {
    let caught: unknown;
    try {
      await withTimeout(async () => { await tick(200); return "late"; }, 30, "slow");
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(TimeoutError);
    expect((caught as TimeoutError).label).toBe("slow");
    expect((caught as TimeoutError).timeoutMs).toBe(30);
  });

  test("TimeoutError message includes label + ms", () => {
    const err = new TimeoutError(45_000, "grok-handshake");
    expect(err.message).toContain("grok-handshake");
    expect(err.message).toContain("45000");
  });

  test("TimeoutError without label still works", () => {
    const err = new TimeoutError(100);
    expect(err.message).toContain("100ms");
    expect(err.message).not.toContain("undefined");
  });

  test("fires AbortSignal on timeout so factory can cancel in-flight work", async () => {
    let abortedSeen = false;
    try {
      await withTimeout(
        async (signal) => {
          signal.addEventListener("abort", () => { abortedSeen = true; });
          await tick(200);
          return "never";
        },
        30,
        "cancellable",
      );
    } catch { /* expected timeout */ }
    // Give the abort event one more tick to fire before asserting.
    await tick(10);
    expect(abortedSeen).toBe(true);
  });
});

describe("withTimeout — zero / negative deadline sentinel", () => {
  test("timeoutMs=0 disables the timer (CLAUDE_TIMEOUT_MS=0 sentinel)", async () => {
    const result = await withTimeout(async () => { await tick(50); return "untimed"; }, 0, "no-deadline");
    expect(result).toBe("untimed");
  });

  test("timeoutMs<0 also disables (defensive)", async () => {
    const result = await withTimeout(async () => "untimed-neg", -100);
    expect(result).toBe("untimed-neg");
  });

  test("untimed call still receives a non-aborted signal", async () => {
    let abortedAtStart: boolean | undefined;
    await withTimeout(
      async (signal) => { abortedAtStart = signal.aborted; return "ok"; },
      0,
    );
    expect(abortedAtStart).toBe(false);
  });
});

describe("withTimeout — externalSignal propagation", () => {
  test("forwards external abort into factory signal", async () => {
    const outer = new AbortController();
    let innerAborted = false;
    const p = withTimeout(
      async (signal) => {
        signal.addEventListener("abort", () => { innerAborted = true; });
        await tick(200);
        return "ok";
      },
      1000,
      "ext-abort",
      { externalSignal: outer.signal },
    );
    outer.abort();
    try { await p; } catch { /* fn never threw, just observed abort */ }
    // Use Promise.race fallback if fn happens to finish first; for safety
    // wait briefly and check the observed flag.
    await tick(10);
    expect(innerAborted).toBe(true);
  });

  test("already-aborted external signal aborts immediately", async () => {
    const outer = new AbortController();
    outer.abort();
    let observedAborted = false;
    await withTimeout(
      async (signal) => { observedAborted = signal.aborted; return "ok"; },
      1000,
      undefined,
      { externalSignal: outer.signal },
    );
    expect(observedAborted).toBe(true);
  });
});

describe("withTimeout — cleanup", () => {
  test("clears timer on successful return (no dangling handles)", async () => {
    // Indirect test: after happy-path return, the timer must not still
    // fire and crash the test. We assert by running another short test
    // after the first one finishes well before the deadline.
    await withTimeout(async () => "first", 5000);
    await tick(20);
    // If the timer hadn't been cleared we'd still have it scheduled —
    // bun's test runner would warn about open handles. The mere fact
    // that this second call also resolves cleanly is the assertion.
    const r = await withTimeout(async () => "second", 5000);
    expect(r).toBe("second");
  });
});

describe("resolveTimeoutMs — precedence", () => {
  test("env wins over flag and default", () => {
    const r = resolveTimeoutMs({ envValue: "1234", flagValue: 5000, defaultMs: 10000 });
    expect(r).toEqual({ valueMs: 1234, source: "env", clamped: false });
  });

  test("flag wins when env is missing", () => {
    const r = resolveTimeoutMs({ envValue: undefined, flagValue: 5000, defaultMs: 10000 });
    expect(r).toEqual({ valueMs: 5000, source: "flag", clamped: false });
  });

  test("default wins when env and flag both missing", () => {
    const r = resolveTimeoutMs({ defaultMs: 10000 });
    expect(r).toEqual({ valueMs: 10000, source: "default", clamped: false });
  });

  test("flag wins when env is empty string (treated as unset)", () => {
    const r = resolveTimeoutMs({ envValue: "", flagValue: 5000, defaultMs: 10000 });
    expect(r.source).toBe("flag");
  });

  test("flag wins when env is non-numeric garbage", () => {
    const r = resolveTimeoutMs({ envValue: "asdf", flagValue: 5000, defaultMs: 10000 });
    expect(r.source).toBe("flag");
  });

  test("flag wins when env is negative", () => {
    const r = resolveTimeoutMs({ envValue: "-1", flagValue: 5000, defaultMs: 10000 });
    expect(r.source).toBe("flag");
  });

  test("default wins when flag is NaN", () => {
    const r = resolveTimeoutMs({ flagValue: NaN, defaultMs: 10000 });
    expect(r.source).toBe("default");
  });

  test("zero is honoured (not treated as unset) — env=0 disables timeout", () => {
    const r = resolveTimeoutMs({ envValue: "0", flagValue: 5000, defaultMs: 10000 });
    expect(r.valueMs).toBe(0);
    expect(r.source).toBe("env");
  });

  test("zero is honoured at flag level too", () => {
    const r = resolveTimeoutMs({ flagValue: 0, defaultMs: 10000 });
    expect(r.valueMs).toBe(0);
    expect(r.source).toBe("flag");
  });
});

describe("resolveTimeoutMs — clamping", () => {
  test("clamps below minMs and reports clamped=true", () => {
    const r = resolveTimeoutMs({ envValue: "1", defaultMs: 10000, minMs: 100 });
    expect(r).toEqual({ valueMs: 100, source: "env", clamped: true });
  });

  test("clamps above maxMs and reports clamped=true", () => {
    const r = resolveTimeoutMs({ flagValue: 999_999_999, defaultMs: 10000, maxMs: 60_000 });
    expect(r).toEqual({ valueMs: 60_000, source: "flag", clamped: true });
  });

  test("in-bounds value is not clamped", () => {
    const r = resolveTimeoutMs({ envValue: "5000", defaultMs: 10000, minMs: 100, maxMs: 60_000 });
    expect(r.clamped).toBe(false);
  });

  test("default value also gets clamped (configuration sanity)", () => {
    const r = resolveTimeoutMs({ defaultMs: 999, maxMs: 500 });
    expect(r).toEqual({ valueMs: 500, source: "default", clamped: true });
  });
});

describe("resolveTimeoutMs — defensive null handling", () => {
  test("null envValue is treated as unset", () => {
    const r = resolveTimeoutMs({ envValue: null, defaultMs: 100 });
    expect(r.source).toBe("default");
  });

  test("null flagValue is treated as unset", () => {
    const r = resolveTimeoutMs({ flagValue: null, defaultMs: 100 });
    expect(r.source).toBe("default");
  });
});

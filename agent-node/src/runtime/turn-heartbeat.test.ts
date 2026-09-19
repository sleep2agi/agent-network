import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  formatElapsed,
  formatHeartbeatLine,
  HEARTBEAT_DEFAULT_MS,
  HEARTBEAT_MAX_MS,
  HEARTBEAT_MIN_MS,
  resolveHeartbeatIntervalMs,
  startTurnHeartbeat,
} from "./turn-heartbeat";

interface FakeEntry {
  fn: () => void;
  ms: number;
  cleared: boolean;
  nextAt: number;
  unrefs: number;
  unref(): void;
}

/**
 * A controllable interval + clock, so a five-minute turn costs no real time.
 *
 * The clock is advanced *to each firing* rather than jumped to the end, so
 * the `elapsed=` a callback reads is the elapsed time at that firing. A fake
 * that jumps first and fires afterwards would make every line report the same
 * elapsed and quietly pass an assertion about rising time.
 */
function fakeTimers() {
  let now = 1_000_000;
  const entries: FakeEntry[] = [];
  return {
    now: () => now,
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const live = entries.filter((e) => !e.cleared && e.nextAt <= target);
        if (live.length === 0) break;
        const next = live.reduce((a, b) => (b.nextAt < a.nextAt ? b : a));
        now = next.nextAt;
        next.nextAt += next.ms;
        next.fn();
      }
      now = target;
    },
    setIntervalFn(fn: () => void, ms: number) {
      const entry: FakeEntry = {
        fn, ms, cleared: false, nextAt: now + ms, unrefs: 0,
        unref() { this.unrefs++; },
      };
      entries.push(entry);
      return entry;
    },
    clearIntervalFn(handle: unknown) {
      (handle as FakeEntry).cleared = true;
    },
    entries,
  };
}

describe("formatElapsed / formatHeartbeatLine (#1917 ①)", () => {
  test("elapsed renders seconds under a minute and Xm Ys above", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(45_000)).toBe("45s");
    expect(formatElapsed(60_000)).toBe("1m 0s");
    expect(formatElapsed(984_000)).toBe("16m 24s"); // the 16.4-minute turn
  });

  test("the line shape is the one #1917 specified", () => {
    expect(formatHeartbeatLine({ loop: 3, elapsedMs: 135_000, activity: "tool_call read_file" }))
      .toBe("in-flight: loop=3, elapsed=2m 15s, last=tool_call read_file");
  });

  test("a turn with no activity yet says so instead of printing 'undefined'", () => {
    expect(formatHeartbeatLine({ loop: 1, elapsedMs: 45_000 }))
      .toBe("in-flight: loop=1, elapsed=45s, last=no runtime activity yet");
  });

  test("a label identifies which turn is speaking", () => {
    expect(formatHeartbeatLine({ loop: 1, elapsedMs: 1000, activity: "x", label: "task 1a2b3c" }))
      .toBe("in-flight task 1a2b3c: loop=1, elapsed=1s, last=x");
  });
});

describe("resolveHeartbeatIntervalMs (#1917 ①)", () => {
  test("defaults into the band and clamps both ends", () => {
    expect(resolveHeartbeatIntervalMs()).toBe(HEARTBEAT_DEFAULT_MS);
    expect(resolveHeartbeatIntervalMs(Number.NaN)).toBe(HEARTBEAT_DEFAULT_MS);
    expect(resolveHeartbeatIntervalMs(1)).toBe(HEARTBEAT_MIN_MS);
    expect(resolveHeartbeatIntervalMs(999_999)).toBe(HEARTBEAT_MAX_MS);
    expect(resolveHeartbeatIntervalMs(40_000)).toBe(40_000);
  });
});

describe("startTurnHeartbeat (#1917 ①)", () => {
  test("a five-minute silent turn emits at least four lines with rising elapsed", () => {
    const t = fakeTimers();
    const lines: string[] = [];
    const hb = startTurnHeartbeat({
      emit: (l) => lines.push(l),
      intervalMs: 60_000,
      now: t.now,
      setIntervalFn: t.setIntervalFn,
      clearIntervalFn: t.clearIntervalFn,
    });

    t.advance(5 * 60_000);
    hb.stop();

    expect(lines.length).toBeGreaterThanOrEqual(4);
    const elapsed = lines.map((l) => /elapsed=(?:(\d+)m )?(\d+)s/.exec(l)!)
      .map((m) => Number(m[1] ?? 0) * 60 + Number(m[2]));
    for (let i = 1; i < elapsed.length; i++) expect(elapsed[i]).toBeGreaterThan(elapsed[i - 1]);
    const loops = lines.map((l) => Number(/loop=(\d+)/.exec(l)![1]));
    expect(loops).toEqual(loops.map((_, i) => i + 1));
  });

  test("the last observed activity rides along and updates", () => {
    const t = fakeTimers();
    const lines: string[] = [];
    const hb = startTurnHeartbeat({
      emit: (l) => lines.push(l),
      intervalMs: 60_000,
      now: t.now,
      setIntervalFn: t.setIntervalFn,
      clearIntervalFn: t.clearIntervalFn,
    });
    hb.note("reply_chunk");
    t.advance(60_000);
    hb.note("tool_call");
    t.advance(60_000);
    hb.stop();
    expect(lines[0]).toContain("last=reply_chunk");
    expect(lines[1]).toContain("last=tool_call");
  });

  // ── the leak side: a heartbeat that outlives its turn is invisible to CI ──
  test("after stop() nothing is ever emitted again and the timer is cleared", () => {
    const t = fakeTimers();
    const lines: string[] = [];
    const hb = startTurnHeartbeat({
      emit: (l) => lines.push(l),
      intervalMs: 60_000,
      now: t.now,
      setIntervalFn: t.setIntervalFn,
      clearIntervalFn: t.clearIntervalFn,
    });
    t.advance(120_000);
    const before = lines.length;
    expect(before).toBeGreaterThan(0);

    hb.stop();
    t.advance(10 * 60_000); // ten more minutes of wall clock

    expect(lines.length).toBe(before);
    expect(hb.stopped()).toBe(true);
    expect(t.entries.every((e) => e.cleared)).toBe(true);
  });

  test("stop() is idempotent — a finally that runs twice is not an error", () => {
    const t = fakeTimers();
    const hb = startTurnHeartbeat({
      emit: () => {},
      now: t.now,
      setIntervalFn: t.setIntervalFn,
      clearIntervalFn: t.clearIntervalFn,
    });
    hb.stop();
    hb.stop();
    expect(hb.stopped()).toBe(true);
  });

  test("the interval is unref'd so it can never hold the process open", () => {
    const t = fakeTimers();
    startTurnHeartbeat({
      emit: () => {},
      now: t.now,
      setIntervalFn: t.setIntervalFn,
      clearIntervalFn: t.clearIntervalFn,
    });
    expect(t.entries[0].unrefs).toBe(1);
  });

  test("a turn shorter than one interval emits nothing at all", () => {
    const t = fakeTimers();
    const lines: string[] = [];
    const hb = startTurnHeartbeat({
      emit: (l) => lines.push(l),
      intervalMs: 60_000,
      now: t.now,
      setIntervalFn: t.setIntervalFn,
      clearIntervalFn: t.clearIntervalFn,
    });
    t.advance(2_000);
    hb.stop();
    expect(lines).toEqual([]);
  });
});

describe("wiring (#1917 ①) — the grok runtimes actually start and stop it", () => {
  const cli = readFileSync(join(import.meta.dir, "..", "cli.ts"), "utf8").replace(/\r\n?/g, "\n");

  test("cli.ts starts a heartbeat for both grok runtimes", () => {
    expect((cli.match(/startTurnHeartbeat\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  test("every heartbeat is stopped in a finally", () => {
    const starts = (cli.match(/startTurnHeartbeat\(/g) ?? []).length;
    const stops = (cli.match(/heartbeat\.stop\(\)/g) ?? []).length;
    expect(stops).toBeGreaterThanOrEqual(starts);
    expect(cli.includes("finally")).toBe(true);
  });

  test("runtime activity is fed to the heartbeat", () => {
    expect((cli.match(/heartbeat\.note\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

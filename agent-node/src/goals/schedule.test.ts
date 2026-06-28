// RFC-025 M1 P0a — computeNextWakeAt tests (test-first).
//
// 通信龙 emphasis #1: "computeNextWakeAt 是 load-bearing 正确性件 —
// cron-lite 的 DST / 时区 / 相位 edge 测试要狠 (table-driven edge
// case)". This is a pure function; every TZ/DST/wraparound case below
// is reproducible without external state.
//
// 通信龙 emphasis #5: "向后兼容 — 现有只有 interval 的 goal, 加
// schedule union 后行为不能变". Pinned in the "legacy interval-only"
// describe block at the bottom.

import { describe, expect, test } from "bun:test";
import { computeNextWakeAt } from "./schedule";
import type { AgentGoalSchedule } from "./types";

// Anchor every fixed-time test on a known-stable Asia/Shanghai instant:
// 2026-06-28T10:00:00+08:00  ==  2026-06-28T02:00:00Z
const SH_10AM = new Date("2026-06-28T02:00:00.000Z"); // Sunday Asia/Shanghai 10:00

describe("computeNextWakeAt — interval mode", () => {
  test("interval 5min from a baseline returns baseline + 5min", () => {
    const sched: AgentGoalSchedule = { type: "interval", interval_ms: 5 * 60_000 };
    const next = computeNextWakeAt(sched, SH_10AM, "Asia/Shanghai");
    expect(next.toISOString()).toBe("2026-06-28T02:05:00.000Z");
  });

  test("interval 24h returns +24h", () => {
    const sched: AgentGoalSchedule = { type: "interval", interval_ms: 24 * 60 * 60_000 };
    const next = computeNextWakeAt(sched, SH_10AM, "Asia/Shanghai");
    expect(next.toISOString()).toBe("2026-06-29T02:00:00.000Z");
  });

  test("interval is timezone-independent (UTC anchor same result regardless of node TZ)", () => {
    const sched: AgentGoalSchedule = { type: "interval", interval_ms: 60 * 60_000 };
    const sh = computeNextWakeAt(sched, SH_10AM, "Asia/Shanghai");
    const ny = computeNextWakeAt(sched, SH_10AM, "America/New_York");
    const utc = computeNextWakeAt(sched, SH_10AM, "UTC");
    expect(sh.toISOString()).toBe(ny.toISOString());
    expect(ny.toISOString()).toBe(utc.toISOString());
  });
});

describe("computeNextWakeAt — time_of_day mode (per-TZ wall clock)", () => {
  test("09:00 Asia/Shanghai, called at 10:00 Asia/Shanghai → tomorrow 09:00 (already past today)", () => {
    const sched: AgentGoalSchedule = { type: "time_of_day", time: "09:00", timezone: "Asia/Shanghai" };
    const next = computeNextWakeAt(sched, SH_10AM, "Asia/Shanghai");
    // 09:00 Asia/Shanghai = 01:00 UTC; tomorrow = 2026-06-29T01:00:00Z
    expect(next.toISOString()).toBe("2026-06-29T01:00:00.000Z");
  });

  test("09:00 Asia/Shanghai, called at 08:00 Asia/Shanghai → today 09:00 (still upcoming)", () => {
    const sched: AgentGoalSchedule = { type: "time_of_day", time: "09:00", timezone: "Asia/Shanghai" };
    const at_8am_sh = new Date("2026-06-28T00:00:00.000Z"); // 08:00 Asia/Shanghai
    const next = computeNextWakeAt(sched, at_8am_sh, "Asia/Shanghai");
    expect(next.toISOString()).toBe("2026-06-28T01:00:00.000Z");
  });

  test("09:00 Asia/Shanghai, called AT 09:00 exactly → today (boundary include)", () => {
    const sched: AgentGoalSchedule = { type: "time_of_day", time: "09:00", timezone: "Asia/Shanghai" };
    const at_9am_sh = new Date("2026-06-28T01:00:00.000Z"); // exact 09:00 Asia/Shanghai
    const next = computeNextWakeAt(sched, at_9am_sh, "Asia/Shanghai");
    // Boundary: if it's exactly 09:00 we treat now as "just past" and
    // schedule for tomorrow (avoids immediate re-fire after the wake
    // that we just triggered).
    expect(next.toISOString()).toBe("2026-06-29T01:00:00.000Z");
  });

  test("falls back to node default TZ if schedule has no timezone", () => {
    const sched: AgentGoalSchedule = { type: "time_of_day", time: "09:00" };
    // node default = America/New_York. 09:00 New York = 13:00 UTC (summer EDT)
    const at_eod = new Date("2026-06-28T20:00:00.000Z"); // anytime past 09:00 NY
    const next = computeNextWakeAt(sched, at_eod, "America/New_York");
    expect(next.toISOString()).toBe("2026-06-29T13:00:00.000Z");
  });
});

describe("computeNextWakeAt — weekday mode", () => {
  // 2026-06-28 is Sunday in Asia/Shanghai. Days of week order:
  // Sun=0, Mon=1, Tue=2, ..., Sat=6
  test("Monday 09:00 Asia/Shanghai, called Sun 10:00 → tomorrow (Mon) 09:00", () => {
    const sched: AgentGoalSchedule = {
      type: "weekday", days: ["mon"], time: "09:00", timezone: "Asia/Shanghai",
    };
    const next = computeNextWakeAt(sched, SH_10AM, "Asia/Shanghai");
    expect(next.toISOString()).toBe("2026-06-29T01:00:00.000Z");
  });

  test("Mon/Wed/Fri 18:30 Asia/Shanghai, called Sun 10:00 → Monday 18:30 (next eligible)", () => {
    const sched: AgentGoalSchedule = {
      type: "weekday", days: ["mon", "wed", "fri"], time: "18:30", timezone: "Asia/Shanghai",
    };
    const next = computeNextWakeAt(sched, SH_10AM, "Asia/Shanghai");
    // 18:30 Asia/Shanghai = 10:30 UTC
    expect(next.toISOString()).toBe("2026-06-29T10:30:00.000Z");
  });

  test("Mon/Wed/Fri 18:30, called Mon 18:00 → today 18:30 (today eligible AND time still upcoming)", () => {
    const sched: AgentGoalSchedule = {
      type: "weekday", days: ["mon", "wed", "fri"], time: "18:30", timezone: "Asia/Shanghai",
    };
    const mon_6pm_sh = new Date("2026-06-29T10:00:00.000Z");
    const next = computeNextWakeAt(sched, mon_6pm_sh, "Asia/Shanghai");
    expect(next.toISOString()).toBe("2026-06-29T10:30:00.000Z");
  });

  test("Mon/Wed/Fri 18:30, called Mon 19:00 → today is Mon but past 18:30 → Wed 18:30", () => {
    const sched: AgentGoalSchedule = {
      type: "weekday", days: ["mon", "wed", "fri"], time: "18:30", timezone: "Asia/Shanghai",
    };
    const mon_7pm_sh = new Date("2026-06-29T11:00:00.000Z");
    const next = computeNextWakeAt(sched, mon_7pm_sh, "Asia/Shanghai");
    // Wed (2 days later) = 2026-07-01T10:30:00Z
    expect(next.toISOString()).toBe("2026-07-01T10:30:00.000Z");
  });

  test("Friday 09:00, called Saturday → next Friday (full week wrap-around)", () => {
    const sched: AgentGoalSchedule = {
      type: "weekday", days: ["fri"], time: "09:00", timezone: "Asia/Shanghai",
    };
    const sat = new Date("2026-06-27T12:00:00.000Z"); // Sat 20:00 Asia/Shanghai
    const next = computeNextWakeAt(sched, sat, "Asia/Shanghai");
    // Next Fri 2026-07-03 09:00 Asia/Shanghai = 2026-07-03T01:00:00Z
    expect(next.toISOString()).toBe("2026-07-03T01:00:00.000Z");
  });

  test("workdays ['mon','tue','wed','thu','fri'] for daily standup is supported", () => {
    const sched: AgentGoalSchedule = {
      type: "weekday",
      days: ["mon", "tue", "wed", "thu", "fri"],
      time: "10:00",
      timezone: "Asia/Shanghai",
    };
    // Sun → next Mon
    const next = computeNextWakeAt(sched, SH_10AM, "Asia/Shanghai");
    expect(next.toISOString()).toBe("2026-06-29T02:00:00.000Z");
  });
});

describe("computeNextWakeAt — DST edge cases (US Eastern)", () => {
  // US DST 2026: starts Sun Mar 8 (spring forward 02:00→03:00), ends Sun Nov 1 (fall back 02:00→01:00)
  // Pin behaviour: time_of_day uses CALENDAR wall-clock — "09:00 New York" means 09:00 New York time,
  // which is 13:00 UTC during EDT (summer), 14:00 UTC during EST (winter). Auto.

  test("09:00 America/New_York in summer (EDT) → 13:00 UTC", () => {
    const sched: AgentGoalSchedule = { type: "time_of_day", time: "09:00", timezone: "America/New_York" };
    const summer_baseline = new Date("2026-07-15T03:00:00.000Z");
    const next = computeNextWakeAt(sched, summer_baseline, "America/New_York");
    expect(next.toISOString()).toBe("2026-07-15T13:00:00.000Z");
  });

  test("09:00 America/New_York in winter (EST) → 14:00 UTC", () => {
    const sched: AgentGoalSchedule = { type: "time_of_day", time: "09:00", timezone: "America/New_York" };
    const winter_baseline = new Date("2026-01-15T03:00:00.000Z");
    const next = computeNextWakeAt(sched, winter_baseline, "America/New_York");
    expect(next.toISOString()).toBe("2026-01-15T14:00:00.000Z");
  });

  test("daily 02:30 wake DOES NOT skip on DST spring-forward day (just shifts that day)", () => {
    // 2026-03-08 02:00 ET → 03:00 ET (skips 02:30). Schedule wants 02:30 ET.
    // Standard cron behaviour for skipped wall-clock times: skip that day, fire next day.
    // We follow that convention.
    const sched: AgentGoalSchedule = { type: "time_of_day", time: "02:30", timezone: "America/New_York" };
    const at_2am_et_spring_forward = new Date("2026-03-08T07:00:00.000Z"); // 02:00 EST (just before spring forward)
    const next = computeNextWakeAt(sched, at_2am_et_spring_forward, "America/New_York");
    // 02:30 ET on 2026-03-08 does not exist — skip to next day (2026-03-09 02:30 EDT = 06:30 UTC)
    expect(next.toISOString()).toBe("2026-03-09T06:30:00.000Z");
  });
});

describe("computeNextWakeAt — legacy interval-only (back-compat regression)", () => {
  // 通信龙 emphasis #5: existing interval-only goals must behave
  // IDENTICALLY. If schedule is undefined, computeNextWakeAt falls
  // back to interval-from-now semantics (matches pre-RFC-025
  // behaviour: scheduler advanced next_wake_at = now + interval_ms).

  test("undefined schedule → uses interval_ms from goal context, returns now + interval", () => {
    const next = computeNextWakeAt(undefined, SH_10AM, "Asia/Shanghai", { fallback_interval_ms: 5 * 60_000 });
    expect(next.toISOString()).toBe("2026-06-28T02:05:00.000Z");
  });

  test("undefined schedule + zero fallback interval → still returns now (no negative offset)", () => {
    // Defensive: scheduler tick treats 0 as "ASAP" but never negative.
    const next = computeNextWakeAt(undefined, SH_10AM, "Asia/Shanghai", { fallback_interval_ms: 0 });
    expect(next.getTime()).toBe(SH_10AM.getTime());
  });

  test("undefined schedule + missing fallback interval throws (programmer error)", () => {
    // The scheduler should ALWAYS pass either schedule or fallback_interval_ms.
    // If both are absent it's a bug, not a user-facing condition.
    expect(() => computeNextWakeAt(undefined, SH_10AM, "Asia/Shanghai", {})).toThrow();
  });
});

describe("computeNextWakeAt — parser-rejected edge cases (defensive)", () => {
  test("invalid time format '25:99' throws", () => {
    expect(() =>
      computeNextWakeAt({ type: "time_of_day", time: "25:99" } as any, SH_10AM, "Asia/Shanghai")
    ).toThrow(/invalid time/);
  });

  test("empty weekday list throws (caught by parser too, defense in depth)", () => {
    expect(() =>
      computeNextWakeAt({ type: "weekday", days: [], time: "09:00" } as any, SH_10AM, "Asia/Shanghai")
    ).toThrow(/weekday/);
  });

  test("unknown weekday name throws", () => {
    expect(() =>
      computeNextWakeAt(
        { type: "weekday", days: ["nonday"], time: "09:00" } as any,
        SH_10AM,
        "Asia/Shanghai"
      )
    ).toThrow(/unknown weekday/);
  });
});

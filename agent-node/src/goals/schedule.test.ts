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

  test("daily 03:30 exists on spring-forward day (post-jump, unambiguous EDT)", () => {
    // 2026-03-08 spring-forward: 02:00 EST jumps to 03:00 EDT. 03:30 EDT exists that day.
    const sched: AgentGoalSchedule = { type: "time_of_day", time: "03:30", timezone: "America/New_York" };
    const before_jump = new Date("2026-03-07T12:00:00.000Z"); // Sat noon
    const next = computeNextWakeAt(sched, before_jump, "America/New_York");
    // Sun 2026-03-08 03:30 EDT = 07:30 UTC
    expect(next.toISOString()).toBe("2026-03-08T07:30:00.000Z");
  });
});

describe("computeNextWakeAt — DST fall-back (autumn) — RFC-025 P1.3", () => {
  // US DST 2026: fall-back Sun 2026-11-01. At 02:00 EDT (06:00 UTC) the wall
  // clock rolls back to 01:00 EST. The window 01:00-01:59 wall-clock occurs
  // TWICE: first as EDT (05:00-05:59 UTC), then again as EST (06:00-06:59 UTC).
  //
  // Policy (see schedule.ts nextWallClock docs):
  // - Ambiguous times fire at the FIRST occurrence (pre-fallback EDT branch).
  // - The second occurrence is skipped to the next eligible day so daily
  //   goals fire once per day.
  // - Post-fallback unambiguous times (e.g. 02:30 EST) fire on the same day.

  const TZ = "America/New_York";
  const sched01_30: AgentGoalSchedule = { type: "time_of_day", time: "01:30", timezone: TZ };
  const sched02_30: AgentGoalSchedule = { type: "time_of_day", time: "02:30", timezone: TZ };
  const sched03_00: AgentGoalSchedule = { type: "time_of_day", time: "03:00", timezone: TZ };

  test("daily 01:30, called Sat noon → fires at FIRST 01:30 EDT (before fall-back)", () => {
    const saturday_noon = new Date("2026-10-31T12:00:00.000Z");
    const next = computeNextWakeAt(sched01_30, saturday_noon, TZ);
    // First 01:30 EDT (UTC-4) on Sun 2026-11-01 = 05:30 UTC
    expect(next.toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });

  test("daily 01:30, called AT first 01:30 EDT boundary → NEXT DAY (not second 01:30 EST same day)", () => {
    // Just fired at 05:30 UTC. Second 01:30 EST at 06:30 UTC same day would
    // violate "fire once per day". Skip to Mon 2026-11-02.
    const at_first_fire = new Date("2026-11-01T05:30:00.000Z");
    const next = computeNextWakeAt(sched01_30, at_first_fire, TZ);
    // Mon 2026-11-02 01:30 EST = 06:30 UTC
    expect(next.toISOString()).toBe("2026-11-02T06:30:00.000Z");
  });

  test("daily 01:30, called between the two occurrences (05:45 UTC) → next day", () => {
    // At 05:45 UTC on fall-back day: past first 01:30 EDT, before fall-back
    // moment (06:00 UTC). Second 01:30 EST still an hour away but same-day
    // repeat is suppressed.
    const between = new Date("2026-11-01T05:45:00.000Z");
    const next = computeNextWakeAt(sched01_30, between, TZ);
    expect(next.toISOString()).toBe("2026-11-02T06:30:00.000Z");
  });

  test("daily 01:30, called AT fall-back moment (06:00 UTC) → next day (skip 2nd occurrence)", () => {
    // 06:00 UTC = 02:00 EDT → snaps to 01:00 EST. About to be the second
    // 01:30 half an hour from now, but we do not fire it (daily-once).
    const at_fallback = new Date("2026-11-01T06:00:00.000Z");
    const next = computeNextWakeAt(sched01_30, at_fallback, TZ);
    expect(next.toISOString()).toBe("2026-11-02T06:30:00.000Z");
  });

  test("daily 01:30, called AFTER second occurrence (06:30 UTC) → next day", () => {
    const post_second = new Date("2026-11-01T06:30:00.000Z");
    const next = computeNextWakeAt(sched01_30, post_second, TZ);
    expect(next.toISOString()).toBe("2026-11-02T06:30:00.000Z");
  });

  test("daily 02:30 (post-fallback UNAMBIGUOUS) still fires on fall-back day — was buggy before P1.3", () => {
    // 02:30 EST exists exactly once on 2026-11-01 (30 minutes after fall-back).
    // Before the P1.3 makeInstant iteration fix, this was silently skipped to
    // Nov 2 because the offset probe landed in the EDT branch.
    const saturday_noon = new Date("2026-10-31T12:00:00.000Z");
    const next = computeNextWakeAt(sched02_30, saturday_noon, TZ);
    // Sun 2026-11-01 02:30 EST (UTC-5) = 07:30 UTC
    expect(next.toISOString()).toBe("2026-11-01T07:30:00.000Z");
  });

  test("daily 03:00 (fully post-fallback) on fall-back day — regression for iterated offset", () => {
    const saturday_noon = new Date("2026-10-31T12:00:00.000Z");
    const next = computeNextWakeAt(sched03_00, saturday_noon, TZ);
    // Sun 2026-11-01 03:00 EST = 08:00 UTC
    expect(next.toISOString()).toBe("2026-11-01T08:00:00.000Z");
  });

  test("weekday Sun 01:30 on fall-back Sunday → first occurrence EDT", () => {
    const sched: AgentGoalSchedule = { type: "weekday", days: ["sun"], time: "01:30", timezone: TZ };
    const saturday_noon = new Date("2026-10-31T12:00:00.000Z");
    const next = computeNextWakeAt(sched, saturday_noon, TZ);
    expect(next.toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });

  test("weekday Sun 02:30 on fall-back Sunday → same day (was CRASH before P1.3)", () => {
    // Before fix: Nov 1 makeInstant returned null (spring-forward code path
    // reused for fall-back post-transition times), then all other days in
    // the 8-day search window were non-Sun, so nextWallClock threw
    // "no eligible day found". P1.3 fix makes makeInstant iterate the
    // offset probe so Nov 1 02:30 EST resolves correctly.
    const sched: AgentGoalSchedule = { type: "weekday", days: ["sun"], time: "02:30", timezone: TZ };
    const saturday_noon = new Date("2026-10-31T12:00:00.000Z");
    const next = computeNextWakeAt(sched, saturday_noon, TZ);
    expect(next.toISOString()).toBe("2026-11-01T07:30:00.000Z");
  });

  test("weekday Sun 01:30 called AT first fire → NEXT Sunday (not same-day 2nd occurrence)", () => {
    const sched: AgentGoalSchedule = { type: "weekday", days: ["sun"], time: "01:30", timezone: TZ };
    const at_first_fire = new Date("2026-11-01T05:30:00.000Z");
    const next = computeNextWakeAt(sched, at_first_fire, TZ);
    // Next Sun = 2026-11-08. Post-fallback, so 01:30 EST = 06:30 UTC.
    expect(next.toISOString()).toBe("2026-11-08T06:30:00.000Z");
  });

  test("time_of_day 09:00 on fall-back day (outside ambiguous window) unchanged", () => {
    // Guardrail: normal-hour goals must not be perturbed by fall-back logic.
    const sched: AgentGoalSchedule = { type: "time_of_day", time: "09:00", timezone: TZ };
    const saturday_noon = new Date("2026-10-31T12:00:00.000Z");
    const next = computeNextWakeAt(sched, saturday_noon, TZ);
    // Sat 2026-10-31 12:00 UTC = 08:00 EDT (still EDT). Today's 09:00 EDT
    // is 13:00 UTC — 1 hour ahead. Next fire = today.
    expect(next.toISOString()).toBe("2026-10-31T13:00:00.000Z");
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

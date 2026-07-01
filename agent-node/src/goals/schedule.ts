// RFC-025 M1 P0a — cron-lite schedule computation.
//
// `computeNextWakeAt(schedule, now, defaultTz, opts?)` returns the
// next ISO instant the scheduler should fire this goal. Pure: no I/O,
// no global state, no clock reads (caller passes `now` so tests and
// the scheduler tick can both feed the same instant).
//
// **Load-bearing correctness** (通信龙 emphasis #1): every TZ/DST
// edge that user expectations care about is encoded here. Test file
// schedule.test.ts covers DST spring-forward skip, weekday wraparound,
// boundary inclusion, back-compat fallback to interval_ms.
//
// **Back-compat** (通信龙 emphasis #5): when `schedule` is undefined
// the function falls back to "now + opts.fallback_interval_ms" — the
// exact behaviour the pre-RFC-025 scheduler used for interval goals.
// Existing goals in goals.json have no `schedule` field; they keep
// firing on the same cadence with zero observable change.

import type { AgentGoalSchedule } from "./types";

const WEEKDAY_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

export interface ComputeOpts {
  /** Used when `schedule` is undefined (legacy interval-only goals). */
  fallback_interval_ms?: number;
}

/**
 * Pure next-wake calculator. See schedule.test.ts for the full
 * behaviour matrix (DST, TZ, weekday wraparound, boundary).
 */
export function computeNextWakeAt(
  schedule: AgentGoalSchedule | undefined,
  now: Date,
  defaultTz: string,
  opts: ComputeOpts = {},
): Date {
  if (!schedule) {
    if (opts.fallback_interval_ms === undefined) {
      throw new Error(
        "computeNextWakeAt: schedule is undefined AND opts.fallback_interval_ms is missing — " +
        "scheduler tick must always supply one or the other (programmer error)"
      );
    }
    return new Date(now.getTime() + Math.max(0, opts.fallback_interval_ms));
  }

  if (schedule.type === "interval") {
    return new Date(now.getTime() + Math.max(0, schedule.interval_ms));
  }

  if (schedule.type === "time_of_day") {
    const tz = schedule.timezone || defaultTz;
    const { hour, minute } = parseTime(schedule.time);
    return nextWallClock(now, tz, [0, 1, 2, 3, 4, 5, 6], hour, minute);
  }

  if (schedule.type === "weekday") {
    if (!Array.isArray(schedule.days) || schedule.days.length === 0) {
      throw new Error("computeNextWakeAt: weekday schedule has empty days[]");
    }
    const dayNums = schedule.days.map((d) => {
      const n = WEEKDAY_NAMES[d.toLowerCase()];
      if (n === undefined) throw new Error(`computeNextWakeAt: unknown weekday "${d}"`);
      return n;
    });
    const tz = schedule.timezone || defaultTz;
    const { hour, minute } = parseTime(schedule.time);
    return nextWallClock(now, tz, dayNums, hour, minute);
  }

  throw new Error(`computeNextWakeAt: unknown schedule type ${(schedule as any).type}`);
}

function parseTime(s: string): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) throw new Error(`computeNextWakeAt: invalid time format "${s}" (expected HH:MM)`);
  const hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`computeNextWakeAt: invalid time "${s}" (hour 0-23, minute 0-59)`);
  }
  return { hour, minute };
}

/**
 * Find the next instant >= `now` whose wall-clock in `tz` matches
 * (hour, minute) AND whose weekday (in tz) is in `allowedDays`.
 *
 * Boundary policy: if `now`'s wall-clock is EXACTLY (hour, minute) on
 * an allowed day, treat as "just fired" and skip to the next eligible
 * day. Avoids immediate re-fire after the wake we just triggered.
 *
 * DST spring-forward (spring): if the target wall-clock time doesn't
 * exist on a given day (the clock jumps 02:00 → 03:00, skipping 02:30
 * entirely), we advance to the next day's target. Matches standard
 * cron behaviour.
 *
 * DST fall-back (autumn): the ambiguous window (US: 01:00-01:59 EDT
 * repeated as 01:00-01:59 EST) resolves to the FIRST occurrence — the
 * pre-fallback EDT branch. The second occurrence (post-fallback EST)
 * is treated as "just fired today" and skipped to the next eligible
 * day, giving one-fire-per-day semantics.
 *
 * The reason for picking the first occurrence: interval regularity.
 * If a daily 01:30 goal fires N times per year, on fall-back day it
 * fires once (the first 01:30). Otherwise it would either fire twice
 * (breaking daily-once semantics) or fire at 01:30 EST which would
 * shift the perceived clock time from the user's set 01:30 to a
 * 1-hour-later instant relative to the day before.
 */
function nextWallClock(
  now: Date,
  tz: string,
  allowedDays: number[],
  hour: number,
  minute: number,
): Date {
  // Search up to 8 days ahead. Weekly schedules wrap within 7; the
  // 8th iteration is the safety net (handles DST-skipped target on
  // the last eligible day).
  for (let i = 0; i < 8; i++) {
    const probe = addDays(now, i);
    const parts = wallClockParts(probe, tz);
    if (!allowedDays.includes(parts.weekday)) continue;
    const target = makeInstant(parts.year, parts.month, parts.day, hour, minute, tz);
    if (target === null) continue;  // spring-forward skip; try next day
    if (target.getTime() > now.getTime()) return target;
    // Boundary: target <= now and same minute → "just fired", skip.
  }
  throw new Error(
    `computeNextWakeAt: no eligible day found within 8 days (schedule may be unreachable; ` +
    `check days=[${allowedDays.join(",")}] hour=${hour} minute=${minute} tz=${tz})`
  );
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 24 * 60 * 60_000);
}

/** Extract wall-clock components in target TZ via Intl.DateTimeFormat. */
function wallClockParts(d: Date, tz: string): {
  year: number; month: number; day: number; weekday: number;
} {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  });
  const parts = fmt.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  const weekdayName = get("weekday").toLowerCase();
  const weekday = WEEKDAY_NAMES[weekdayName] ?? -1;
  return {
    year: parseInt(get("year"), 10),
    month: parseInt(get("month"), 10),
    day: parseInt(get("day"), 10),
    weekday,
  };
}

/**
 * Build the UTC instant corresponding to (year, month, day, hour,
 * minute) in `tz`. Returns null if that local time doesn't exist
 * (DST spring-forward gap).
 *
 * Approach: probe the tz offset at a naive UTC anchor, shift once,
 * and verify. If the first shift lands in a different DST branch than
 * the target (fall-back day, post-fallback local times), the second
 * probe corrects it. Two iterations suffice for standard 1-hour DST
 * transitions; a third check that still fails signals a genuine
 * spring-forward gap and returns null.
 *
 * Fall-back ambiguous window: when the requested wall-clock occurs
 * twice (e.g. 01:30 US Eastern on fall-back day), the first shift
 * from the naive UTC probe lands in the pre-transition branch (EDT).
 * That branch verifies immediately and is returned, giving the FIRST
 * occurrence. Skipping the second occurrence to the next eligible day
 * is nextWallClock's job (boundary "target <= now" check).
 */
function makeInstant(
  year: number, month: number, day: number,
  hour: number, minute: number, tz: string,
): Date | null {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
  const verifyMatch = (utcMs: number): boolean => {
    const vp = fmt.formatToParts(new Date(utcMs));
    const v = (t: string) => parseInt(vp.find((x) => x.type === t)?.value || "0", 10);
    if (v("year") !== year || v("month") !== month || v("day") !== day) return false;
    if (v("hour") % 24 !== hour || v("minute") !== minute) return false;
    return true;
  };
  // "shift needed" = (requested wall-clock as if UTC) minus (tz
  // wall-clock at anchor, as if UTC). Adding this shift to the anchor
  // moves us toward the correct UTC instant.
  const requestedAsIfUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const shiftNeeded = (utcMs: number): number => {
    const p = fmt.formatToParts(new Date(utcMs));
    const g = (t: string) => parseInt(p.find((x) => x.type === t)?.value || "0", 10);
    const tzY = g("year"), tzM = g("month"), tzD = g("day");
    const tzH = g("hour") % 24, tzMin = g("minute");
    const tzAsIfUtc = Date.UTC(tzY, tzM - 1, tzD, tzH, tzMin, 0);
    return requestedAsIfUtc - tzAsIfUtc;
  };

  const naive = requestedAsIfUtc;
  // Iteration 1: probe offset at naive UTC, shift once.
  const candidate1 = naive + shiftNeeded(naive);
  if (verifyMatch(candidate1)) return new Date(candidate1);
  // Iteration 2: on DST transition days the first shift lands in the
  // wrong branch (offset differs at candidate1 vs at naive). Re-probe.
  const candidate2 = candidate1 + shiftNeeded(candidate1);
  if (verifyMatch(candidate2)) return new Date(candidate2);
  // Still mismatched after 2 iterations = spring-forward gap.
  return null;
}

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
 * DST: if the target wall-clock time doesn't exist on a given day
 * (spring-forward skip), we advance to the next day's target. This
 * matches standard cron behaviour.
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
 * Approach: try an approximate UTC anchor, check if its wall-clock in
 * tz round-trips to the expected (h, m, d). If not (DST skip), bail.
 */
function makeInstant(
  year: number, month: number, day: number,
  hour: number, minute: number, tz: string,
): Date | null {
  // Start with a naive UTC instant for the requested wall-clock.
  // Then adjust by the offset between UTC and tz at that instant.
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  // Look up TZ offset at `naive` by formatting and parsing back.
  const probe = new Date(naive);
  const probeParts = wallClockParts(probe, tz);
  // The naive UTC instant's wall-clock IN tz tells us tz offset
  // implicitly. Compute the diff between requested h:m and what tz
  // shows for this UTC instant, then shift the UTC instant.
  const probeAsTzMinutes = probeParts.day * 24 * 60 + 0; // we don't have h/m yet
  // Need hour/minute of `probe` in `tz`. Fetch them.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false, hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit", year: "numeric",
  });
  const p = fmt.formatToParts(probe);
  const getN = (t: string) => parseInt(p.find((x) => x.type === t)?.value || "0", 10);
  const tzHour = getN("hour") % 24;  // Intl can return "24" for midnight in some locales
  const tzMinute = getN("minute");
  const tzDay = getN("day");
  const tzMonth = getN("month");
  const tzYear = getN("year");

  // Compute the offset: requested wall-clock minus tz wall-clock at
  // the naive instant. If offset is N minutes, the real UTC instant
  // is naive - (tz - requested) minutes... but watch out for date
  // wrap. Simpler: compute the difference between the requested
  // wall-clock-as-UTC and probe-tz-as-UTC.
  const requestedAsIfUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const probeTzAsIfUtc = Date.UTC(tzYear, tzMonth - 1, tzDay, tzHour, tzMinute, 0);
  const offsetMs = requestedAsIfUtc - probeTzAsIfUtc;
  // The real UTC instant corresponding to (year, month, day, hour, minute) in tz
  // is the naive UTC instant adjusted by offsetMs.
  const candidate = new Date(naive + offsetMs);

  // Validate round-trip: if the candidate's wall-clock in tz doesn't
  // match the request, the requested time doesn't exist in tz
  // (DST spring-forward gap). Return null in that case.
  const verifyFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false, hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit", year: "numeric",
  });
  const vp = verifyFmt.formatToParts(candidate);
  const v = (t: string) => parseInt(vp.find((x) => x.type === t)?.value || "0", 10);
  if (v("year") !== year || v("month") !== month || v("day") !== day) return null;
  if (v("hour") % 24 !== hour || v("minute") !== minute) return null;
  return candidate;
  // Note: void unused intermediate.
  void probeAsTzMinutes;
}

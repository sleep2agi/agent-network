// Phase 1 of #184 — parser unit tests.
//
// Cover: English/Chinese intervals, mixed text, slash-prefix optional,
// rejection on no-interval / sub-minute / empty.

import { expect, test, describe } from "bun:test";
import { parseGoalCommand, MIN_INTERVAL_MS } from "./parser";

describe("parseGoalCommand — English intervals", () => {
  test("`5 min` form", () => {
    const r = parseGoalCommand("/goal check progress 5 min");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.goal.interval_ms).toBe(5 * 60_000);
      expect(r.goal.text).toBe("check progress");
    }
  });

  test("`5min` joined form", () => {
    const r = parseGoalCommand("/goal report 5min");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.goal.interval_ms).toBe(5 * 60_000);
  });

  test("`5 minutes` long form (plural wins over `min`)", () => {
    const r = parseGoalCommand("/goal report every 5 minutes");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.goal.interval_ms).toBe(5 * 60_000);
  });

  test("`1 hour`", () => {
    const r = parseGoalCommand("/goal check team status 1 hour");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.goal.interval_ms).toBe(60 * 60_000);
  });

  test("`hourly` keyword", () => {
    const r = parseGoalCommand("/goal hourly check team status");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.goal.interval_ms).toBe(60 * 60_000);
      expect(r.goal.text).toBe("check team status");
    }
  });

  test("`daily`", () => {
    const r = parseGoalCommand("/goal daily project summary");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.goal.interval_ms).toBe(24 * 60 * 60_000);
  });

  test("`1 day`", () => {
    const r = parseGoalCommand("/goal 1 day status reflection");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.goal.interval_ms).toBe(24 * 60 * 60_000);
  });

  test("`/goal` prefix is optional", () => {
    const r = parseGoalCommand("hourly report progress");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.goal.interval_ms).toBe(60 * 60_000);
  });

  test("`/loop` alias", () => {
    const r = parseGoalCommand("/loop report progress 5min");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.goal.interval_ms).toBe(5 * 60_000);
      expect(r.goal.text).toBe("report progress");
    }
  });

  test("`/aloop` strips the namespaced canonical prefix", () => {
    const r = parseGoalCommand("/aloop 5m report progress");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.goal.interval_ms).toBe(5 * 60_000);
      expect(r.goal.text).toBe("report progress");
    }
  });

  test("`/agoal` strips the namespaced compatibility prefix", () => {
    const r = parseGoalCommand("/agoal hourly report progress");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.goal.interval_ms).toBe(60 * 60_000);
      expect(r.goal.text).toBe("report progress");
    }
  });
});

describe("parseGoalCommand — Chinese intervals", () => {
  test("`每5分钟`", () => {
    const r = parseGoalCommand("/goal 每5分钟汇报团队进度");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.goal.interval_ms).toBe(5 * 60_000);
      expect(r.goal.text).toBe("汇报团队进度");
    }
  });

  test("`每 5 分钟` with spaces", () => {
    const r = parseGoalCommand("/goal 每 5 分钟 报告");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.goal.interval_ms).toBe(5 * 60_000);
  });

  test("`5分钟` bare (no 每)", () => {
    const r = parseGoalCommand("/goal 5分钟检查任务");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.goal.interval_ms).toBe(5 * 60_000);
  });

  test("`每小时`", () => {
    const r = parseGoalCommand("/goal 每小时同步一次");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.goal.interval_ms).toBe(60 * 60_000);
  });

  test("`每天`", () => {
    const r = parseGoalCommand("/goal 每天日报");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.goal.interval_ms).toBe(24 * 60 * 60_000);
  });

  test("`每2小时`", () => {
    const r = parseGoalCommand("/goal 每2小时复盘");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.goal.interval_ms).toBe(2 * 60 * 60_000);
  });
});

describe("parseGoalCommand — rejection paths", () => {
  test("no interval — reject", () => {
    const r = parseGoalCommand("/goal just check progress");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no recognised interval/);
  });

  test("empty input — reject", () => {
    const r = parseGoalCommand("/goal   ");
    expect(r.ok).toBe(false);
  });

  test("seconds rejected with informative error", () => {
    const r = parseGoalCommand("/goal report 30 seconds");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/wake-storm|shorter than/);
  });

  test("Chinese 秒 rejected", () => {
    const r = parseGoalCommand("/goal 每30秒汇报");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/wake-storm|shorter than/);
  });

  test("text becomes empty after stripping interval — reject", () => {
    const r = parseGoalCommand("/goal 5min");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/empty/);
  });

  test("`/goal hourly` alone — reject (no text)", () => {
    const r = parseGoalCommand("/goal hourly");
    expect(r.ok).toBe(false);
  });

  test("MIN_INTERVAL_MS is 60s", () => {
    expect(MIN_INTERVAL_MS).toBe(60_000);
  });
});

describe("parseGoalCommand — defence-in-depth", () => {
  // The parser only accepts ≥minute units, so the post-parse min-interval
  // check exists as belt-and-braces. If someone introduces a future bug
  // pattern that yields a sub-minute value, the post-check should still
  // catch it. Smoke-test by directly verifying the constant exists and
  // accepted-input boundary.
  test("`1 min` exact minimum is accepted", () => {
    const r = parseGoalCommand("/goal 1min ping");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.goal.interval_ms).toBe(60_000);
  });
});

describe("parseGoalCommand — #144 round-6 single-letter units (CLI parity)", () => {
  // `anet node loop <alias> "<task>" --every 5m` emits a slash command
  // shaped exactly like the strings below. Pre-fix the parser ONLY
  // matched word-form ("min/minute/hour/day"), so `5m` / `2h` / `1d`
  // all fell through to "no recognised interval" and the CLI silently
  // succeeded at /api/task enqueue while the goal never landed. These
  // tests pin parity with the CLI's `--every` format.

  test("`5m` parses to 5 × 60_000 ms (the canonical CLI emission)", () => {
    const r = parseGoalCommand("/loop 5m monitor PR #271");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.goal.interval_ms).toBe(5 * 60_000);
      expect(r.goal.text).toBe("monitor PR #271");
    }
  });

  test("`30m` / `90m` arbitrary minutes parse correctly", () => {
    const a = parseGoalCommand("/loop 30m scan twitter");
    const b = parseGoalCommand("/loop 90m long task");
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok) expect(a.goal.interval_ms).toBe(30 * 60_000);
    if (b.ok) expect(b.goal.interval_ms).toBe(90 * 60_000);
  });

  test("`2h` parses to 2 hours", () => {
    const r = parseGoalCommand("/loop 2h morning sync");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.goal.interval_ms).toBe(2 * 60 * 60_000);
  });

  test("`1d` parses to 24 hours", () => {
    const r = parseGoalCommand("/loop 1d nightly cleanup");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.goal.interval_ms).toBe(24 * 60 * 60_000);
  });

  test("single-letter and word-form yield the same interval (no semantic drift)", () => {
    const single = parseGoalCommand("/loop 5m do thing");
    const word = parseGoalCommand("/loop 5min do thing");
    expect(single.ok).toBe(true);
    expect(word.ok).toBe(true);
    if (single.ok && word.ok) {
      expect(single.goal.interval_ms).toBe(word.goal.interval_ms);
      expect(single.goal.text).toBe(word.goal.text);
    }
  });

  test("`5min` still wins over `5m` (longest-prefix declaration order)", () => {
    // Pre-fix `5min` was the only thing that worked; ensure we don't
    // regress that by accidentally matching `5m` first and treating
    // `in` as leftover goal text.
    const r = parseGoalCommand("/loop 5min check the deploy");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.goal.interval_ms).toBe(5 * 60_000);
      expect(r.goal.text).toBe("check the deploy"); // NOT "in check the deploy"
    }
  });

  test("single-letter inside a larger word is NOT swallowed (lookahead guard)", () => {
    // `5min` should match the word-form rule, not the single-letter
    // rule with `in` as leftover. Pinned above. Conversely, a stray
    // `2m2` in the text should not be picked up — there's no clean
    // single-letter form here, so it must NOT parse.
    const r = parseGoalCommand("/loop check status 5MOM"); // looks suggestive
    expect(r.ok).toBe(false); // no valid interval
  });

  test("`30s` is rejected with sub-minute error (parser + CLI aligned)", () => {
    const r = parseGoalCommand("/loop 30s ping");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/shorter than 60s|seconds/i);
  });
});

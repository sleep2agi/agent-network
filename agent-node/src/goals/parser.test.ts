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

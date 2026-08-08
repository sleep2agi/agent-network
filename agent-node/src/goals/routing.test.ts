import { describe, expect, test } from "bun:test";
import {
  appendDashboardNativeScheduleNotice,
  appendLegacyScheduledGoalNotice,
  DASHBOARD_NATIVE_SCHEDULE_NOTICE,
  LEGACY_ANET_SCHEDULE_NOTICE,
  prepareDashboardNativeSlashReply,
  shouldCreateScheduledGoal,
} from "./routing";

const RUNTIMES = ["codex-app-server", "codex", "claude", "grok", "opencode"] as const;

describe("shouldCreateScheduledGoal — Dashboard native slash pass-through", () => {
  test("authenticated Dashboard /goal and /loop pass through for every agent-node runtime", () => {
    for (const runtime of RUNTIMES) {
      expect(shouldCreateScheduledGoal("/goal 5m update docs", runtime, true)).toBe(false);
      expect(shouldCreateScheduledGoal("/loop 5m update docs", runtime, true)).toBe(false);
    }
  });

  test("authenticated Dashboard /agoal and /aloop always select the ANet scheduler", () => {
    for (const runtime of RUNTIMES) {
      expect(shouldCreateScheduledGoal("/agoal 5m update docs", runtime, true)).toBe(true);
      expect(shouldCreateScheduledGoal("/aloop 5m update docs", runtime, true)).toBe(true);
    }
  });

  test("non-Dashboard traffic retains /goal and /loop during the compatibility window", () => {
    for (const runtime of RUNTIMES) {
      expect(shouldCreateScheduledGoal("/goal 1h update docs", runtime, false)).toBe(true);
      expect(shouldCreateScheduledGoal("/loop 1h update docs", runtime, false)).toBe(true);
      expect(shouldCreateScheduledGoal("/agoal 1h update docs", runtime, false)).toBe(true);
      expect(shouldCreateScheduledGoal("/aloop 1h update docs", runtime, false)).toBe(true);
    }
  });

  test("near matches and slash text away from the start never select the scheduler", () => {
    for (const runtime of RUNTIMES) {
      expect(shouldCreateScheduledGoal("/goalkeeper status", runtime, true)).toBe(false);
      expect(shouldCreateScheduledGoal("/alooper status", runtime, false)).toBe(false);
      expect(shouldCreateScheduledGoal("please /aloop later", runtime, false)).toBe(false);
      expect(shouldCreateScheduledGoal("更新一下文档", runtime, true)).toBe(false);
    }
  });
});

describe("appendLegacyScheduledGoalNotice", () => {
  test("non-Dashboard /goal and /loop replies carry a deterministic migration notice", () => {
    expect(appendLegacyScheduledGoalNotice("created", "/goal 5m work", false))
      .toBe(`${LEGACY_ANET_SCHEDULE_NOTICE}\n\ncreated`);
    expect(appendLegacyScheduledGoalNotice("failed", "/loop 5m work", false))
      .toBe(`${LEGACY_ANET_SCHEDULE_NOTICE}\n\nfailed`);
  });

  test("new namespaced commands, Dashboard pass-through, and near matches are not warned", () => {
    expect(appendLegacyScheduledGoalNotice("created", "/aloop 5m work", false)).toBe("created");
    expect(appendLegacyScheduledGoalNotice("created", "/agoal 5m work", false)).toBe("created");
    expect(appendLegacyScheduledGoalNotice("native", "/loop 5m work", true)).toBe("native");
    expect(appendLegacyScheduledGoalNotice("native", "/goal 5m work", true)).toBe("native");
    expect(appendLegacyScheduledGoalNotice("plain", "/looper 5m work", false)).toBe("plain");
  });

  test("the migration notice is first so the outer reply cap cannot truncate it", () => {
    const reply = appendLegacyScheduledGoalNotice("x".repeat(2_500), "/goal 5m work", false);
    expect(reply.slice(0, 2_000)).toContain(LEGACY_ANET_SCHEDULE_NOTICE);
  });
});

describe("Dashboard native slash migration notice", () => {
  test("interval-shaped /goal and /loop replies explain that ANet scheduling moved to /aloop", () => {
    for (const command of ["/goal 5m work", "/loop 每小时 work"]) {
      expect(appendDashboardNativeScheduleNotice("native reply", command, true))
        .toBe(`${DASHBOARD_NATIVE_SCHEDULE_NOTICE}\n\nnative reply`);
    }
  });

  test("ordinary native commands, namespaced commands, and non-Dashboard paths are untouched", () => {
    expect(appendDashboardNativeScheduleNotice("native", "/goal work", true)).toBe("native");
    expect(appendDashboardNativeScheduleNotice("native", "/loop work", true)).toBe("native");
    expect(appendDashboardNativeScheduleNotice("scheduled", "/aloop 5m work", true)).toBe("scheduled");
    expect(appendDashboardNativeScheduleNotice("legacy", "/loop 5m work", false)).toBe("legacy");
  });

  test("the notice survives low-value filtering and the outer reply cap", () => {
    const prepared = prepareDashboardNativeSlashReply(
      "收到",
      "/loop 5m work",
      true,
      false,
      (text) => text === "收到",
    );
    expect(prepared.shouldDeliver).toBe(true);
    expect(prepared.text).toContain(DASHBOARD_NATIVE_SCHEDULE_NOTICE);
    expect(appendDashboardNativeScheduleNotice("x".repeat(2_500), "/goal 5m work", true)
      .slice(0, 2_000)).toContain(DASHBOARD_NATIVE_SCHEDULE_NOTICE);
  });

  test("failed native replies still surface the migration notice and the failure", () => {
    const prepared = prepareDashboardNativeSlashReply(
      "native failed",
      "/loop 5m work",
      true,
      true,
      () => false,
    );
    expect(prepared.shouldDeliver).toBe(true);
    expect(prepared.text).toBe(`${DASHBOARD_NATIVE_SCHEDULE_NOTICE}\n\nnative failed`);
  });
});

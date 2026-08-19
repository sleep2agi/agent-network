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
      { messageType: "task", interactiveDashboardTask: true },
      false,
      (text) => text === "收到",
    );
    expect(prepared.shouldDeliver).toBe(true);
    expect(prepared.text).toContain(DASHBOARD_NATIVE_SCHEDULE_NOTICE);
    expect(appendDashboardNativeScheduleNotice("x".repeat(2_500), "/goal 5m work", true)
      .slice(0, 2_000)).toContain(DASHBOARD_NATIVE_SCHEDULE_NOTICE);
  });

  // 🔴 上一条用 messageType:"task"，于是 `humanDashboardRequest` 为真，
  //    `failed || humanDashboardRequest || !isLowValueReply(text)` 在第二项就短路 ——
  //    `isLowValueReply` 根本没被求值。所以尽管那条测试名叫
  //    "the notice survives low-value filtering"，它**测不到低价值过滤**。
  //    要让第三项真的被求值，必须同时满足：有通知(interactiveDashboardTask=true)
  //    且不是 human 直连(messageType 不是 task/broadcast)。
  //    2026-08-19 实测：把 `isLowValueReply(text)` 改成 `isLowValueReply(replyText)`
  //    后整个套件仍然全绿，就是缺了这一格。
  test("low-value filtering judges the notice-prefixed text, not the raw model reply", () => {
    const prepared = prepareDashboardNativeSlashReply(
      "收到",
      "/loop 5m work",
      { messageType: "message", interactiveDashboardTask: true },
      false,
      (text) => text === "收到",
    );

    expect(prepared.text).toBe(`${DASHBOARD_NATIVE_SCHEDULE_NOTICE}\n\n收到`);
    // 判据在这一行：拿【原始回复】判低价值会把该发的迁移通知一起吞掉。
    expect(prepared.shouldDeliver).toBe(true);
  });

  test("failed native replies still surface the migration notice and the failure", () => {
    const prepared = prepareDashboardNativeSlashReply(
      "native failed",
      "/loop 5m work",
      { messageType: "task", interactiveDashboardTask: true },
      true,
      () => false,
    );
    expect(prepared.shouldDeliver).toBe(true);
    expect(prepared.text).toBe(`${DASHBOARD_NATIVE_SCHEDULE_NOTICE}\n\nnative failed`);
  });
});

describe("reply filtering uses authenticated message provenance", () => {
  test("a short presence reply to an authenticated Dashboard human task is delivered", () => {
    for (const messageType of ["task", "broadcast"]) {
      const prepared = prepareDashboardNativeSlashReply(
        "在线。",
        "在线吗?",
        { messageType, interactiveDashboardTask: true },
        false,
        () => true,
      );

      expect(prepared).toEqual({ text: "在线。", shouldDeliver: true });
    }
  });

  test("the same low-value class remains filtered for agent-to-agent tasks", () => {
    const prepared = prepareDashboardNativeSlashReply(
      "收到",
      "同步状态",
      { messageType: "task", interactiveDashboardTask: false },
      false,
      () => true,
    );

    expect(prepared).toEqual({ text: "收到", shouldDeliver: false });
  });

  test("a provenance flag cannot bypass filtering for a non-task message type", () => {
    const prepared = prepareDashboardNativeSlashReply(
      "收到",
      "同步状态",
      { messageType: "message", interactiveDashboardTask: true },
      false,
      () => true,
    );

    expect(prepared).toEqual({ text: "收到", shouldDeliver: false });
  });
});

import { describe, expect, test } from "bun:test";
import {
  appendDashboardNativeScheduleNotice,
  appendLegacyScheduledGoalNotice,
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

  test("non-Dashboard /goal and /loop also pass through unchanged", () => {
    for (const runtime of RUNTIMES) {
      expect(shouldCreateScheduledGoal("/goal 1h update docs", runtime, false)).toBe(false);
      expect(shouldCreateScheduledGoal("/loop 1h update docs", runtime, false)).toBe(false);
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

describe("native slash replies stay unchanged", () => {
  test("non-Dashboard /goal and /loop replies are not rewritten", () => {
    expect(appendLegacyScheduledGoalNotice("native", "/goal 5m work", false)).toBe("native");
    expect(appendLegacyScheduledGoalNotice("native", "/loop 5m work", false)).toBe("native");
  });

  test("new namespaced commands, Dashboard pass-through, and near matches are not warned", () => {
    expect(appendLegacyScheduledGoalNotice("created", "/aloop 5m work", false)).toBe("created");
    expect(appendLegacyScheduledGoalNotice("created", "/agoal 5m work", false)).toBe("created");
    expect(appendLegacyScheduledGoalNotice("native", "/loop 5m work", true)).toBe("native");
    expect(appendLegacyScheduledGoalNotice("native", "/goal 5m work", true)).toBe("native");
    expect(appendLegacyScheduledGoalNotice("plain", "/looper 5m work", false)).toBe("plain");
  });

  test("long native replies are preserved exactly", () => {
    const reply = appendLegacyScheduledGoalNotice("x".repeat(2_500), "/goal 5m work", false);
    expect(reply).toBe("x".repeat(2_500));
  });
});

describe("Dashboard native slash pass-through", () => {
  test("interval-shaped /goal and /loop replies are unchanged", () => {
    for (const command of ["/goal 5m work", "/loop 每小时 work"]) {
      expect(appendDashboardNativeScheduleNotice("native reply", command, true))
        .toBe("native reply");
    }
  });

  test("ordinary native commands, namespaced commands, and non-Dashboard paths are untouched", () => {
    expect(appendDashboardNativeScheduleNotice("native", "/goal work", true)).toBe("native");
    expect(appendDashboardNativeScheduleNotice("native", "/loop work", true)).toBe("native");
    expect(appendDashboardNativeScheduleNotice("scheduled", "/aloop 5m work", true)).toBe("scheduled");
    expect(appendDashboardNativeScheduleNotice("legacy", "/loop 5m work", false)).toBe("legacy");
  });

  test("ordinary reply filtering remains unchanged", () => {
    const prepared = prepareDashboardNativeSlashReply(
      "收到",
      "/loop 5m work",
      { messageType: "task", interactiveDashboardTask: true },
      false,
      (text) => text === "收到",
    );
    expect(prepared.shouldDeliver).toBe(true);
    expect(prepared.text).toBe("收到");
    expect(appendDashboardNativeScheduleNotice("x".repeat(2_500), "/goal 5m work", true)
    ).toBe("x".repeat(2_500));
  });

  test("non-task low-value replies remain filtered without rewriting", () => {
    const prepared = prepareDashboardNativeSlashReply(
      "收到",
      "/loop 5m work",
      { messageType: "message", interactiveDashboardTask: true },
      false,
      (text) => text === "收到",
    );

    expect(prepared.text).toBe("收到");
    expect(prepared.shouldDeliver).toBe(false);
  });

  test("failed native replies surface without rewriting", () => {
    const prepared = prepareDashboardNativeSlashReply(
      "native failed",
      "/loop 5m work",
      { messageType: "task", interactiveDashboardTask: true },
      true,
      () => false,
    );
    expect(prepared.shouldDeliver).toBe(true);
    expect(prepared.text).toBe("native failed");
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

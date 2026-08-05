import { describe, expect, test } from "bun:test";
import {
  appendDashboardCodexGoalNotice,
  DASHBOARD_CODEX_GOAL_INTERVAL_NOTICE,
  prepareDashboardCodexGoalReply,
  shouldCreateScheduledGoal,
} from "./routing";

describe("shouldCreateScheduledGoal", () => {
  test("passes authenticated Dashboard /goal through to the shared Codex TUI", () => {
    expect(shouldCreateScheduledGoal(
      "/goal 更新一下 https://anet.sh 把乱七八糟的文档都删了",
      "codex-app-server",
      true,
    )).toBe(false);
  });

  test("keeps /loop on the recurring scheduler for Dashboard Codex TUI tasks", () => {
    expect(shouldCreateScheduledGoal("/loop 每小时更新文档", "codex-app-server", true)).toBe(true);
  });

  test("preserves the legacy /goal scheduler alias outside authenticated Dashboard Codex TUI", () => {
    expect(shouldCreateScheduledGoal("/goal 1h update docs", "codex-app-server", false)).toBe(true);
    expect(shouldCreateScheduledGoal("/goal 1h update docs", "codex", true)).toBe(true);
    expect(shouldCreateScheduledGoal("/goal 1h update docs", "claude", true)).toBe(true);
    expect(shouldCreateScheduledGoal("/goal 1h update docs", "grok", true)).toBe(true);
    expect(shouldCreateScheduledGoal("/goal 1h update docs", "opencode", true)).toBe(true);
  });

  test("does not treat near matches or ordinary chat as scheduler commands", () => {
    expect(shouldCreateScheduledGoal("/goalkeeper status", "codex-app-server", true)).toBe(false);
    expect(shouldCreateScheduledGoal("please /loop later", "codex-app-server", true)).toBe(false);
    expect(shouldCreateScheduledGoal("更新一下文档", "codex-app-server", true)).toBe(false);
  });

  test("warns when Dashboard /goal text contains a scheduler interval", () => {
    const reply = appendDashboardCodexGoalNotice(
      "目标已创建",
      "/goal 5m 检查日志",
      "codex-app-server",
      true,
      false,
    );
    expect(reply).toBe(`${DASHBOARD_CODEX_GOAL_INTERVAL_NOTICE}\n\n目标已创建`);
    expect(appendDashboardCodexGoalNotice(
      "x".repeat(2_500), "/goal 5m 检查日志", "codex-app-server", true, false,
    ).slice(0, 2_000)).toContain(DASHBOARD_CODEX_GOAL_INTERVAL_NOTICE);
  });

  test("does not add a misleading notice to ordinary goals, failures, or legacy paths", () => {
    expect(appendDashboardCodexGoalNotice(
      "目标已创建", "/goal 更新文档", "codex-app-server", true, false,
    )).toBe("目标已创建");
    expect(appendDashboardCodexGoalNotice(
      "创建失败", "/goal 5m 检查日志", "codex-app-server", true, true,
    )).toBe("创建失败");
    expect(appendDashboardCodexGoalNotice(
      "legacy", "/goal 5m 检查日志", "codex-app-server", false, false,
    )).toBe("legacy");
    expect(appendDashboardCodexGoalNotice(
      "loop", "/loop 5m 检查日志", "codex-app-server", true, false,
    )).toBe("loop");
  });

  test("delivers the interval notice even when the model reply alone is low-value", () => {
    const prepared = prepareDashboardCodexGoalReply(
      "收到",
      "/goal 5m 检查日志",
      "codex-app-server",
      true,
      false,
      (text) => text === "收到",
    );
    expect(prepared.shouldDeliver).toBe(true);
    expect(prepared.text).toContain(DASHBOARD_CODEX_GOAL_INTERVAL_NOTICE);
  });
});

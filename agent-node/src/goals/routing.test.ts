import { describe, expect, test } from "bun:test";
import {
  appendLegacyScheduledGoalNotice,
  LEGACY_ANET_SCHEDULE_NOTICE,
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

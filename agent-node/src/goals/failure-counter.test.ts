// RFC-025 P0.3 — poison-goal auto-pause counter helpers unit tests.

import { describe, expect, test } from "bun:test";
import type { AgentGoal } from "./types";
import {
  DEFAULT_MAX_CONSECUTIVE_FAILURES,
  resolveMaxConsecutiveFailures,
  getFailureCount,
  bumpFailure,
  resetFailure,
  applyAutoPause,
} from "./failure-counter";

function mkGoal(overrides: Partial<AgentGoal> = {}): AgentGoal {
  return {
    goal_id: "test-goal-1",
    text: "test",
    status: "active",
    interval_ms: 300_000,
    next_wake_at: new Date().toISOString(),
    runtime: "claude-agent-sdk",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    progress_log: [],
    ...overrides,
  };
}

describe("resolveMaxConsecutiveFailures", () => {
  test("default 5 when env unset", () => {
    expect(resolveMaxConsecutiveFailures({})).toBe(5);
  });
  test("env override honored", () => {
    expect(resolveMaxConsecutiveFailures({ COMMHUB_MAX_CONSECUTIVE_FAILURES: "10" })).toBe(10);
  });
  test("invalid env falls back to default", () => {
    expect(resolveMaxConsecutiveFailures({ COMMHUB_MAX_CONSECUTIVE_FAILURES: "not-a-number" })).toBe(5);
    expect(resolveMaxConsecutiveFailures({ COMMHUB_MAX_CONSECUTIVE_FAILURES: "0" })).toBe(5);
    expect(resolveMaxConsecutiveFailures({ COMMHUB_MAX_CONSECUTIVE_FAILURES: "-3" })).toBe(5);
  });
});

describe("getFailureCount", () => {
  test("legacy undefined → 0", () => {
    expect(getFailureCount(mkGoal())).toBe(0);
  });
  test("explicit 0 → 0", () => {
    expect(getFailureCount(mkGoal({ consecutive_failures: 0 }))).toBe(0);
  });
  test("explicit N → N", () => {
    expect(getFailureCount(mkGoal({ consecutive_failures: 3 }))).toBe(3);
  });
});

describe("bumpFailure", () => {
  test("first failure: undefined → 1, shouldPause=false at default threshold", () => {
    const g = mkGoal();
    const r = bumpFailure(g);
    expect(r.newCount).toBe(1);
    expect(r.shouldPause).toBe(false);
    expect(g.consecutive_failures).toBe(1);
  });

  test("4 → 5 at default threshold: shouldPause=true", () => {
    const g = mkGoal({ consecutive_failures: 4 });
    const r = bumpFailure(g);
    expect(r.newCount).toBe(5);
    expect(r.shouldPause).toBe(true);
    expect(g.consecutive_failures).toBe(5);
  });

  test("3 → 4 at threshold 5: shouldPause=false (below threshold)", () => {
    const g = mkGoal({ consecutive_failures: 3 });
    const r = bumpFailure(g);
    expect(r.newCount).toBe(4);
    expect(r.shouldPause).toBe(false);
  });

  test("custom threshold — 2 → 3 at threshold 3: shouldPause=true", () => {
    const g = mkGoal({ consecutive_failures: 2 });
    const r = bumpFailure(g, 3);
    expect(r.newCount).toBe(3);
    expect(r.shouldPause).toBe(true);
  });

  test("beyond threshold: count continues to increment but shouldPause stays true", () => {
    const g = mkGoal({ consecutive_failures: 6 });
    const r = bumpFailure(g);
    expect(r.newCount).toBe(7);
    expect(r.shouldPause).toBe(true);
  });
});

describe("resetFailure", () => {
  test("legacy undefined stays undefined (no unnecessary write)", () => {
    const g = mkGoal();
    resetFailure(g);
    expect(g.consecutive_failures).toBeUndefined();
  });
  test("0 stays 0 (no unnecessary write)", () => {
    const g = mkGoal({ consecutive_failures: 0 });
    resetFailure(g);
    expect(g.consecutive_failures).toBe(0);
  });
  test("N > 0 → 0", () => {
    const g = mkGoal({ consecutive_failures: 3 });
    resetFailure(g);
    expect(g.consecutive_failures).toBe(0);
  });
  test("threshold value → 0", () => {
    const g = mkGoal({ consecutive_failures: 5 });
    resetFailure(g);
    expect(g.consecutive_failures).toBe(0);
  });
});

describe("applyAutoPause", () => {
  test("status flipped to paused + counter preserved for observability", () => {
    const g = mkGoal({ consecutive_failures: 5, status: "active" });
    applyAutoPause(g, "test reason");
    expect(g.status).toBe("paused");
    expect(g.consecutive_failures).toBe(5); // NOT reset — operator can see WHY
  });
  test("progress_log entry recorded with count + reason", () => {
    const g = mkGoal({ consecutive_failures: 5, status: "active" });
    applyAutoPause(g, "vendor 500");
    expect(g.progress_log).toHaveLength(1);
    const entry = g.progress_log[0];
    expect(entry.status).toBe("auto-paused");
    expect(entry.summary).toContain("5 consecutive failures");
    expect(entry.summary).toContain("vendor 500");
  });
  test("long reason truncated to 300 chars in summary", () => {
    const g = mkGoal({ consecutive_failures: 5, status: "active" });
    const longReason = "x".repeat(500);
    applyAutoPause(g, longReason);
    // Summary shape: "auto-paused after 5 consecutive failures: <300 chars>"
    const truncatedTail = g.progress_log[0].summary.split(": ")[1];
    expect(truncatedTail.length).toBeLessThanOrEqual(300);
  });
});

describe("integration: full cycle", () => {
  test("5 bumps → pause → unpause reset → 5 more bumps → pause again", () => {
    const g = mkGoal();
    // First 4 bumps don't pause
    for (let i = 0; i < 4; i++) {
      const r = bumpFailure(g);
      expect(r.shouldPause).toBe(false);
    }
    // 5th bumps AND pauses
    const r5 = bumpFailure(g);
    expect(r5.shouldPause).toBe(true);
    expect(g.consecutive_failures).toBe(5);

    // Auto-pause the goal
    applyAutoPause(g, "poison");
    expect(g.status).toBe("paused");
    expect(g.consecutive_failures).toBe(5);

    // Simulate agent/operator unpause: reset counter + status active
    g.status = "active";
    resetFailure(g);
    expect(g.consecutive_failures).toBe(0);

    // Fresh 5-strike window
    for (let i = 0; i < 4; i++) {
      const r = bumpFailure(g);
      expect(r.shouldPause).toBe(false);
    }
    const r10 = bumpFailure(g);
    expect(r10.shouldPause).toBe(true);
  });
});

// Regression coverage for the bare-"completed" wordmatch bug fixed
// 2026-06-24 (see goals/completion-detect.ts header + docs/analysis/
// loop-runs-once-agentsdk.md). The pre-fix regex would falsely flag
// every wake's structured progress report as goal-complete and end
// the loop after one tick.

import { describe, expect, test } from "bun:test";
import { isGoalCompleteSentinel } from "./completion-detect";

describe("isGoalCompleteSentinel — POSITIVE (must detect)", () => {
  test("Chinese sentinel on its own line", () => {
    expect(isGoalCompleteSentinel("汇报正文\n目标已完成\n")).toBe(true);
  });
  test("Chinese sentinel at end of text without trailing newline", () => {
    expect(isGoalCompleteSentinel("汇报正文\n目标已完成")).toBe(true);
  });
  test("Chinese sentinel at start of text", () => {
    expect(isGoalCompleteSentinel("目标已完成\n其他文字")).toBe(true);
  });
  test("English GOAL_COMPLETE underscore on its own line", () => {
    expect(isGoalCompleteSentinel("Report body...\n\nGOAL_COMPLETE\n")).toBe(true);
  });
  test("English GOAL COMPLETE (space) on its own line", () => {
    expect(isGoalCompleteSentinel("Report body\nGOAL COMPLETE")).toBe(true);
  });
  test("sentinel with leading/trailing whitespace on the line", () => {
    expect(isGoalCompleteSentinel("Report\n   GOAL_COMPLETE   \nMore")).toBe(true);
  });
});

describe("isGoalCompleteSentinel — NEGATIVE (regression gate, must NOT detect)", () => {
  test("bare 'completed' in progress report", () => {
    expect(
      isGoalCompleteSentinel("Completed: 3 sub-tasks\nIn progress: 2\nRisks: none"),
    ).toBe(false);
  });
  test("'X completed' phrase mid-sentence", () => {
    expect(
      isGoalCompleteSentinel("This round I completed the audit and pushed the diff."),
    ).toBe(false);
  });
  test("Chinese '已完成' as section header (not the goal-complete sentinel)", () => {
    expect(
      isGoalCompleteSentinel("已完成：审计了 3 个文件\n进行中：还有 2 个待办\n风险：无"),
    ).toBe(false);
  });
  test("Chinese '已完成 X 项' enumeration in body", () => {
    expect(isGoalCompleteSentinel("本轮已完成 5 项, 还有 2 项进行中")).toBe(false);
  });
  test("'goal completed' as a phrase inside prose (was caught by old regex)", () => {
    expect(
      isGoalCompleteSentinel("Note: the previous goal completed last week; this one is new."),
    ).toBe(false);
  });
  test("'目标已完成' substring without standalone line (old regex would match)", () => {
    expect(isGoalCompleteSentinel("说明这个目标已完成 30% 进度")).toBe(false);
  });
  test("lowercased 'goal_complete' (sentinel is case-sensitive on English)", () => {
    expect(isGoalCompleteSentinel("Report\ngoal_complete\nmore")).toBe(false);
  });
  test("empty / null / undefined input", () => {
    expect(isGoalCompleteSentinel("")).toBe(false);
    expect(isGoalCompleteSentinel(null)).toBe(false);
    expect(isGoalCompleteSentinel(undefined)).toBe(false);
  });
});

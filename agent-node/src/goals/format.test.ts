// RFC-025 M1c P0b — context-injection formatter tests.

import { describe, expect, test } from "bun:test";
import { formatSelfLoopsBlock } from "./format";
import type { AgentGoal } from "./types";

function mkGoal(overrides: Partial<AgentGoal> = {}): AgentGoal {
  return {
    goal_id: "abcdef12-3456-7890-abcd-ef1234567890",
    text: "test goal",
    status: "active",
    interval_ms: 5 * 60_000,
    next_wake_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    runtime: "claude-agent-sdk",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    progress_log: [],
    ...overrides,
  };
}

describe("formatSelfLoopsBlock — empty / omit semantics", () => {
  test("no goals + omitWhenEmpty=true (default) → empty string", () => {
    expect(formatSelfLoopsBlock([])).toBe("");
  });

  test("no goals + omitWhenEmpty=false → explicit '无活跃循环' block", () => {
    const out = formatSelfLoopsBlock([], { omitWhenEmpty: false });
    expect(out).toContain("【你的当前循环任务】");
    expect(out).toContain("(无活跃循环)");
  });

  test("only terminal goals (cancelled/complete/failed) → empty (same as no goals)", () => {
    const goals = [
      mkGoal({ goal_id: "a", status: "complete" }),
      mkGoal({ goal_id: "b", status: "cancelled" }),
      mkGoal({ goal_id: "c", status: "failed" }),
    ];
    expect(formatSelfLoopsBlock(goals)).toBe("");
  });
});

describe("formatSelfLoopsBlock — content shape", () => {
  test("single active goal: header + id8 + cadence + text", () => {
    const out = formatSelfLoopsBlock([
      mkGoal({ goal_id: "12345678-...", text: "monitor PR #271", interval_ms: 5 * 60_000 }),
    ]);
    expect(out).toContain("【你的当前循环任务】");
    expect(out).toContain("12345678");
    expect(out).toContain("active");
    expect(out).toContain("每 5min");
    expect(out).toContain("monitor PR #271");
  });

  test("paused goals shown with status='paused'", () => {
    const out = formatSelfLoopsBlock([
      mkGoal({ goal_id: "p1", status: "paused", text: "twitter scan" }),
    ]);
    expect(out).toContain("paused");
    expect(out).toContain("twitter scan");
  });

  test("mix active + paused + terminal → only active+paused appear", () => {
    const out = formatSelfLoopsBlock([
      mkGoal({ goal_id: "active1", text: "A active" }),
      mkGoal({ goal_id: "paused1", status: "paused", text: "B paused" }),
      mkGoal({ goal_id: "term1", status: "complete", text: "C done" }),
    ]);
    expect(out).toContain("A active");
    expect(out).toContain("B paused");
    expect(out).not.toContain("C done");
  });
});

describe("formatSelfLoopsBlock — cron-lite cadence rendering", () => {
  test("time_of_day cadence: '每天 09:00'", () => {
    const out = formatSelfLoopsBlock([
      mkGoal({
        text: "morning summary",
        schedule: { type: "time_of_day", time: "09:00", timezone: "Asia/Shanghai" },
        interval_ms: 24 * 60 * 60_000,  // natural cadence
      }),
    ]);
    expect(out).toContain("每天 09:00");
    expect(out).toContain("Asia/Shanghai");
  });

  test("weekday cadence: 'mon/wed/fri 18:30'", () => {
    const out = formatSelfLoopsBlock([
      mkGoal({
        text: "MWF report",
        schedule: { type: "weekday", days: ["mon", "wed", "fri"], time: "18:30" },
        interval_ms: 7 * 24 * 60 * 60_000,
      }),
    ]);
    expect(out).toContain("mon/wed/fri 18:30");
  });

  test("new-format interval cadence renders same as legacy interval_ms", () => {
    const out = formatSelfLoopsBlock([
      mkGoal({
        text: "x",
        schedule: { type: "interval", interval_ms: 30 * 60_000 },
        interval_ms: 30 * 60_000,
      }),
    ]);
    expect(out).toContain("每 30min");
  });
});

describe("formatSelfLoopsBlock — cap + truncation", () => {
  test("more than maxGoals → truncates with '...' summary", () => {
    const goals = Array.from({ length: 25 }, (_, i) =>
      mkGoal({ goal_id: `g${i}`, text: `goal ${i}` }),
    );
    const out = formatSelfLoopsBlock(goals, { maxGoals: 3 });
    expect(out).toContain("goal 0");
    expect(out).toContain("goal 1");
    expect(out).toContain("goal 2");
    expect(out).not.toContain("goal 3");
    expect(out).toContain("+22 个更多");
  });

  test("text is one-line truncated at 100 chars", () => {
    const longText = "a".repeat(200);
    const out = formatSelfLoopsBlock([mkGoal({ text: longText })]);
    // truncated text is 100 a's, not 200
    expect(out).toContain("a".repeat(100));
    expect(out).not.toContain("a".repeat(101));
  });

  test("multi-line text is rendered as single line", () => {
    const out = formatSelfLoopsBlock([mkGoal({ text: "line1\nline2\n\nline3" })]);
    expect(out).toContain("line1 line2 line3");
  });
});

describe("formatSelfLoopsBlock — relative time rendering", () => {
  test("next_wake_at far in the future → ISO-shortened", () => {
    const future = new Date(Date.now() + 48 * 60 * 60_000).toISOString();
    const out = formatSelfLoopsBlock([mkGoal({ next_wake_at: future })]);
    expect(out).toContain("下次:");
  });

  test("next_wake_at in past → '已到期'", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const out = formatSelfLoopsBlock([mkGoal({ next_wake_at: past })]);
    expect(out).toContain("已到期");
  });

  test("malformed ISO doesn't crash, falls back to raw", () => {
    const out = formatSelfLoopsBlock([mkGoal({ next_wake_at: "not-a-date" })]);
    expect(out).toContain("not-a-date");
  });
});

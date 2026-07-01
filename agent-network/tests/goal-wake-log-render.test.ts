// RFC-025 P1.1 — anet goal wake-log render helpers.
//
// The CLI wiring reads from filesystem and calls process.exit, which
// makes it painful to unit-test. The interesting logic — how a goal's
// progress_log is shaped into JSON or text — is broken out into two
// pure functions (`renderWakeLogJson`, `renderWakeLogText`) so tests
// can feed shaped inputs and check outputs directly.

import { describe, expect, test } from "bun:test";
import {
  renderWakeLogJson,
  renderWakeLogText,
  type WakeLogEntryShape,
  type WakeLogGoalShape,
} from "../bin/goal-wake-log-render";

function mkEntry(overrides: Partial<WakeLogEntryShape> = {}): WakeLogEntryShape {
  return {
    ts: "2026-07-02T00:00:00Z",
    status: "wake",
    summary: "scheduler tick started",
    ...overrides,
  };
}

function mkGoal(entries: WakeLogEntryShape[] = []): WakeLogGoalShape {
  return { goal_id: "abcdef01-2345-6789-abcd-ef0123456789", progress_log: entries };
}

describe("renderWakeLogJson — pure shape", () => {
  test("legacy goal with no progress_log field → entries=[], total=0", () => {
    const goal: WakeLogGoalShape = { goal_id: "legacy-goal" };
    const r = renderWakeLogJson(goal);
    expect(r.goal_id).toBe("legacy-goal");
    expect(r.total).toBe(0);
    expect(r.returned).toBe(0);
    expect(r.entries).toEqual([]);
  });

  test("goal with explicit empty progress_log → same shape as legacy", () => {
    const r = renderWakeLogJson(mkGoal([]));
    expect(r.total).toBe(0);
    expect(r.returned).toBe(0);
    expect(r.entries).toEqual([]);
  });

  test("goal with 3 entries + no --tail → returns all 3", () => {
    const entries = [mkEntry({ status: "wake" }), mkEntry({ status: "report" }), mkEntry({ status: "wake" })];
    const r = renderWakeLogJson(mkGoal(entries));
    expect(r.total).toBe(3);
    expect(r.returned).toBe(3);
    expect(r.entries).toEqual(entries);
  });

  test("goal with 10 entries + --tail 5 → returns LAST 5", () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      mkEntry({ ts: `2026-07-02T00:00:${String(i).padStart(2, "0")}Z`, summary: `entry ${i}` }),
    );
    const r = renderWakeLogJson(mkGoal(entries), { tail: 5 });
    expect(r.total).toBe(10);
    expect(r.returned).toBe(5);
    expect(r.entries.map((e) => e.summary)).toEqual(["entry 5", "entry 6", "entry 7", "entry 8", "entry 9"]);
  });

  test("--tail N > total → returns all (no crash, no padding)", () => {
    const entries = [mkEntry(), mkEntry()];
    const r = renderWakeLogJson(mkGoal(entries), { tail: 999 });
    expect(r.total).toBe(2);
    expect(r.returned).toBe(2);
    expect(r.entries).toEqual(entries);
  });

  test("--tail 0 or negative → treated as no tail (all entries) — filters at handler layer", () => {
    // The render function doc says tail > 0 activates the slice. Zero/
    // negative → fall through to all-entries. The CLI parseInt guard
    // rejects <1 earlier, but the helper stays permissive for library use.
    const entries = [mkEntry(), mkEntry(), mkEntry()];
    expect(renderWakeLogJson(mkGoal(entries), { tail: 0 }).entries).toEqual(entries);
    expect(renderWakeLogJson(mkGoal(entries), { tail: -5 }).entries).toEqual(entries);
  });

  test("goal_id preserved verbatim in JSON output", () => {
    const goal: WakeLogGoalShape = { goal_id: "unique-goal-xyz", progress_log: [] };
    expect(renderWakeLogJson(goal).goal_id).toBe("unique-goal-xyz");
  });

  test("does not mutate input goal or entries", () => {
    const entries = [mkEntry({ summary: "original" })];
    const goal = mkGoal(entries);
    const before = JSON.stringify(goal);
    renderWakeLogJson(goal, { tail: 1 });
    expect(JSON.stringify(goal)).toBe(before);
  });
});

describe("renderWakeLogText — human console output", () => {
  test("legacy goal (no progress_log) → '(none)' marker + goal_id header", () => {
    const r = renderWakeLogText({ goal_id: "legacy" });
    expect(r).toContain("Goal:     legacy");
    expect(r).toContain("Progress: (none)");
  });

  test("empty progress_log → '(none)' marker (same as legacy)", () => {
    const r = renderWakeLogText(mkGoal([]));
    expect(r).toContain("Progress: (none)");
  });

  test("3 entries no tail → header shows '3 total' + all 3 lines present", () => {
    const entries = [
      mkEntry({ status: "wake", summary: "s1" }),
      mkEntry({ status: "report", summary: "s2" }),
      mkEntry({ status: "complete", summary: "s3" }),
    ];
    const r = renderWakeLogText(mkGoal(entries));
    expect(r).toContain("(3 total)");
    expect(r).toContain("s1");
    expect(r).toContain("s2");
    expect(r).toContain("s3");
    expect(r).toContain("wake");
    expect(r).toContain("report");
    expect(r).toContain("complete");
  });

  test("--tail N < total → header notes 'showing last N of TOTAL'", () => {
    const entries = Array.from({ length: 10 }, (_, i) => mkEntry({ summary: `e${i}` }));
    const r = renderWakeLogText(mkGoal(entries), { tail: 3 });
    expect(r).toContain("showing last 3 of 10");
    expect(r).toContain("e7");
    expect(r).toContain("e8");
    expect(r).toContain("e9");
    expect(r).not.toContain("e0 ");  // e0 should NOT appear
  });

  test("--tail N == total → still says 'N total' not 'showing last N of N'", () => {
    const entries = [mkEntry({ summary: "only-one" })];
    const r = renderWakeLogText(mkGoal(entries), { tail: 5 });
    expect(r).toContain("(1 total)");
    expect(r).not.toContain("showing last");
  });

  test("long summary is truncated to 100 chars", () => {
    const long = "x".repeat(200);
    const entries = [mkEntry({ summary: long })];
    const r = renderWakeLogText(mkGoal(entries));
    // The truncated segment should be present but not the full string
    expect(r).toContain("x".repeat(100));
    expect(r).not.toContain("x".repeat(101));
  });

  test("multi-line summary is flattened (whitespace collapsed)", () => {
    const messy = "line1\n  line2\t\tline3";
    const entries = [mkEntry({ summary: messy })];
    const r = renderWakeLogText(mkGoal(entries));
    expect(r).toContain("line1 line2 line3");
    // The original newline must not survive inside the entry row
    expect(r.split("\n").filter((l) => l.includes("line1 line2 line3"))).toHaveLength(1);
  });

  test("timestamp truncated to first 19 chars (YYYY-MM-DDTHH:MM:SS)", () => {
    const entries = [mkEntry({ ts: "2026-07-02T15:30:45.123Z" })];
    const r = renderWakeLogText(mkGoal(entries));
    expect(r).toContain("2026-07-02T15:30:45");
    expect(r).not.toContain("2026-07-02T15:30:45.123Z");
  });

  test("empty status / missing ts / missing summary render without crash", () => {
    const entries = [
      {},
      { status: "wake" },
      { ts: "2026-07-02T00:00:00Z", summary: "hi" },
    ] as WakeLogEntryShape[];
    const r = renderWakeLogText(mkGoal(entries));
    expect(r).toContain("(3 total)");
    // must not throw; must contain the one entry with actual content
    expect(r).toContain("hi");
  });

  test("does not mutate input goal or entries", () => {
    const entries = [mkEntry({ summary: "original" })];
    const goal = mkGoal(entries);
    const before = JSON.stringify(goal);
    renderWakeLogText(goal, { tail: 1 });
    expect(JSON.stringify(goal)).toBe(before);
  });
});

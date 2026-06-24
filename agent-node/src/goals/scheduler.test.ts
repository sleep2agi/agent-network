// P1a unit tests for the scheduler-tick decision function.

import { expect, test, describe } from "bun:test";
import type { AgentGoal, GoalStatus } from "./types";
import { decideTickWork } from "./scheduler";

function goal(opts: {
  status?: GoalStatus;
  next_wake_at?: string;
  id?: string;
}): AgentGoal {
  const now = new Date();
  return {
    goal_id: opts.id ?? Math.random().toString(36).slice(2, 10),
    text: "test",
    status: opts.status ?? "active",
    interval_ms: 60_000,
    next_wake_at: opts.next_wake_at ?? new Date(now.getTime() + 60_000).toISOString(),
    runtime: "codex-sdk",
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    progress_log: [],
  };
}

const T0 = new Date("2026-06-24T00:00:00.000Z");

describe("decideTickWork — basic selection", () => {
  test("empty list → empty buckets", () => {
    const r = decideTickWork([], T0);
    expect(r.due).toEqual([]);
    expect(r.active).toBe(0);
    expect(r.pending).toBe(0);
    expect(r.skipped).toBe(0);
  });

  test("single active goal due now → due", () => {
    const g = goal({ next_wake_at: T0.toISOString() });
    const r = decideTickWork([g], T0);
    expect(r.due).toHaveLength(1);
    expect(r.due[0].goal_id).toBe(g.goal_id);
    expect(r.active).toBe(1);
    expect(r.pending).toBe(0);
    expect(r.skipped).toBe(0);
  });

  test("single active goal due 1ms ago → due", () => {
    const past = new Date(T0.getTime() - 1).toISOString();
    const g = goal({ next_wake_at: past });
    expect(decideTickWork([g], T0).due).toHaveLength(1);
  });

  test("single active goal due 1ms in future → pending, not due", () => {
    const future = new Date(T0.getTime() + 1).toISOString();
    const g = goal({ next_wake_at: future });
    const r = decideTickWork([g], T0);
    expect(r.due).toHaveLength(0);
    expect(r.pending).toBe(1);
    expect(r.active).toBe(1);
  });

  test("multiple active goals: only the overdue ones wake; pending stay", () => {
    const overdue1 = goal({ id: "a", next_wake_at: new Date(T0.getTime() - 10_000).toISOString() });
    const overdue2 = goal({ id: "b", next_wake_at: new Date(T0.getTime() - 1).toISOString() });
    const future = goal({ id: "c", next_wake_at: new Date(T0.getTime() + 10_000).toISOString() });
    const r = decideTickWork([overdue1, overdue2, future], T0);
    expect(r.due.map(g => g.goal_id)).toEqual(["a", "b"]);
    expect(r.pending).toBe(1);
    expect(r.active).toBe(3);
    expect(r.skipped).toBe(0);
  });
});

describe("decideTickWork — status filtering", () => {
  test("each non-active status is skipped (never appears in due)", () => {
    const overdueIso = new Date(T0.getTime() - 1).toISOString();
    for (const status of ["complete", "failed", "cancelled", "paused"] as GoalStatus[]) {
      const g = goal({ status, next_wake_at: overdueIso });
      const r = decideTickWork([g], T0);
      expect(r.due).toHaveLength(0);
      expect(r.skipped).toBe(1);
      expect(r.active).toBe(0);
    }
  });

  test("mixed batch: only active+due appear in due bucket", () => {
    const overdueIso = new Date(T0.getTime() - 1).toISOString();
    const futureIso = new Date(T0.getTime() + 60_000).toISOString();
    const all = [
      goal({ id: "a-due", status: "active", next_wake_at: overdueIso }),
      goal({ id: "complete-overdue", status: "complete", next_wake_at: overdueIso }),
      goal({ id: "b-due", status: "active", next_wake_at: overdueIso }),
      goal({ id: "active-pending", status: "active", next_wake_at: futureIso }),
      goal({ id: "cancelled-overdue", status: "cancelled", next_wake_at: overdueIso }),
      goal({ id: "paused-pending", status: "paused", next_wake_at: futureIso }),
    ];
    const r = decideTickWork(all, T0);
    expect(r.due.map(g => g.goal_id)).toEqual(["a-due", "b-due"]);
    expect(r.active).toBe(3);
    expect(r.pending).toBe(1);
    expect(r.skipped).toBe(3);
  });

  test("wake order preserves input order — deterministic, no shuffling", () => {
    const overdueIso = new Date(T0.getTime() - 1).toISOString();
    const goals = ["z", "a", "m", "b"].map(id =>
      goal({ id, status: "active", next_wake_at: overdueIso }),
    );
    const r = decideTickWork(goals, T0);
    expect(r.due.map(g => g.goal_id)).toEqual(["z", "a", "m", "b"]);
  });
});

describe("decideTickWork — invalid timestamp recovery", () => {
  test("missing next_wake_at → treated as overdue (surface to wake handler)", () => {
    const g = goal({});
    (g as any).next_wake_at = undefined;
    const r = decideTickWork([g], T0);
    expect(r.due).toHaveLength(1);
    expect(r.due[0].goal_id).toBe(g.goal_id);
  });

  test("empty string next_wake_at → treated as overdue", () => {
    const g = goal({ next_wake_at: "" });
    expect(decideTickWork([g], T0).due).toHaveLength(1);
  });

  test("garbage next_wake_at (Date.parse → NaN) → treated as overdue", () => {
    const g = goal({ next_wake_at: "not a date" });
    expect(decideTickWork([g], T0).due).toHaveLength(1);
  });

  test("non-string next_wake_at (number 0 from corrupt JSON) → treated as overdue", () => {
    const g = goal({});
    (g as any).next_wake_at = 0;
    const r = decideTickWork([g], T0);
    expect(r.due).toHaveLength(1);
  });

  test("inactive + invalid timestamp → still skipped (status wins over wake check)", () => {
    const g = goal({ status: "complete" });
    (g as any).next_wake_at = "garbage";
    const r = decideTickWork([g], T0);
    expect(r.due).toEqual([]);
    expect(r.skipped).toBe(1);
  });
});

describe("decideTickWork — counter sanity", () => {
  test("active + skipped sums to total goals; pending + due sums to active", () => {
    const overdueIso = new Date(T0.getTime() - 1).toISOString();
    const futureIso = new Date(T0.getTime() + 60_000).toISOString();
    const all = [
      goal({ status: "active", next_wake_at: overdueIso }),
      goal({ status: "active", next_wake_at: futureIso }),
      goal({ status: "complete" }),
      goal({ status: "active", next_wake_at: overdueIso }),
      goal({ status: "failed" }),
    ];
    const r = decideTickWork(all, T0);
    expect(r.active + r.skipped).toBe(all.length);
    expect(r.due.length + r.pending).toBe(r.active);
  });
});

// RFC-025 M1d P1 — self-loop tools handler tests.
//
// Each handler exercised against a real GoalStore on a tmp file
// (filesystem-isolated). The safety防线 (cooldown / max-goals /
// batch-cancel confirm-back) tested as first-class behaviour, not
// optional polish.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GoalStore, newGoal } from "./store";
import {
  handleListMyLoops,
  handleCreateMyLoop,
  handleEditMyLoop,
  handleRescheduleMyLoop,
  handleCompleteMyLoop,
  handleCancelMyLoop,
  SELF_LOOP_TOOL_SPECS,
  DEFAULT_BATCH_CANCEL_THRESHOLD,
  type SelfLoopCtx,
} from "./self-loop-tools";

function mkCtx(store: GoalStore, overrides: Partial<SelfLoopCtx> = {}): SelfLoopCtx {
  return {
    store,
    runtime: "claude-agent-sdk",
    defaultTz: "Asia/Shanghai",
    recentCancels: [],
    pendingConfirmTokens: new Set(),
    ...overrides,
  };
}

let dir: string;
let store: GoalStore;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "self-loop-tools-"));
  store = new GoalStore(join(dir, "goals.json"));
  await store.load();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("list_my_loops", () => {
  test("empty store → {goals: [], total: 0}", async () => {
    const r = await handleListMyLoops({}, mkCtx(store));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((r.data as any).goals).toEqual([]);
      expect((r.data as any).total).toBe(0);
    }
  });

  test("includes goal_id_short + cadence schedule shape", async () => {
    await store.upsert(newGoal({ text: "g1", interval_ms: 5 * 60_000, runtime: "claude-agent-sdk" }));
    const r = await handleListMyLoops({}, mkCtx(store));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const g = (r.data as any).goals[0];
      expect(g.goal_id_short).toHaveLength(8);
      expect(g.cadence.type).toBe("interval");
      expect(g.cadence.interval_ms).toBe(5 * 60_000);
    }
  });
});

describe("create_my_loop", () => {
  test("interval string '5m' creates goal", async () => {
    const r = await handleCreateMyLoop({ task: "monitor x", interval: "5m" }, mkCtx(store));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((r.data as any).cadence.interval_ms).toBe(5 * 60_000);
      expect((r.data as any).message).toContain("已创建循环");
    }
    expect((await store.list()).length).toBe(1);
  });

  test("cron-lite time_of_day creates goal with schedule field", async () => {
    const r = await handleCreateMyLoop(
      { task: "morning summary", schedule: { type: "time_of_day", time: "09:00" } },
      mkCtx(store)
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((r.data as any).cadence.type).toBe("time_of_day");
      expect((r.data as any).cadence.time).toBe("09:00");
      expect((r.data as any).cadence.timezone).toBe("Asia/Shanghai"); // injected from ctx.defaultTz
    }
  });

  test("missing task → invalid_args", async () => {
    const r = await handleCreateMyLoop({ interval: "5m" }, mkCtx(store));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("invalid_args");
  });

  test("missing both schedule and interval → invalid_schedule", async () => {
    const r = await handleCreateMyLoop({ task: "x" }, mkCtx(store));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("invalid_schedule");
  });

  test("sub-minute interval rejected (parser 60s floor)", async () => {
    const r = await handleCreateMyLoop({ task: "x", interval: "30s" }, mkCtx(store));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("invalid_schedule");
  });

  test("max active goals cap (3 cap → 4th rejected)", async () => {
    const ctx = mkCtx(store, { maxActiveGoals: 3 });
    for (let i = 0; i < 3; i++) {
      const r = await handleCreateMyLoop({ task: `g${i}`, interval: "5m" }, ctx);
      expect(r.ok).toBe(true);
    }
    const r4 = await handleCreateMyLoop({ task: "g4", interval: "5m" }, ctx);
    expect(r4.ok).toBe(false);
    if (!r4.ok) expect(r4.error).toBe("max_active_goals_reached");
  });
});

describe("edit_my_loop", () => {
  test("change interval + report new value", async () => {
    const g = newGoal({ text: "x", interval_ms: 5 * 60_000, runtime: "claude-agent-sdk" });
    await store.upsert(g);
    // Simulate "60s later" via ctx.now — store.upsert always rewrites
    // updated_at to current time, so pre-dating is futile; ctx.now is
    // the clean cooldown bypass.
    const future = Date.now() + 60_000;
    const r = await handleEditMyLoop({ goal_id: g.goal_id, interval: "30m" }, mkCtx(store, { now: () => future }));
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.data as any).cadence.interval_ms).toBe(30 * 60_000);
  });

  test("paused=true → status=paused", async () => {
    const g = newGoal({ text: "x", interval_ms: 5 * 60_000, runtime: "claude-agent-sdk" });
    await store.upsert(g);
    const future = Date.now() + 60_000;
    const r = await handleEditMyLoop({ goal_id: g.goal_id, paused: true }, mkCtx(store, { now: () => future }));
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.data as any).status).toBe("paused");
  });

  test("cooldown — edit within 30s of last update rejected", async () => {
    const g = newGoal({ text: "x", interval_ms: 5 * 60_000, runtime: "claude-agent-sdk" });
    // updated_at = now (fresh)
    await store.upsert(g);

    const r = await handleEditMyLoop({ goal_id: g.goal_id, interval: "10m" }, mkCtx(store));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("cooldown");
  });

  test("unknown goal_id → goal_not_found", async () => {
    const r = await handleEditMyLoop({ goal_id: "nonexistent" }, mkCtx(store));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("goal_not_found");
  });

  test("P0.3 unpause resets consecutive_failures (fresh 5-strike window)", async () => {
    const g = newGoal({ text: "x", interval_ms: 5 * 60_000, runtime: "claude-agent-sdk" });
    // Simulate a poisoned goal that hit the auto-pause threshold
    g.status = "paused";
    g.consecutive_failures = 5;
    await store.upsert(g);
    // Cooldown-safe now
    const future = Date.now() + 60_000;
    const r = await handleEditMyLoop(
      { goal_id: g.goal_id, paused: false },
      mkCtx(store, { now: () => future }),
    );
    expect(r.ok).toBe(true);
    const after = await store.get(g.goal_id);
    expect(after!.status).toBe("active");
    expect(after!.consecutive_failures).toBe(0);
  });

  test("P0.3 paused=false when already active does NOT wipe mid-failure counter", async () => {
    // Prevent silent regression: an operator or agent edit that sets
    // paused=false on an already-active goal (no-op status wise) must
    // not clobber a legitimate in-flight failure count. Otherwise
    // agents could sidestep the threshold with a spurious unpause.
    const g = newGoal({ text: "x", interval_ms: 5 * 60_000, runtime: "claude-agent-sdk" });
    g.status = "active";
    g.consecutive_failures = 3;
    await store.upsert(g);
    const future = Date.now() + 60_000;
    const r = await handleEditMyLoop(
      { goal_id: g.goal_id, paused: false },
      mkCtx(store, { now: () => future }),
    );
    expect(r.ok).toBe(true);
    const after = await store.get(g.goal_id);
    expect(after!.status).toBe("active");
    expect(after!.consecutive_failures).toBe(3);
  });

  test("P0.3 paused=true does NOT reset consecutive_failures", async () => {
    // Manual pause preserves the counter — if the agent later
    // un-pauses without addressing the failure, the operator wants
    // the counter to carry over so a re-fire loop-crash surfaces fast.
    const g = newGoal({ text: "x", interval_ms: 5 * 60_000, runtime: "claude-agent-sdk" });
    g.status = "active";
    g.consecutive_failures = 4;
    await store.upsert(g);
    const future = Date.now() + 60_000;
    const r = await handleEditMyLoop(
      { goal_id: g.goal_id, paused: true },
      mkCtx(store, { now: () => future }),
    );
    expect(r.ok).toBe(true);
    const after = await store.get(g.goal_id);
    expect(after!.status).toBe("paused");
    expect(after!.consecutive_failures).toBe(4);
  });
});

describe("reschedule_my_loop (★ ScheduleWakeup 范式)", () => {
  test("pushes next_wake_at forward, interval_ms unchanged", async () => {
    const g = newGoal({ text: "x", interval_ms: 5 * 60_000, runtime: "claude-agent-sdk" });
    await store.upsert(g);
    const originalInterval = g.interval_ms;
    // Use ctx.now ~10:00 future timestamp; subtract back so cooldown
    // is satisfied (now - updated_at > 30s). Pick now to be way past
    // the upsert's real wall-clock so updated_at is in the past from
    // ctx.now's perspective.
    const baseline = Date.now() + 60_000;
    const r = await handleRescheduleMyLoop(
      { goal_id: g.goal_id, next_wake_in: "1h" },
      mkCtx(store, { now: () => baseline }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      // next_wake_at = baseline + 1h
      expect((r.data as any).next_wake_at).toBe(new Date(baseline + 60 * 60_000).toISOString());
    }
    // Verify interval not touched
    const after = await store.get(g.goal_id);
    expect(after!.interval_ms).toBe(originalInterval);
  });

  test("invalid next_wake_in → invalid_interval", async () => {
    const g = newGoal({ text: "x", interval_ms: 5 * 60_000, runtime: "claude-agent-sdk" });
    await store.upsert(g);
    const future = Date.now() + 60_000;
    const r = await handleRescheduleMyLoop(
      { goal_id: g.goal_id, next_wake_in: "30s" },
      mkCtx(store, { now: () => future }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("invalid_interval");
  });

  test("cooldown applies", async () => {
    const g = newGoal({ text: "x", interval_ms: 5 * 60_000, runtime: "claude-agent-sdk" });
    await store.upsert(g);
    const r = await handleRescheduleMyLoop({ goal_id: g.goal_id, next_wake_in: "1h" }, mkCtx(store));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("cooldown");
  });
});

describe("complete_my_loop (★ 达标归档)", () => {
  test("status → 'complete'", async () => {
    const g = newGoal({ text: "x", interval_ms: 5 * 60_000, runtime: "claude-agent-sdk" });
    await store.upsert(g);
    const r = await handleCompleteMyLoop({ goal_id: g.goal_id }, mkCtx(store));
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.data as any).status).toBe("complete");
    expect((await store.get(g.goal_id))!.status).toBe("complete");
  });

  test("unknown goal_id → goal_not_found", async () => {
    const r = await handleCompleteMyLoop({ goal_id: "x" }, mkCtx(store));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("goal_not_found");
  });
});

describe("cancel_my_loop", () => {
  test("status → 'cancelled'", async () => {
    const g = newGoal({ text: "x", interval_ms: 5 * 60_000, runtime: "claude-agent-sdk" });
    await store.upsert(g);
    const r = await handleCancelMyLoop({ goal_id: g.goal_id }, mkCtx(store));
    expect(r.ok).toBe(true);
    expect((await store.get(g.goal_id))!.status).toBe("cancelled");
  });

  test("batch cancel (3 in 30s) triggers confirm-back on 4th", async () => {
    const recentCancels: number[] = [];
    const pendingConfirmTokens = new Set<string>();
    const t0 = Date.now();
    const ctx = mkCtx(store, { recentCancels, pendingConfirmTokens, now: () => t0 });

    // Pre-fill 3 cancels in window
    for (let i = 0; i < DEFAULT_BATCH_CANCEL_THRESHOLD; i++) {
      const g = newGoal({ text: `g${i}`, interval_ms: 5 * 60_000, runtime: "claude-agent-sdk" });
      await store.upsert(g);
      const r = await handleCancelMyLoop({ goal_id: g.goal_id }, ctx);
      expect(r.ok).toBe(true);
    }
    // 4th cancel triggers confirm
    const g4 = newGoal({ text: "g4", interval_ms: 5 * 60_000, runtime: "claude-agent-sdk" });
    await store.upsert(g4);
    const r4 = await handleCancelMyLoop({ goal_id: g4.goal_id }, ctx);
    expect(r4.ok).toBe(false);
    if (!r4.ok) {
      expect(r4.error).toBe("batch_destructive_confirm_required");
      expect(r4.confirm_token).toBeTruthy();
    }
    // g4 NOT cancelled
    expect((await store.get(g4.goal_id))!.status).toBe("active");

    // Re-call with confirm_token → proceeds
    if (!r4.ok) {
      const r4b = await handleCancelMyLoop(
        { goal_id: g4.goal_id, confirm_token: r4.confirm_token },
        ctx
      );
      expect(r4b.ok).toBe(true);
      expect((await store.get(g4.goal_id))!.status).toBe("cancelled");
    }
  });
});

describe("#302 round-2 — preflight computeNextWakeAt (self-lock prevention)", () => {
  // 通信牛 catch: structured schedule that passes shape validation
  // but throws at computeNextWakeAt-time (bad IANA timezone, etc.)
  // would land in goals.json, and every scheduler tick would throw
  // → goal stays active+due → self-locking wake storm.
  //
  // Pin: create/edit MUST preflight computeNextWakeAt and reject
  // with invalid_schedule BEFORE writing. Existing goals must be
  // untouched if the edit is rejected.

  test("create_my_loop: bad timezone in schedule → invalid_schedule, NOT written", async () => {
    const before = (await store.list()).length;
    const r = await handleCreateMyLoop(
      {
        task: "morning",
        schedule: { type: "time_of_day", time: "09:00", timezone: "Bad/Zone" },
      },
      mkCtx(store),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("invalid_schedule");
      expect(r.message).toMatch(/Bad\/Zone|invalid time zone/i);
    }
    // load fresh from disk to verify it didn't sneak in
    expect((await store.list()).length).toBe(before);
  });

  test("create_my_loop: bad weekday → invalid_schedule, NOT written", async () => {
    const before = (await store.list()).length;
    const r = await handleCreateMyLoop(
      {
        task: "bad",
        schedule: { type: "weekday", days: ["funday"], time: "09:00" },
      },
      mkCtx(store),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("invalid_schedule");
    expect((await store.list()).length).toBe(before);
  });

  test("create_my_loop: bad time format → invalid_schedule, NOT written", async () => {
    const before = (await store.list()).length;
    const r = await handleCreateMyLoop(
      {
        task: "bad",
        schedule: { type: "time_of_day", time: "25:99" },
      },
      mkCtx(store),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("invalid_schedule");
    expect((await store.list()).length).toBe(before);
  });

  test("edit_my_loop: bad timezone on edit → invalid_schedule, EXISTING goal untouched", async () => {
    // Seed a healthy goal with status=active + interval cadence
    const healthy = newGoal({ text: "healthy", interval_ms: 5 * 60_000, runtime: "claude-agent-sdk" });
    await store.upsert(healthy);
    const beforeStored = await store.get(healthy.goal_id);
    const beforeIso = beforeStored!.updated_at;
    const beforeNext = beforeStored!.next_wake_at;
    const beforeStatus = beforeStored!.status;
    const beforeText = beforeStored!.text;

    const future = Date.now() + 60_000;
    const r = await handleEditMyLoop(
      {
        goal_id: healthy.goal_id,
        schedule: { type: "time_of_day", time: "09:00", timezone: "Mars/Phobos" },
        task: "should not change either", // even other fields must not slip through
      },
      mkCtx(store, { now: () => future }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("invalid_schedule");

    // Verify EXISTING goal completely untouched
    const after = await store.get(healthy.goal_id);
    expect(after!.text).toBe(beforeText);
    expect(after!.status).toBe(beforeStatus);
    expect(after!.next_wake_at).toBe(beforeNext);
    expect(after!.updated_at).toBe(beforeIso);
    expect(after!.schedule).toBeUndefined(); // no schedule corruption
  });

  test("create_my_loop: VALID structured schedule still works (regression)", async () => {
    // Sanity check — the preflight must not over-reject good schedules.
    const r = await handleCreateMyLoop(
      {
        task: "valid morning",
        schedule: { type: "time_of_day", time: "09:00", timezone: "Asia/Shanghai" },
      },
      mkCtx(store),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((r.data as any).cadence.type).toBe("time_of_day");
    }
  });
});

describe("SELF_LOOP_TOOL_SPECS — registration table", () => {
  test("exports 6 tools with stable names", () => {
    const names = SELF_LOOP_TOOL_SPECS.map((s) => s.name);
    expect(names).toEqual([
      "list_my_loops",
      "create_my_loop",
      "edit_my_loop",
      "reschedule_my_loop",
      "complete_my_loop",
      "cancel_my_loop",
    ]);
  });

  test("every spec has non-empty description (LLM-discoverable)", () => {
    for (const s of SELF_LOOP_TOOL_SPECS) {
      expect(s.description.length).toBeGreaterThan(30);
    }
  });

  test("description guides per RFC-025 §3.2 (intent-parse + report-back + safety)", () => {
    const create = SELF_LOOP_TOOL_SPECS.find((s) => s.name === "create_my_loop")!;
    // #3 report-back hint
    expect(create.description).toMatch(/回报新值/);
    const edit = SELF_LOOP_TOOL_SPECS.find((s) => s.name === "edit_my_loop")!;
    // #4 disambiguation
    expect(edit.description).toMatch(/临时/);
    const cancel = SELF_LOOP_TOOL_SPECS.find((s) => s.name === "cancel_my_loop")!;
    // #2 confirm-back
    expect(cancel.description).toMatch(/confirm_token|confirm-back|确认/);
    const complete = SELF_LOOP_TOOL_SPECS.find((s) => s.name === "complete_my_loop")!;
    expect(complete.description).toMatch(/达标|归档/);
  });
});

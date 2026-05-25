// Phase 1 of #184 — GoalStore unit tests.
//
// Cover: empty load, upsert/get/list/delete/setStatus/mutate roundtrip,
// cross-instance persistence (= "restart" simulation), corruption recovery
// (#2: backup + graceful start-empty), and mutex serialisation under
// concurrent upserts (#1+#3).

import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { GoalStore, newGoal } from "./store";

function tmpPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "anet-goals-test-"));
  return { dir, path: join(dir, "goals.json") };
}

describe("GoalStore — basic lifecycle", () => {
  let dir: string, path: string;
  beforeEach(() => { ({ dir, path } = tmpPath()); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("fresh store: load with no file → ok, empty list", async () => {
    const s = new GoalStore(path);
    const r = await s.load();
    expect(r.ok).toBe(true);
    expect(await s.list()).toEqual([]);
  });

  test("upsert → get → list roundtrip", async () => {
    const s = new GoalStore(path);
    await s.load();
    const g = newGoal({ text: "report progress", interval_ms: 60_000, runtime: "codex-sdk" });
    await s.upsert(g);
    expect(await s.list()).toHaveLength(1);
    const got = await s.get(g.goal_id);
    expect(got?.text).toBe("report progress");
    expect(got?.status).toBe("active");
  });

  test("delete → flushes to disk", async () => {
    const s = new GoalStore(path);
    await s.load();
    const g = newGoal({ text: "todelete", interval_ms: 60_000, runtime: "codex-sdk" });
    await s.upsert(g);
    expect(await s.delete(g.goal_id)).toBe(true);
    expect(await s.delete(g.goal_id)).toBe(false);  // idempotent
    expect(await s.list()).toEqual([]);
  });

  test("setStatus → in-memory + persisted", async () => {
    const s = new GoalStore(path);
    await s.load();
    const g = newGoal({ text: "status", interval_ms: 60_000, runtime: "codex-sdk" });
    await s.upsert(g);
    const updated = await s.setStatus(g.goal_id, "complete");
    expect(updated?.status).toBe("complete");
    expect((await s.get(g.goal_id))?.status).toBe("complete");
  });

  test("setStatus on unknown id → undefined, no throw", async () => {
    const s = new GoalStore(path);
    await s.load();
    expect(await s.setStatus("nonexistent", "complete")).toBeUndefined();
  });

  test("mutate applies in-place + bumps updated_at", async () => {
    const s = new GoalStore(path);
    await s.load();
    const g = newGoal({ text: "x", interval_ms: 60_000, runtime: "codex-sdk" });
    await s.upsert(g);
    const before = (await s.get(g.goal_id))!.updated_at;
    await new Promise(r => setTimeout(r, 5));  // ensure timestamp tick
    const after = await s.mutate(g.goal_id, (live) => {
      live.last_wake_at = new Date().toISOString();
      live.progress_log.push({ ts: new Date().toISOString(), status: "wake", summary: "tick" });
    });
    expect(after?.last_wake_at).toBeDefined();
    expect(after?.progress_log).toHaveLength(1);
    expect(after?.updated_at).not.toBe(before);
  });

  test("mutate on unknown id → undefined, mutator NOT invoked", async () => {
    const s = new GoalStore(path);
    await s.load();
    let called = false;
    const r = await s.mutate("nonexistent", () => { called = true; });
    expect(r).toBeUndefined();
    expect(called).toBe(false);
  });
});

describe("GoalStore — restart persistence", () => {
  let dir: string, path: string;
  beforeEach(() => { ({ dir, path } = tmpPath()); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("two instances see the same goals (= restart simulation)", async () => {
    const s1 = new GoalStore(path);
    await s1.load();
    const g = newGoal({ text: "persist me", interval_ms: 60_000, runtime: "codex-sdk" });
    await s1.upsert(g);

    const s2 = new GoalStore(path);
    const r = await s2.load();
    expect(r.ok).toBe(true);
    expect(await s2.list()).toHaveLength(1);
    expect((await s2.get(g.goal_id))?.text).toBe("persist me");
  });

  test("status change survives reload", async () => {
    const s1 = new GoalStore(path);
    await s1.load();
    const g = newGoal({ text: "completes", interval_ms: 60_000, runtime: "codex-sdk" });
    await s1.upsert(g);
    await s1.setStatus(g.goal_id, "complete");

    const s2 = new GoalStore(path);
    await s2.load();
    expect((await s2.get(g.goal_id))?.status).toBe("complete");
  });
});

describe("GoalStore — corruption recovery (#2)", () => {
  let dir: string, path: string;
  beforeEach(() => { ({ dir, path } = tmpPath()); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("invalid JSON → ok=false, .corrupt backup, empty store", async () => {
    const garbage = "this is not valid json {{{ ";
    writeFileSync(path, garbage);
    const s = new GoalStore(path);
    const r = await s.load();
    expect(r.ok).toBe(false);
    expect(r.recovered).toBeDefined();
    expect(r.error).toMatch(/invalid JSON/);
    if (r.recovered) {
      expect(existsSync(r.recovered)).toBe(true);
      expect(readFileSync(r.recovered, "utf-8")).toBe(garbage);
    }
    // graceful degrade — store is operational + empty
    expect(await s.list()).toEqual([]);

    // operations should still work post-recovery
    const g = newGoal({ text: "after recovery", interval_ms: 60_000, runtime: "codex-sdk" });
    await s.upsert(g);
    expect(await s.list()).toHaveLength(1);
  });

  test("unknown schema version → recovery", async () => {
    writeFileSync(path, JSON.stringify({ version: 99, goals: [] }));
    const s = new GoalStore(path);
    const r = await s.load();
    expect(r.ok).toBe(false);
    expect(r.recovered).toBeDefined();
    expect(r.error).toMatch(/unknown schema/);
    expect(await s.list()).toEqual([]);
  });

  test("malformed shape (goals not array) → recovery", async () => {
    writeFileSync(path, JSON.stringify({ version: 1, goals: { not: "an array" } }));
    const s = new GoalStore(path);
    const r = await s.load();
    expect(r.ok).toBe(false);
    expect(r.recovered).toBeDefined();
  });
});

describe("GoalStore — mutex serialisation (#1+#3)", () => {
  let dir: string, path: string;
  beforeEach(() => { ({ dir, path } = tmpPath()); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("50 concurrent upserts → all 50 persist (no torn writes)", async () => {
    const s = new GoalStore(path);
    await s.load();
    const goals = Array.from({ length: 50 }, (_, i) =>
      newGoal({ text: `g${i}`, interval_ms: 60_000, runtime: "codex-sdk" })
    );
    await Promise.all(goals.map((g) => s.upsert(g)));
    expect(await s.list()).toHaveLength(50);

    // cross-instance verify: a fresh load must see all 50 — no torn JSON
    const s2 = new GoalStore(path);
    const r = await s2.load();
    expect(r.ok).toBe(true);
    expect(await s2.list()).toHaveLength(50);
  });

  test("interleaved upsert + setStatus + delete stays consistent", async () => {
    const s = new GoalStore(path);
    await s.load();
    const ids: string[] = [];
    // 20 upserts + 10 setStatus + 5 deletes in concurrent flight
    const ops: Promise<unknown>[] = [];
    for (let i = 0; i < 20; i++) {
      const g = newGoal({ text: `op${i}`, interval_ms: 60_000, runtime: "codex-sdk" });
      ids.push(g.goal_id);
      ops.push(s.upsert(g));
    }
    await Promise.all(ops);

    const status: Promise<unknown>[] = [];
    for (let i = 0; i < 10; i++) status.push(s.setStatus(ids[i], "complete"));
    const dels: Promise<unknown>[] = [];
    for (let i = 15; i < 20; i++) dels.push(s.delete(ids[i]));
    await Promise.all([...status, ...dels]);

    const list = await s.list();
    expect(list).toHaveLength(15);  // 20 - 5 deletes
    const completes = list.filter((g) => g.status === "complete");
    expect(completes).toHaveLength(10);

    // restart simulation reads the same state
    const s2 = new GoalStore(path);
    await s2.load();
    expect(await s2.list()).toHaveLength(15);
  });
});

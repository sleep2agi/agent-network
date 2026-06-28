// Phase 1 of #184 — GoalStore unit tests.
//
// Cover: empty load, upsert/get/list/delete/setStatus/mutate roundtrip,
// cross-instance persistence (= "restart" simulation), corruption recovery
// (#2: backup + graceful start-empty), and mutex serialisation under
// concurrent upserts (#1+#3).

import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  GoalStore,
  newGoal,
  isClaudeRuntime,
  runtimeBucket,
  decideStartupAction,
} from "./store";
import type { AgentGoal } from "./types";

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

// ─────────────────────────────────────────────────────────────────────
// P0 /loop SDK runtime gate (v0.4 §3.4) — the heart of "claude hands-off".
// ─────────────────────────────────────────────────────────────────────

describe("P0 runtime gate — name resolution", () => {
  test("isClaudeRuntime accepts every claude alias", () => {
    for (const name of ["claude", "claude-agent-sdk", "claude-sdk", "agent-sdk"]) {
      expect(isClaudeRuntime(name)).toBe(true);
    }
  });

  test("isClaudeRuntime rejects codex / grok / unknown / empty", () => {
    for (const name of ["codex", "codex-sdk", "grok", "grok-build-acp", "grok-build", "weird", "", null, undefined]) {
      expect(isClaudeRuntime(name as any)).toBe(false);
    }
  });

  test("runtimeBucket maps to canonical buckets", () => {
    expect(runtimeBucket("claude-agent-sdk")).toBe("claude");
    expect(runtimeBucket("claude")).toBe("claude");
    expect(runtimeBucket("codex-sdk")).toBe("codex");
    expect(runtimeBucket("codex")).toBe("codex");
    expect(runtimeBucket("grok-build-acp")).toBe("grok");
    expect(runtimeBucket("grok-build")).toBe("grok");
    expect(runtimeBucket("grok")).toBe("grok");
    expect(runtimeBucket("mystery")).toBe("unknown");
    expect(runtimeBucket(null)).toBe("unknown");
    expect(runtimeBucket(undefined)).toBe("unknown");
    expect(runtimeBucket("")).toBe("unknown");
  });
});

describe("#144 round-6 — claude runtime gate REMOVED, scheduler is universal", () => {
  // History: pre-#144 a `assertNonClaudeRuntime` gate threw on any
  // claude alias. The premise (claude-agent-sdk has a native /loop) was
  // false — SDK is one-shot query(), no persistent CC REPL to host
  // CronCreate/ScheduleWakeup. Loop silently didn't fire for claude
  // users. These tests pin the post-#144 universal behaviour: every
  // recognized runtime (incl. claude) creates + persists goals.

  test("newGoal({runtime: 'claude-agent-sdk'}) succeeds (was the load-bearing bug)", () => {
    const g = newGoal({ text: "claude loop", interval_ms: 60_000, runtime: "claude-agent-sdk" });
    expect(g.runtime).toBe("claude-agent-sdk");
    expect(g.status).toBe("active");
  });

  test("newGoal succeeds for every recognized runtime alias (no per-bucket carve-out)", () => {
    for (const rt of [
      "claude", "claude-agent-sdk", "claude-sdk", "agent-sdk",
      "codex", "codex-sdk",
      "grok", "grok-build", "grok-build-acp",
    ]) {
      const g = newGoal({ text: "x", interval_ms: 60_000, runtime: rt });
      expect(g.runtime).toBe(rt);
    }
  });

  test("GoalStore.upsert accepts a claude-runtime goal end-to-end", async () => {
    const d = mkdtempSync(join(tmpdir(), "anet-goals-test-"));
    const path = join(d, "goals.json");
    try {
      const s = new GoalStore(path);
      await s.load();
      const g = newGoal({ text: "claude e2e", interval_ms: 60_000, runtime: "claude-agent-sdk" });
      await s.upsert(g);
      expect(await s.list()).toHaveLength(1);
      const loaded = (await s.list())[0];
      expect(loaded.runtime).toBe("claude-agent-sdk");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("isClaudeRuntime still classifies (kept for cross-bucket detection, not gating)", () => {
    expect(isClaudeRuntime("claude-agent-sdk")).toBe(true);
    expect(isClaudeRuntime("codex-sdk")).toBe(false);
  });
});

describe("P0 runtime gate — archiveAndClear", () => {
  let dir: string, path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "anet-goals-test-"));
    path = join(dir, "goals.json");
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("with live goals: backup file created, store emptied, reload sees empty", async () => {
    const s1 = new GoalStore(path);
    await s1.load();
    await s1.upsert(newGoal({ text: "a", interval_ms: 60_000, runtime: "codex-sdk" }));
    await s1.upsert(newGoal({ text: "b", interval_ms: 60_000, runtime: "grok-build-acp" }));
    expect(await s1.list()).toHaveLength(2);

    const backup = await s1.archiveAndClear("runtime-switched-to-claude");
    expect(backup).toBeDefined();
    expect(backup).toMatch(/\.runtime-switched\./);
    expect(existsSync(backup!)).toBe(true);

    // Backup contents = exactly what was on disk before clear.
    const backupParsed = JSON.parse(readFileSync(backup!, "utf-8"));
    expect(backupParsed.goals).toHaveLength(2);
    expect(backupParsed.goals.map((g: AgentGoal) => g.text).sort()).toEqual(["a", "b"]);

    // Live store now empty in-memory + on-disk.
    expect(await s1.list()).toEqual([]);
    const s2 = new GoalStore(path);
    await s2.load();
    expect(await s2.list()).toEqual([]);
  });

  test("with no live file: returns undefined, no throw, store still flushes empty", async () => {
    const s = new GoalStore(path);
    await s.load();
    // No upsert before archive — nothing was ever written.
    const backup = await s.archiveAndClear("nothing to lose");
    expect(backup).toBeUndefined();
    // Post-archive an empty goals.json exists on disk (we always flush).
    expect(existsSync(path)).toBe(true);
    expect(await s.list()).toEqual([]);
  });

  test("backup filenames are unique across rapid calls", async () => {
    const s = new GoalStore(path);
    await s.load();
    await s.upsert(newGoal({ text: "one", interval_ms: 60_000, runtime: "codex-sdk" }));
    const b1 = await s.archiveAndClear("first");
    await s.upsert(newGoal({ text: "two", interval_ms: 60_000, runtime: "codex-sdk" }));
    // Ensure timestamp tick so the second backup filename differs.
    await new Promise(r => setTimeout(r, 10));
    const b2 = await s.archiveAndClear("second");
    expect(b1).toBeDefined();
    expect(b2).toBeDefined();
    expect(b1).not.toBe(b2);
    const archives = readdirSync(dir).filter(f => f.includes("runtime-switched"));
    expect(archives).toHaveLength(2);
  });
});

describe("#144 round-6 — decideStartupAction (refined-B matrix)", () => {
  function activeGoal(runtime: string): AgentGoal {
    return newGoal({ text: "x", interval_ms: 60_000, runtime });
  }
  function inactiveGoal(runtime: string, status: AgentGoal["status"]): AgentGoal {
    const g = newGoal({ text: "x", interval_ms: 60_000, runtime });
    g.status = status;
    return g;
  }

  // ── claude bucket: no longer a special case ──

  test("claude + empty → ok (scheduler runs; was 'skip' pre-#144)", () => {
    const a = decideStartupAction("claude", []);
    expect(a.kind).toBe("ok");
    expect(a.runScheduler).toBe(true);
  });

  test("claude + only claude-active goals → ok (scheduler runs)", () => {
    const a = decideStartupAction("claude", [
      activeGoal("claude-agent-sdk"),
      activeGoal("claude-agent-sdk"),
    ]);
    expect(a.kind).toBe("ok");
    expect(a.runScheduler).toBe(true);
  });

  // ── codex / grok: same-bucket happy path ──

  test("codex + empty → ok", () => {
    const a = decideStartupAction("codex", []);
    expect(a.kind).toBe("ok");
    expect(a.runScheduler).toBe(true);
  });

  test("codex + only codex goals → ok", () => {
    const a = decideStartupAction("codex", [activeGoal("codex-sdk")]);
    expect(a.kind).toBe("ok");
  });

  test("grok + only grok goals → ok", () => {
    const a = decideStartupAction("grok", [activeGoal("grok-build-acp")]);
    expect(a.kind).toBe("ok");
  });

  // ── cross-bucket: archive (NOT fatal) ──

  test("claude + active codex/grok goals → archive + runScheduler=true (recover after archive)", () => {
    const a = decideStartupAction("claude", [
      activeGoal("codex-sdk"),
      activeGoal("grok-build-acp"),
    ]);
    expect(a.kind).toBe("archive");
    expect(a.runScheduler).toBe(true); // ← new: was false pre-#144
    if (a.kind === "archive") {
      expect(a.foreignCount).toBe(2);
      expect(a.foreignBuckets.sort()).toEqual(["codex", "grok"]);
    }
  });

  test("codex + grok-active leftover → archive (NOT fatal exit anymore)", () => {
    const a = decideStartupAction("codex", [activeGoal("grok-build-acp")]);
    expect(a.kind).toBe("archive");
    expect(a.runScheduler).toBe(true); // ← was kind=fatal, runScheduler=false pre-#144
    if (a.kind === "archive") {
      expect(a.foreignCount).toBe(1);
      expect(a.foreignBuckets).toEqual(["grok"]);
    }
  });

  test("grok + codex-active leftover → archive", () => {
    const a = decideStartupAction("grok", [activeGoal("codex-sdk")]);
    expect(a.kind).toBe("archive");
    expect(a.runScheduler).toBe(true);
  });

  // ── non-active foreign goals don't trigger archive ──

  test("inactive foreign-bucket goals do NOT trigger archive (only `active` counts)", () => {
    const a = decideStartupAction("codex", [
      inactiveGoal("grok-build-acp", "complete"),
      activeGoal("codex-sdk"),
    ]);
    expect(a.kind).toBe("ok");
  });

  test("claude with only inactive foreign leftover → ok (just cleanup pending)", () => {
    const a = decideStartupAction("claude", [
      inactiveGoal("codex-sdk", "complete"),
      inactiveGoal("grok-build-acp", "cancelled"),
    ]);
    expect(a.kind).toBe("ok");
  });

  // ── unknown bucket: still skip (defensive) ──

  test("unknown bucket → skip (no scheduler, no auto-archive)", () => {
    const a = decideStartupAction("unknown", [activeGoal("codex-sdk")]);
    expect(a.kind).toBe("skip");
    expect(a.runScheduler).toBe(false);
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

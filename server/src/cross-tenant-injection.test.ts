// Round-5 F1+F2: cross-tenant write/inject guards.
//
// All three guards are exercised against a real in-process SQLite
// (COMMHUB_DB=/tmp/...) so we're not just unit-testing the SQL string,
// we're proving the rejection actually happens against persisted rows.
//
// Setup: two networks (A, B). Create a task in network A with a known
// task_id. Then drive the three attack vectors below from a session
// belonging to network B and assert each is blocked.
//
// Run with:
//   COMMHUB_DB=/tmp/xtenant-test.db bun test src/cross-tenant-injection.test.ts

import { describe, expect, test, beforeEach } from "bun:test";
import { db, uuidv4, chainReplyToParent } from "./db.js";

function insertTask(opts: {
  task_id?: string;
  from_name: string;
  to_name: string;
  network_id: string | null;
  status?: string;
  parent_task_id?: string | null;
  result?: string | null;
}): string {
  const id = opts.task_id ?? uuidv4();
  db.run(
    `INSERT INTO tasks (task_id, from_name, to_name, priority, status, content, requires_response, created_at, network_id, parent_task_id, result)
     VALUES (?1, ?2, ?3, 'normal', ?4, 'test content', 'reply', datetime('now'), ?5, ?6, ?7)`,
    [id, opts.from_name, opts.to_name, opts.status ?? "delivered", opts.network_id, opts.parent_task_id ?? null, opts.result ?? null]
  );
  return id;
}

function getTask(taskId: string) {
  return db.get<{ task_id: string; status: string; result: string | null; network_id: string | null }>(
    "SELECT task_id, status, result, network_id FROM tasks WHERE task_id = ?1",
    taskId
  );
}

function countInbox(toSession: string): number {
  const row = db.get<{ cnt: number }>(
    "SELECT COUNT(*) as cnt FROM inbox WHERE session_name = ?1",
    toSession
  );
  return row?.cnt ?? 0;
}

beforeEach(() => {
  // Clean slate per test so prior fixtures don't leak across runs.
  db.run("DELETE FROM tasks");
  db.run("DELETE FROM inbox");
  db.run("DELETE FROM task_events");
});

// ─────────────────────────────────────────────────────────────────────
// F2 #3 — chainReplyToParent cross-network rejection
//
// The unit-level test of the most direct vector: caller in network B
// holds a child task whose `parent_task_id` points at a parent in
// network A. Without the fix, chainReplyToParent walks the link and
// writes `result` + an inbox notification into network A. With the
// fix, the function refuses to traverse and writes nothing.
// ─────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────
// Round-5 follow-up — chainReplyToParent return value gates SSE push
//
// 通信牛 catch on #275: the DB write is refused on cross-network, but
// the post-call code in tools.ts was still running:
//
//   SELECT parent_task_id, from_name FROM tasks WHERE task_id = ?
//   SELECT from_name, task_id ... WHERE task_id = ?
//   pushEvent(parent.from_name, { parent_task_id: <netA-id>, ... },
//             effectiveNetId)
//
// That pushEvent leaks the foreign parent's task_id into the caller's
// network via SSE payload. The fix: chainReplyToParent now returns
// `{ chained, stoppedReason? }` so callers can skip the follow-up
// push when the chain didn't actually write. These tests pin the
// return contract directly. The SSE-gate is exercised at the call
// sites in tools.ts; pinning the contract here ensures the call-site
// behaviour can't drift back if someone refactors db.ts.
// ─────────────────────────────────────────────────────────────────────

describe("chainReplyToParent — return value gates SSE push (round5 follow-up)", () => {
  test("cross-network refusal returns { chained: false, stoppedReason: 'cross_network' }", () => {
    const parentA = insertTask({
      from_name: "admin-a",
      to_name: "worker-a",
      network_id: "net-A",
      status: "delivered",
    });
    const childB = insertTask({
      from_name: "attacker-b",
      to_name: "victim-b",
      network_id: "net-B",
      status: "replied",
      parent_task_id: parentA,
    });

    const result = chainReplyToParent(childB, "payload", "replied", 5, "net-B");

    expect(result.chained).toBe(false);
    expect(result.stoppedReason).toBe("cross_network");
  });

  test("legitimate same-network chain returns { chained: true } (no stoppedReason)", () => {
    const parentB = insertTask({
      from_name: "admin-b",
      to_name: "worker-b",
      network_id: "net-B",
      status: "delivered",
    });
    const childB = insertTask({
      from_name: "child-b",
      to_name: "leaf-b",
      network_id: "net-B",
      status: "replied",
      parent_task_id: parentB,
    });

    const result = chainReplyToParent(childB, "ok", "replied", 5, "net-B");

    expect(result.chained).toBe(true);
    expect(result.stoppedReason).toBeUndefined();
  });

  test("child with no parent returns { chained: false } (no stoppedReason)", () => {
    const orphan = insertTask({
      from_name: "x",
      to_name: "y",
      network_id: "net-B",
      status: "replied",
    });

    const result = chainReplyToParent(orphan, "ok", "replied", 5, "net-B");

    expect(result.chained).toBe(false);
    expect(result.stoppedReason).toBeUndefined();
  });

  test("3-level chain: same-net parent writes, foreign grandparent halts → chained=true, stoppedReason='cross_network'", () => {
    const grandparent = insertTask({
      from_name: "gp-admin",
      to_name: "gp-worker",
      network_id: "net-A",
      status: "delivered",
    });
    const parent = insertTask({
      from_name: "p-admin",
      to_name: "p-worker",
      network_id: "net-B",
      status: "delivered",
      parent_task_id: grandparent,
    });
    const child = insertTask({
      from_name: "c",
      to_name: "leaf",
      network_id: "net-B",
      status: "replied",
      parent_task_id: parent,
    });

    const result = chainReplyToParent(child, "ok", "replied", 5, "net-B");

    // We DID write into the same-net parent before the chain halted
    // at the foreign grandparent. `chained: true` lets callers push
    // SSE for the legitimate parent; `stoppedReason` makes it visible
    // in logs/metrics that the chain didn't run to completion.
    expect(result.chained).toBe(true);
    expect(result.stoppedReason).toBe("cross_network");
  });
});

describe("chainReplyToParent — cross-network rejection (round5 F2 #3)", () => {
  test("blocks chain when parent.network_id != callerNetId", () => {
    // Network A: a task that should NEVER receive a foreign reply.
    const parentA = insertTask({
      from_name: "admin-a",
      to_name: "worker-a",
      network_id: "net-A",
      status: "delivered",
    });
    // Network B: a child task that maliciously names parentA as its
    // parent (the attack — possible because send_task wrote a row,
    // and B controls the parent_task_id field of its own dispatch
    // when the F2 #2 guard isn't in place either).
    const childB = insertTask({
      from_name: "attacker-b",
      to_name: "victim-b",
      network_id: "net-B",
      status: "replied",
      parent_task_id: parentA,
    });

    // Caller is in network B (effectiveNetId = "net-B"). The chain
    // walks child → parentA, finds parent.network_id="net-A" !=
    // caller="net-B", refuses to write.
    chainReplyToParent(childB, "INJECTED PAYLOAD", "replied", 5, "net-B");

    const after = getTask(parentA);
    expect(after?.result).toBeNull();        // result NOT polluted
    expect(after?.status).toBe("delivered"); // status NOT bumped
    expect(countInbox("admin-a")).toBe(0);   // no rogue inbox row
  });

  test("legitimate same-network chain still works", () => {
    const parentB = insertTask({
      from_name: "admin-b",
      to_name: "worker-b",
      network_id: "net-B",
      status: "delivered",
    });
    const childB = insertTask({
      from_name: "child-b",
      to_name: "leaf-b",
      network_id: "net-B",
      status: "replied",
      parent_task_id: parentB,
    });

    chainReplyToParent(childB, "legitimate result", "replied", 5, "net-B");

    const after = getTask(parentB);
    expect(after?.result).toContain("legitimate result");
    expect(after?.status).toBe("replied");
    expect(countInbox("admin-b")).toBe(1);
  });

  test("default-network (null) caller cannot chain into named network", () => {
    const parentNamed = insertTask({
      from_name: "admin-x",
      to_name: "worker-x",
      network_id: "net-X",
      status: "delivered",
    });
    const childDefault = insertTask({
      from_name: "stray",
      to_name: "leaf",
      network_id: null,
      status: "replied",
      parent_task_id: parentNamed,
    });

    chainReplyToParent(childDefault, "stray payload", "replied", 5, null);

    expect(getTask(parentNamed)?.result).toBeNull();
    expect(countInbox("admin-x")).toBe(0);
  });

  test("named-network caller cannot chain into default-network parent", () => {
    const parentDefault = insertTask({
      from_name: "admin-default",
      to_name: "worker-default",
      network_id: null,
      status: "delivered",
    });
    const childNamed = insertTask({
      from_name: "named",
      to_name: "leaf",
      network_id: "net-Y",
      status: "replied",
      parent_task_id: parentDefault,
    });

    chainReplyToParent(childNamed, "named payload", "replied", 5, "net-Y");

    expect(getTask(parentDefault)?.result).toBeNull();
    expect(countInbox("admin-default")).toBe(0);
  });

  test("recursive chain stops at the first cross-network boundary", () => {
    // 3-level chain: grandparent (net-A) ← parent (net-B) ← child (net-B)
    // Caller B replies. F2 #3 should write into parent (same net) but
    // refuse to recurse into grandparent (foreign net).
    const grandparent = insertTask({
      from_name: "gp-admin",
      to_name: "gp-worker",
      network_id: "net-A",
      status: "delivered",
    });
    const parent = insertTask({
      from_name: "p-admin",
      to_name: "p-worker",
      network_id: "net-B",
      status: "delivered",
      parent_task_id: grandparent,
    });
    const child = insertTask({
      from_name: "c",
      to_name: "leaf",
      network_id: "net-B",
      status: "replied",
      parent_task_id: parent,
    });

    chainReplyToParent(child, "result", "replied", 5, "net-B");

    // Parent (same network) — chain wrote.
    expect(getTask(parent)?.result).toContain("result");
    expect(getTask(parent)?.status).toBe("replied");
    // Grandparent (foreign network) — chain refused.
    expect(getTask(grandparent)?.result).toBeNull();
    expect(getTask(grandparent)?.status).toBe("delivered");
    expect(countInbox("gp-admin")).toBe(0);
  });

  test("undefined callerNetId preserves legacy network-blind behaviour", () => {
    // Internal/server-only callers that have no tenant context can
    // still call chainReplyToParent without the enforcement (they
    // pass undefined). This is the back-compat escape hatch.
    const parent = insertTask({
      from_name: "internal-admin",
      to_name: "internal-worker",
      network_id: "net-A",
      status: "delivered",
    });
    const child = insertTask({
      from_name: "child",
      to_name: "leaf",
      network_id: "net-B",
      status: "replied",
      parent_task_id: parent,
    });

    chainReplyToParent(child, "legacy result", "replied"); // no callerNetId

    // Legacy behaviour: writes through regardless of network mismatch.
    // Documents the back-compat surface so a future tightening is a
    // deliberate decision.
    expect(getTask(parent)?.result).toContain("legacy result");
  });
});

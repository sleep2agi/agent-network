// Node-TMAI#4 — auto-chain: attempt identity, terminal-parent safety,
// dispatcher participation.
//
// This file is the trimmed re-implementation of PR #1940 on current main. The
// original candidate carried four coupled behavioural changes; two of them
// contradict decisions this repository made AFTER that candidate was written,
// so they are deliberately NOT implemented here:
//
//   * C — "an `acked` task must expire on its deadline". #519 (task-stale-open.ts)
//     owns this convergence and made it **activity-based and default-off** on
//     purpose: a Hub-wide TTL sweep of acked rows would close production history
//     the moment it ships. `patrolExpiredTasks` therefore keeps
//     `status IN ('created','delivered')`, and task-stale-open-http.test.ts pins
//     that an old acked row stays open while #519 is disabled.
//
//   * D(parent row) — "a child result must never complete its parent". #690
//     (scheduled-run-terminal.test.ts) is built on the opposite contract: a
//     scheduled/dispatched parent whose executor answers through a child must
//     reach a terminal state and carry its scheduler-run mirror with it.
//
//   * A — "never infer parent_task_id". #668 restored the inference on purpose
//     (`send_task` would otherwise lose the chain whenever a node forgets the id)
//     and narrowed it to `delivered` only.
//
// What IS implemented here, because it is a defect on current main and conflicts
// with nothing:
//
//   T) A TERMINAL parent used to be rewritten: its `result` was appended and its
//      `completed_at` moved forward long after it finished (observed: 22 minutes
//      later). The child result is still preserved as an audit row plus a notice
//      to the parent's author, but the parent row now stays byte-identical.
//   O) An OPEN parent is still completed by the chain — that is the #690
//      contract, pinned below so a future edit cannot quietly drop it.
//   R) One ATTEMPT of a child result is recorded against a parent at most once:
//      a replayed reply no longer fans out into a second audit row and a second
//      notice.
//   N) A fresh attempt of the same task — a legal retry, identified by its inbox
//      transport row — still gets through, even when both attempts complete in
//      the same second (`completed_at` has second granularity).
//   E) The de-dup key binds the ORIGIN of the result, not the walk position, so
//      a descendant notice cannot consume an ancestor's own completion slot.
//   P) A same-network caller may not adopt an unrelated third party's task as
//      its parent (`parent_not_participant`).

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db, chainReplyToParent, uuidv4 } from "./db.js";
import { registerTools } from "./tools.js";

const NET = "net_cpt_dedup";
const USER = "u_cpt_dedup";
const PEER = "cpt-peer";     // the session dispatching work outward
const TARGET = "cpt-target"; // the session receiving the dispatch
const BOSS = "cpt-boss";     // the originator who reads the answers
const THIRD = "cpt-third";   // a third party with no involvement

type Handler = (args: any, extra?: any) => Promise<{ content: Array<{ type: "text"; text: string }> }>;

function cleanup(): void {
  for (const table of ["task_events", "inbox", "scheduled_task_runs", "scheduled_tasks", "tasks", "sessions", "nodes", "network_members", "networks"]) {
    try { db.run(`DELETE FROM ${table} WHERE network_id = ?1`, [NET]); } catch {}
  }
  try { db.run("DELETE FROM users WHERE user_id = ?1", [USER]); } catch {}
}

function seed(): void {
  db.run("INSERT INTO users (user_id, username, password_hash, role, created_at) VALUES (?1, ?2, 'x', 'user', datetime('now'))", [USER, USER]);
  db.run("INSERT INTO networks (network_id, network_name, owner_id, created_at) VALUES (?1, ?1, ?2, datetime('now'))", [NET, USER]);
  db.run("INSERT INTO network_members (user_id, network_id, role, joined_at) VALUES (?1, ?2, 'owner', datetime('now'))", [USER, NET]);
  for (const alias of [PEER, TARGET, BOSS, THIRD]) {
    db.run(
      `INSERT INTO nodes (node_id, node_name, alias, network_id, lifecycle_state)
       VALUES (?1, ?2, ?2, ?3, 'active')`,
      [`n_${alias}`, alias, NET],
    );
    db.run(
      `INSERT INTO sessions (resume_id, alias, status, node_id, network_id, updated_at, last_seen_at)
       VALUES (?1, ?2, 'idle', ?3, ?4, datetime('now'), datetime('now'))`,
      [`r_${alias}`, alias, `n_${alias}`, NET],
    );
  }
}

function handlers(): Record<string, Handler> {
  const server = new McpServer({ name: "test-cpt-dedup", version: "0" }) as any;
  const out: Record<string, Handler> = {};
  const original = server.tool.bind(server);
  server.tool = (name: string, ...args: any[]) => {
    const h = args.at(-1);
    if (typeof h === "function") out[name] = h;
    return original(name, ...args);
  };
  registerTools(server, undefined, NET, USER, PEER, false, null);
  return out;
}

async function call(handler: Handler, args: any): Promise<any> {
  const r = await handler(args);
  return JSON.parse(r.content[0].text);
}

function insertTask(o: {
  task_id?: string;
  from_name: string;
  to_name: string;
  status: string;
  content: string;
  parent_task_id?: string | null;
  result?: string | null;
  completed_at?: string | null;
  expires_at?: string | null;
}): string {
  const id = o.task_id ?? uuidv4();
  db.run(
    `INSERT INTO tasks
       (task_id, from_name, to_name, priority, status, content, requires_response,
        created_at, network_id, parent_task_id, result, completed_at, expires_at)
     VALUES (?1, ?2, ?3, 'normal', ?4, ?5, 'reply', datetime('now'), ?6, ?7, ?8, ?9, ?10)`,
    [id, o.from_name, o.to_name, o.status, o.content, NET, o.parent_task_id ?? null, o.result ?? null, o.completed_at ?? null, o.expires_at ?? null],
  );
  return id;
}

/** A dispatch is identified by its inbox transport row — the same identity the
 *  chain uses as its attempt key. Tests that want a "fresh attempt" insert one. */
function insertTransport(taskId: string, to = TARGET, body = "dispatch"): string {
  const id = `tr_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  db.run(
    `INSERT INTO inbox (id, session_name, type, priority, content, from_session, task_id, requires_response, network_id)
     VALUES (?1, ?2, 'task', 'normal', ?3, ?4, ?5, 'reply', ?6)`,
    [id, to, body, PEER, taskId, NET],
  );
  return id;
}

const taskById = (id: string) =>
  db.get<{ status: string; result: string | null; completed_at: string | null; parent_task_id: string | null }>(
    "SELECT status, result, completed_at, parent_task_id FROM tasks WHERE task_id = ?1", id);

/** Audit rows this path appends to a parent (either shape). */
const chainEvents = (parentId: string) =>
  db.get<{ c: number }>(
    "SELECT COUNT(*) AS c FROM task_events WHERE task_id = ?1 AND actor IN ('auto-chain','auto-chain-append')", parentId)?.c ?? 0;

const childNotices = (childText: string) =>
  db.get<{ c: number }>(
    "SELECT COUNT(*) AS c FROM inbox WHERE content LIKE ?1", `%${childText}%`)?.c ?? 0;

beforeEach(() => { cleanup(); seed(); });
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────
// T — a terminal parent is never rewritten
// ─────────────────────────────────────────────────────────────────────

describe("T — a terminal parent stays byte-identical", () => {
  const TERMINAL = ["replied", "failed", "cancelled", "expired"];

  for (const state of TERMINAL) {
    test(`parent status=${state}: status/result/completed_at unchanged; child result recorded`, () => {
      const ORIGINAL = `ORIGINAL-${state}-ANSWER`;
      const STAMP = "2026-01-01 00:00:00";
      const parent = insertTask({
        from_name: BOSS, to_name: PEER, status: state, content: `cpt-t parent in ${state}`,
        result: ORIGINAL, completed_at: STAMP,
      });
      const child = insertTask({
        from_name: PEER, to_name: TARGET, status: "replied",
        content: `cpt-t child for ${state}`, parent_task_id: parent,
      });
      insertTransport(child);

      const res = chainReplyToParent(child, `CHILD-ANSWER-FOR-${state}`, "replied", 5, NET);

      const after = taskById(parent);
      expect(after?.status).toBe(state);
      expect(after?.result).toBe(ORIGINAL);
      expect(after?.completed_at).toBe(STAMP);

      // Preserved as an audit row plus a notice — never as the parent's answer.
      expect(res.chained).toBe(true);
      expect(chainEvents(parent)).toBe(1);
      expect(childNotices(`CHILD-ANSWER-FOR-${state}`)).toBe(1);
    });
  }

  test("a terminal parent with a NULL result does not gain one", () => {
    const parent = insertTask({
      from_name: BOSS, to_name: PEER, status: "cancelled", content: "cpt-t cancelled parent",
      result: null, completed_at: "2026-02-02 02:02:02",
    });
    const child = insertTask({
      from_name: PEER, to_name: TARGET, status: "replied",
      content: "cpt-t child of cancelled parent", parent_task_id: parent,
    });
    insertTransport(child);

    chainReplyToParent(child, "LATE-CHILD-ANSWER", "replied", 5, NET);

    const after = taskById(parent);
    expect(after?.status).toBe("cancelled");
    expect(after?.result).toBeNull();
    expect(after?.completed_at).toBe("2026-02-02 02:02:02");
  });
});

// ─────────────────────────────────────────────────────────────────────
// O — an OPEN parent is still completed by the chain (#690 contract)
// ─────────────────────────────────────────────────────────────────────

describe("O — an open parent is still completed by the chain (#690)", () => {
  for (const state of ["created", "delivered", "acked", "running"]) {
    test(`parent status=${state}: reaches replied with the child result`, () => {
      const parent = insertTask({
        from_name: BOSS, to_name: PEER, status: state, content: `cpt-o parent in ${state}`,
      });
      const child = insertTask({
        from_name: PEER, to_name: TARGET, status: "replied",
        content: `cpt-o child for ${state}`, parent_task_id: parent,
      });
      insertTransport(child);

      chainReplyToParent(child, `OPEN-CHILD-${state}`, "replied", 5, NET);

      const after = taskById(parent);
      expect(after?.status).toBe("replied");
      expect(after?.result).toContain(`OPEN-CHILD-${state}`);
      expect(after?.completed_at).toBeTruthy();
      expect(chainEvents(parent)).toBe(1);
      expect(childNotices(`OPEN-CHILD-${state}`)).toBe(1);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────
// R — one attempt is recorded at most once
// ─────────────────────────────────────────────────────────────────────

describe("R — a replayed delivery does not fan out twice", () => {
  test("same attempt replayed: one audit row, one notice, second call not chained", () => {
    const parent = insertTask({
      from_name: BOSS, to_name: PEER, status: "delivered", content: "cpt-r replay parent",
    });
    const child = insertTask({
      from_name: PEER, to_name: TARGET, status: "replied",
      content: "cpt-r replay child", parent_task_id: parent,
    });
    insertTransport(child);

    const first = chainReplyToParent(child, "REPLAY-ANSWER", "replied", 5, NET);
    const second = chainReplyToParent(child, "REPLAY-ANSWER", "replied", 5, NET);

    expect(first.chained).toBe(true);
    expect(second.chained).toBe(false);
    expect(chainEvents(parent)).toBe(1);
    expect(childNotices("REPLAY-ANSWER")).toBe(1);
  });

  test("a terminal parent dedups its audit row too", () => {
    const parent = insertTask({
      from_name: BOSS, to_name: PEER, status: "replied", content: "cpt-r terminal parent",
      result: "ALREADY-ANSWERED", completed_at: "2026-03-03 03:03:03",
    });
    const child = insertTask({
      from_name: PEER, to_name: TARGET, status: "replied",
      content: "cpt-r terminal child", parent_task_id: parent,
    });
    insertTransport(child);

    expect(chainReplyToParent(child, "TERMINAL-REPLAY", "replied", 5, NET).chained).toBe(true);
    expect(chainReplyToParent(child, "TERMINAL-REPLAY", "replied", 5, NET).chained).toBe(false);
    expect(chainEvents(parent)).toBe(1);
    expect(childNotices("TERMINAL-REPLAY")).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// N — a NEW attempt is not swallowed, even in the same second
// ─────────────────────────────────────────────────────────────────────

describe("N — a legal second attempt keeps its own notice", () => {
  test("retry queues a new transport row → the second result still records", () => {
    const parent = insertTask({
      from_name: BOSS, to_name: PEER, status: "delivered", content: "cpt-n retry parent",
    });
    const child = insertTask({
      from_name: PEER, to_name: TARGET, status: "replied",
      content: "cpt-n retry child", parent_task_id: parent,
    });
    insertTransport(child);

    expect(chainReplyToParent(child, "ATTEMPT-ONE", "replied", 5, NET).chained).toBe(true);

    // retry_task: reset the task, then queue a fresh transport row (same
    // transaction, new row). Both attempts carry the same second-granularity
    // delivery stamp — the transport row is what tells them apart.
    db.run(
      "UPDATE tasks SET status = 'replied', result = NULL, completed_at = '2026-04-04 04:04:04' WHERE task_id = ?1",
      [child],
    );
    insertTransport(child, TARGET, "retry dispatch");
    db.run(
      "UPDATE tasks SET status = 'replied', result = NULL, completed_at = '2026-04-04 04:04:04' WHERE task_id = ?1",
      [child],
    );

    expect(chainReplyToParent(child, "ATTEMPT-TWO", "replied", 5, NET).chained).toBe(true);
    expect(childNotices("ATTEMPT-ONE")).toBe(1);
    expect(childNotices("ATTEMPT-TWO")).toBe(1);
    expect(chainEvents(parent)).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────
// E — the key binds the ORIGIN, not the walk position
// ─────────────────────────────────────────────────────────────────────

describe("E — a descendant notice does not consume the executor's own completion", () => {
  test("grandparent ← parent ← leaf: leaf notice then parent completion both record", () => {
    const grandparent = insertTask({
      from_name: BOSS, to_name: PEER, status: "delivered", content: "cpt-e grandparent",
    });
    const parent = insertTask({
      from_name: PEER, to_name: THIRD, status: "running",
      content: "cpt-e parent", parent_task_id: grandparent,
    });
    const leaf = insertTask({
      from_name: THIRD, to_name: TARGET, status: "replied",
      content: "cpt-e leaf", parent_task_id: parent,
    });
    insertTransport(leaf);
    insertTransport(parent, THIRD, "parent dispatch");

    // (1) the leaf answers the parent; the notice also walks up to the
    //     grandparent.
    const early = chainReplyToParent(leaf, "LEAF-EARLY", "replied", 5, NET);
    expect(early.chained).toBe(true);
    // Two hops carry the same reply: one notice to the parent's author and
    // one to the grandparent's author.
    expect(childNotices("LEAF-EARLY")).toBe(2);
    const afterLeaf = chainEvents(grandparent);

    // (2) the parent — a real executor — now finishes for real.
    const result = chainReplyToParent(parent, "PARENT-FINAL", "replied", 5, NET);
    expect(result.chained).toBe(true);
    expect(childNotices("PARENT-FINAL")).toBe(1);

    // The parent's own completion is a different event from the descendant
    // notice that already reached the grandparent.
    expect(chainEvents(grandparent)).toBe(afterLeaf + 1);
  });

  test("two different leaves under one parent each keep their own notice", () => {
    const parent = insertTask({
      from_name: BOSS, to_name: PEER, status: "delivered", content: "cpt-e shared parent",
    });
    const firstLeaf = insertTask({
      from_name: PEER, to_name: TARGET, status: "replied",
      content: "cpt-e leaf one", parent_task_id: parent,
    });
    const secondLeaf = insertTask({
      from_name: PEER, to_name: THIRD, status: "replied",
      content: "cpt-e leaf two", parent_task_id: parent,
    });
    insertTransport(firstLeaf);
    insertTransport(secondLeaf, THIRD, "second leaf dispatch");

    expect(chainReplyToParent(firstLeaf, "LEAF-ONE", "replied", 5, NET).chained).toBe(true);
    expect(chainReplyToParent(secondLeaf, "LEAF-TWO", "replied", 5, NET).chained).toBe(true);

    expect(childNotices("LEAF-ONE")).toBe(1);
    expect(childNotices("LEAF-TWO")).toBe(1);
    expect(chainEvents(parent)).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────
// P — an explicit parent requires a participation relation
// ─────────────────────────────────────────────────────────────────────

describe("P — explicit parent requires a participation relation", () => {
  test("a third party's task cannot be adopted as parent", async () => {
    const stranger = insertTask({
      from_name: BOSS, to_name: THIRD, status: "delivered",
      content: "cpt-p a task between other parties",
    });

    const reply = await call(handlers().send_task, {
      alias: TARGET,
      task: "cpt-p attempt to adopt a stranger parent",
      priority: "normal",
      from_session: PEER,
      network_id: NET,
      parent_task_id: stranger,
    });

    expect(reply.ok).toBe(false);
    expect(reply.error).toBe("parent_not_participant");
    const spawned = db.get<{ c: number }>(
      "SELECT COUNT(*) AS c FROM tasks WHERE content = ?1",
      "cpt-p attempt to adopt a stranger parent",
    );
    expect(spawned?.c).toBe(0);
    expect(taskById(stranger)?.status).toBe("delivered");
  });

  test("the parent's own originator may chain a follow-up onto it", async () => {
    const parent = insertTask({
      from_name: PEER, to_name: THIRD, status: "delivered",
      content: "cpt-p parent dispatched by the peer",
    });

    const reply = await call(handlers().send_task, {
      alias: TARGET,
      task: "cpt-p originator follow-up",
      priority: "normal",
      from_session: PEER,
      network_id: NET,
      parent_task_id: parent,
    });
    expect(reply.ok).toBe(true);
    const child = db.get<{ parent_task_id: string | null }>(
      "SELECT parent_task_id FROM tasks WHERE content = ?1", "cpt-p originator follow-up");
    expect(child?.parent_task_id).toBe(parent);
  });

  test("a cross-network parent is still refused with its own error code", async () => {
    const foreign = uuidv4();
    db.run(
      `INSERT INTO tasks (task_id, from_name, to_name, priority, status, content, requires_response, created_at, network_id)
       VALUES (?1, ?2, ?3, 'normal', 'delivered', 'cpt-p foreign parent', 'reply', datetime('now'), ?4)`,
      [foreign, BOSS, THIRD, "net_other_cpt"],
    );

    const reply = await call(handlers().send_task, {
      alias: TARGET,
      task: "cpt-p cross-network parent attempt",
      priority: "normal",
      from_session: PEER,
      network_id: NET,
      parent_task_id: foreign,
    });
    expect(reply.ok).toBe(false);
    expect(reply.error).toBe("cross_network_parent");
    db.run("DELETE FROM tasks WHERE task_id = ?1", [foreign]);
  });
});

// Node-TMAI#4 — auto-chain parent inference, terminal-parent rewrite,
// acked convergence, and dispatcher participation.
//
// Four defects on one hub code path, pinned red-first:
//
//  A) tools.ts `send_task` INFERS `parent_task_id` from "the caller's most
//     recent delivered/started inbox task" when the caller omits it. The
//     inference is blind to *who the child is actually answering*, so on a
//     session with two concurrent open tasks the child is attached to
//     whichever was dispatched last.
//  B) db.ts `chainReplyToParent` rewrites a parent row when a child result
//     arrives: an open parent is bumped to `replied` (with the child text as
//     its `result`) and an already-terminal parent has its `result` +
//     `completed_at` overwritten. Neither is a completion signal.
//  C) A task parked in `acked` has no convergence exit: `patrolExpiredTasks`
//     sweeps only created/delivered, so an acked row never expires.
//  D) `send_task` accepted any same-network `parent_task_id`, so a caller
//     could attach its dispatch to a third party's task and later surface
//     the child result to that third party's originator.
//
// Run: COMMHUB_DB=/tmp/chain-parent-terminal.db bun test src/chain-parent-terminal.test.ts

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db, uuidv4, chainReplyToParent } from "./db.js";
import { registerTools } from "./tools.js";
import { patrolExpiredTasks } from "./server.js";

const NET = "net_chain_parent_terminal";
const USER = "u_cpt_owner";
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
  const server = new McpServer({ name: "test-cpt", version: "0" }) as any;
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

const taskById = (id: string) =>
  db.get<{ status: string; result: string | null; completed_at: string | null; parent_task_id: string | null }>(
    "SELECT status, result, completed_at, parent_task_id FROM tasks WHERE task_id = ?1", id);

// `auto-chain-append` is recorded as the event ACTOR; `event_type` is derived
// from the parent's status. Count the audit rows this path appends.
const chainEvents = (parentId: string) =>
  db.get<{ c: number }>(
    "SELECT COUNT(*) AS c FROM task_events WHERE task_id = ?1 AND actor = 'auto-chain-append'", parentId)?.c ?? 0;

const childNotices = (childText: string) =>
  db.get<{ c: number }>(
    "SELECT COUNT(*) AS c FROM inbox WHERE content LIKE ?1", `%${childText}%`)?.c ?? 0;

beforeEach(() => { cleanup(); seed(); });
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────
// A — parent_task_id must be explicit; no "most recent open inbox" capture
// ─────────────────────────────────────────────────────────────────────

describe("A — send_task must not infer parent_task_id from the inbox", () => {
  test("no parent_task_id passed → child stays unparented, unrelated open task is untouched", async () => {
    const unrelated = insertTask({
      from_name: BOSS, to_name: PEER, status: "delivered",
      content: "cpt-a unrelated inbound item, still open",
    });

    const reply = await call(handlers().send_task, {
      alias: TARGET,
      task: "cpt-a dispatch with no explicit parent",
      priority: "normal",
      from_session: PEER,
      network_id: NET,
    });
    expect(reply.ok).toBe(true);

    const child = db.get<{ parent_task_id: string | null }>(
      "SELECT parent_task_id FROM tasks WHERE content = ?1",
      "cpt-a dispatch with no explicit parent",
    );
    expect(child?.parent_task_id).toBeNull();
    expect(taskById(unrelated)?.status).toBe("delivered");
  });

  test("two concurrent open tasks for the same dispatcher: a parentless dispatch links to neither", async () => {
    const first = insertTask({
      from_name: BOSS, to_name: PEER, status: "delivered", content: "cpt-a concurrent #1",
    });
    const second = insertTask({
      from_name: THIRD, to_name: PEER, status: "delivered", content: "cpt-a concurrent #2",
    });

    const reply = await call(handlers().send_task, {
      alias: TARGET,
      task: "cpt-a dispatch among two concurrent parents",
      priority: "normal",
      from_session: PEER,
      network_id: NET,
    });
    expect(reply.ok).toBe(true);

    const child = db.get<{ parent_task_id: string | null }>(
      "SELECT parent_task_id FROM tasks WHERE content = ?1",
      "cpt-a dispatch among two concurrent parents",
    );
    expect(child?.parent_task_id).toBeNull();
    expect(taskById(first)?.status).toBe("delivered");
    expect(taskById(second)?.status).toBe("delivered");
  });

  test("an explicit parent_task_id is still honoured when the dispatcher is a party", async () => {
    const parent = insertTask({
      from_name: BOSS, to_name: PEER, status: "delivered",
      content: "cpt-a explicit parent",
    });

    const reply = await call(handlers().send_task, {
      alias: TARGET,
      task: "cpt-a dispatch with explicit parent",
      priority: "normal",
      from_session: PEER,
      network_id: NET,
      parent_task_id: parent,
    });
    expect(reply.ok).toBe(true);

    const child = db.get<{ parent_task_id: string | null }>(
      "SELECT parent_task_id FROM tasks WHERE content = ?1",
      "cpt-a dispatch with explicit parent",
    );
    expect(child?.parent_task_id).toBe(parent);
  });
});

// ─────────────────────────────────────────────────────────────────────
// D — same-network is not enough: the dispatcher must be a party to the
//     parent (its originator or its assignee).
// ─────────────────────────────────────────────────────────────────────

describe("D — explicit parent requires a participation relation", () => {
  test("a third party's task cannot be adopted as parent", async () => {
    const stranger = insertTask({
      from_name: BOSS, to_name: THIRD, status: "delivered",
      content: "cpt-d a task between other parties",
    });

    const reply = await call(handlers().send_task, {
      alias: TARGET,
      task: "cpt-d attempt to adopt a stranger parent",
      priority: "normal",
      from_session: PEER,
      network_id: NET,
      parent_task_id: stranger,
    });

    expect(reply.ok).toBe(false);
    expect(reply.error).toBe("parent_not_participant");
    const spawned = db.get<{ c: number }>(
      "SELECT COUNT(*) AS c FROM tasks WHERE content = ?1",
      "cpt-d attempt to adopt a stranger parent",
    );
    expect(spawned?.c).toBe(0);
    expect(taskById(stranger)?.status).toBe("delivered");
  });

  test("the parent's own originator may chain a follow-up onto it", async () => {
    const parent = insertTask({
      from_name: PEER, to_name: THIRD, status: "delivered",
      content: "cpt-d parent dispatched by the peer",
    });

    const reply = await call(handlers().send_task, {
      alias: TARGET,
      task: "cpt-d originator follow-up",
      priority: "normal",
      from_session: PEER,
      network_id: NET,
      parent_task_id: parent,
    });
    expect(reply.ok).toBe(true);
    const child = db.get<{ parent_task_id: string | null }>(
      "SELECT parent_task_id FROM tasks WHERE content = ?1", "cpt-d originator follow-up");
    expect(child?.parent_task_id).toBe(parent);
  });

  test("a cross-network parent is still refused with its own error code", async () => {
    // Parent in a different network: existence + cross-network error must
    // not be masked by the participation check.
    const foreign = uuidv4();
    db.run(
      `INSERT INTO tasks (task_id, from_name, to_name, priority, status, content, requires_response, created_at, network_id)
       VALUES (?1, ?2, ?3, 'normal', 'delivered', 'cpt-d foreign parent', 'reply', datetime('now'), ?4)`,
      [foreign, BOSS, THIRD, "net_other_cpt"],
    );

    const reply = await call(handlers().send_task, {
      alias: TARGET,
      task: "cpt-d cross-network parent attempt",
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

// ─────────────────────────────────────────────────────────────────────
// B — a child result must NEVER complete or rewrite its parent
// ─────────────────────────────────────────────────────────────────────

describe("B — chainReplyToParent leaves the parent row byte-identical", () => {
  const OPEN_STATES = ["created", "delivered", "acked", "running"];
  const TERMINAL_STATES = ["replied", "failed", "cancelled", "expired"];

  for (const state of [...OPEN_STATES, ...TERMINAL_STATES]) {
    test(`parent status=${state}: status/result/completed_at unchanged; child result recorded`, () => {
      const ORIGINAL = `ORIGINAL-${state}-ANSWER`;
      const STAMP = state === "replied" ? "2026-01-01 00:00:00" : null;
      const parent = insertTask({
        from_name: BOSS, to_name: PEER, status: state, content: `cpt-b parent in ${state}`,
        result: state === "replied" ? ORIGINAL : null, completed_at: STAMP,
      });
      const child = insertTask({
        from_name: PEER, to_name: TARGET, status: "replied",
        content: `cpt-b child for ${state}`, parent_task_id: parent,
      });

      const res = chainReplyToParent(child, `CHILD-ANSWER-FOR-${state}`, "replied", 5, NET);

      const after = taskById(parent);
      expect(after?.status).toBe(state);
      expect(after?.result).toBe(state === "replied" ? ORIGINAL : null);
      expect(after?.completed_at).toBe(STAMP);

      // The child result is preserved: an audit row plus a notice to the
      // parent's originator, neither of which is a completion of the parent.
      expect(res.chained).toBe(true);
      expect(chainEvents(parent)).toBe(1);
      expect(childNotices(`CHILD-ANSWER-FOR-${state}`)).toBe(1);
    });
  }

  test("a nested chain does not propagate completion to any ancestor", () => {
    const grandparent = insertTask({
      from_name: BOSS, to_name: PEER, status: "delivered", content: "cpt-b grandparent",
    });
    const parent = insertTask({
      from_name: PEER, to_name: THIRD, status: "delivered",
      content: "cpt-b mid parent", parent_task_id: grandparent,
    });
    const child = insertTask({
      from_name: THIRD, to_name: TARGET, status: "replied",
      content: "cpt-b leaf", parent_task_id: parent,
    });

    chainReplyToParent(child, "LEAF-ANSWER", "replied", 5, NET);

    expect(taskById(parent)?.status).toBe("delivered");
    expect(taskById(parent)?.result).toBeNull();
    expect(taskById(grandparent)?.status).toBe("delivered");
    expect(taskById(grandparent)?.result).toBeNull();
  });

  test("a replayed reply does not fan out into a second event or notice", () => {
    const parent = insertTask({
      from_name: BOSS, to_name: PEER, status: "delivered", content: "cpt-b replay parent",
    });
    const child = insertTask({
      from_name: PEER, to_name: TARGET, status: "replied",
      content: "cpt-b replay child", parent_task_id: parent,
    });

    const first = chainReplyToParent(child, "REPLAY-ANSWER", "replied", 5, NET);
    const second = chainReplyToParent(child, "REPLAY-ANSWER", "replied", 5, NET);

    expect(first.chained).toBe(true);
    expect(second.chained).toBe(false);
    expect(chainEvents(parent)).toBe(1);
    expect(childNotices("REPLAY-ANSWER")).toBe(1);
    expect(taskById(parent)?.status).toBe("delivered");
  });

  test("cross-network parent still refuses and stays unmodified", () => {
    const foreign = insertTask({
      from_name: "other-boss", to_name: "other-peer", status: "delivered",
      content: "cpt-b foreign parent",
    });
    db.run("UPDATE tasks SET network_id = 'net_other_cpt' WHERE task_id = ?1", [foreign]);
    const child = insertTask({
      from_name: PEER, to_name: TARGET, status: "replied",
      content: "cpt-b child pointing cross-net", parent_task_id: foreign,
    });

    const res = chainReplyToParent(child, "XTENANT-ANSWER", "replied", 5, NET);
    expect(res.chained).toBe(false);
    expect(res.stoppedReason).toBe("cross_network");
    expect(taskById(foreign)?.status).toBe("delivered");
    expect(chainEvents(foreign)).toBe(0);
    db.run("DELETE FROM tasks WHERE task_id = ?1", [foreign]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// C — `acked` needs a convergence exit
// ─────────────────────────────────────────────────────────────────────

describe("C — an acked task past its deadline must converge", () => {
  test("acked + expires_at in the past is swept to expired", () => {
    const t = insertTask({
      from_name: BOSS, to_name: PEER, status: "acked",
      content: "cpt-c acked and abandoned", expires_at: "2026-01-01 00:00:00",
    });
    patrolExpiredTasks();
    expect(taskById(t)?.status).toBe("expired");
  });

  test("acked without expires_at is left alone", () => {
    const t = insertTask({
      from_name: BOSS, to_name: PEER, status: "acked",
      content: "cpt-c acked with no deadline",
    });
    patrolExpiredTasks();
    expect(taskById(t)?.status).toBe("acked");
  });
});

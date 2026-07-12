// RFC-030 Wave 1B L1 — principal matrix driven through the REAL MCP
// handlers (registerTools → send_task / send_reply / retry_task /
// reassign_task), per 副指挥拍板 2026-07-12:
//
//   role union owner/admin/member/viewer/node/child, resolved ONLY from
//   the server auth context (token kind + network_members / users) + the
//   call's effectiveNetId:
//     utok            → network_members.role in effectiveNetId
//     global admin    → 'admin' when crossing networks (users.role)
//     plain ntok      → 'node' (NEVER the owner's network role)
//     RFC-026 child   → 'child' (api_tokens.role written only by mint)
//     legacy/no token → null (gateway alone fail-closes)
//   alias/from_session is display-only and never affects the principal.
//
//   tasks carry a write-once immutable ORIGIN principal; retry/reassign
//   INHERIT it and keep canonical_task_id = the original tasks.task_id
//   while the fresh inbox row id is the new delivery-attempt messageId.
//
//   The gateway pump (agent-node) enqueues taskId=canonical_task_id /
//   messageId=row.id, allowlists type='task', and dead-letters invalid-
//   principal rows (ack + mark failed + audit, NEVER replying to the
//   display alias) so poisoned rows cannot starve the LIMIT window.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tmpDb = join(mkdtempSync(join(tmpdir(), "rfc030-handler-")), "test.db");
process.env.COMMHUB_DB = tmpDb;

const { db } = await import("./db");
const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { registerTools } = await import("./tools");
const { resolveSenderPrincipal } = await import("./principal");
const { senderFromInboxRow } = await import(
  "../../agent-node/src/runtime/codex-policy-gateway/bridge-adapter"
);
const { pumpInboxBatch } = await import(
  "../../agent-node/src/runtime/codex-policy-gateway/inbox-pump"
);

const NET = "net_stamp_h";
const U_OWNER = "u_stamp_owner";
const U_MEMBER = "u_stamp_member";
const U_VIEWER = "u_stamp_viewer";
const U_GADMIN = "u_stamp_gadmin"; // global system admin, NOT a member
const U_OUTSIDER = "u_stamp_outsider"; // no membership, not admin

const TOK = {
  utokOwner: "tok_h_utok_owner",
  utokMember: "tok_h_utok_member",
  utokViewer: "tok_h_utok_viewer",
  utokGadmin: "tok_h_utok_gadmin",
  utokOutsider: "tok_h_utok_outsider",
  ntok: "tok_h_ntok_node", // owned by U_OWNER — must still stamp 'node'
  child: "tok_h_child",
  legacyFull: "tok_h_full_legacy",
} as const;

const TARGET = "stamp-target";
const CALLER = "stamp-caller";
const DIRECTOR = "stamp-director"; // human-ish display alias

interface ToolHandler {
  (args: Record<string, unknown>, extra?: unknown): Promise<{
    content: Array<{ type: "text"; text: string }>;
  }>;
}

beforeAll(() => {
  const users: Array<[string, string, string]> = [
    [U_OWNER, "stamp-owner", "user"],
    [U_MEMBER, "stamp-member", "user"],
    [U_VIEWER, "stamp-viewer", "user"],
    [U_GADMIN, "stamp-gadmin", "admin"],
    [U_OUTSIDER, "stamp-outsider", "user"],
  ];
  for (const [id, name, role] of users) {
    db.run(
      `INSERT INTO users (user_id, username, password_hash, role) VALUES (?1, ?2, 'x', ?3)`,
      [id, name, role],
    );
  }
  db.run(
    `INSERT INTO networks (network_id, network_name, owner_id) VALUES (?1, 'stamp-net', ?2)`,
    [NET, U_OWNER],
  );
  for (const [uid, role] of [
    [U_OWNER, "owner"],
    [U_MEMBER, "member"],
    [U_VIEWER, "viewer"],
  ] as const) {
    db.run(
      `INSERT INTO network_members (network_id, user_id, role) VALUES (?1, ?2, ?3)`,
      [NET, uid, role],
    );
  }
  // Tokens — kind is carried by scope (+ role='child' for RFC-026 mint).
  const tokens: Array<[string, string, string | null, string, string | null]> = [
    // [token_id, user_id, network_id, scope, role]
    [TOK.utokOwner, U_OWNER, null, "user", null],
    [TOK.utokMember, U_MEMBER, null, "user", null],
    [TOK.utokViewer, U_VIEWER, null, "user", null],
    [TOK.utokGadmin, U_GADMIN, null, "user", null],
    [TOK.utokOutsider, U_OUTSIDER, null, "user", null],
    [TOK.ntok, U_OWNER, NET, "network", null], // owner's node token
    [TOK.child, U_OWNER, NET, "network", "child"],
    [TOK.legacyFull, U_OWNER, NET, "full", null],
  ];
  for (const [tid, uid, nid, scope, role] of tokens) {
    db.run(
      `INSERT INTO api_tokens (token_id, token_hash, user_id, network_id, name, scope, role)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      [tid, `h_${tid}`, uid, nid, tid, scope, role],
    );
  }
  for (const alias of [CALLER, TARGET, DIRECTOR]) {
    db.run(
      `INSERT INTO sessions (resume_id, alias, network_id, last_seen_at, status)
       VALUES (?1, ?2, ?3, datetime('now'), 'idle')`,
      [`s_${alias}`, alias, NET],
    );
  }
});

afterAll(() => {
  // isolated tmp DB — nothing to restore
});

function buildHandlers(opts: {
  callerAlias?: string | null;
  callerTokenIsNetwork?: boolean;
  callerTokenId?: string | null;
}): Record<string, ToolHandler> {
  const server = new McpServer({ name: "test", version: "0" }) as unknown as {
    tool: (...a: unknown[]) => unknown;
  };
  const tools: Record<string, ToolHandler> = {};
  const origTool = (server.tool as (...a: unknown[]) => unknown).bind(server);
  server.tool = (name: string, desc: string, schema: unknown, handler: ToolHandler) => {
    tools[name] = handler;
    return origTool(name, desc, schema, handler);
  };
  registerTools(
    server as never,
    undefined,
    NET,
    U_OWNER,
    opts.callerAlias ?? null,
    opts.callerTokenIsNetwork ?? false,
    opts.callerTokenId ?? null,
  );
  return tools;
}

async function call(h: ToolHandler, args: Record<string, unknown>) {
  const r = await h(args);
  return JSON.parse(r.content[0].text) as Record<string, unknown>;
}

let seq = 0;
async function sendTask(tokenId: string | null, opts: {
  from?: string;
  callerAlias?: string | null;
  callerTokenIsNetwork?: boolean;
  content?: string;
} = {}) {
  const tools = buildHandlers({
    callerTokenId: tokenId,
    callerAlias: opts.callerAlias ?? null,
    callerTokenIsNetwork: opts.callerTokenIsNetwork ?? false,
  });
  const content = opts.content ?? `stamp-mx-${++seq}`;
  const r = await call(tools.send_task, {
    alias: TARGET,
    task: content,
    priority: "normal",
    from_session: opts.from ?? CALLER,
    network_id: NET,
  });
  const row = db.get<Record<string, unknown>>(
    `SELECT * FROM inbox WHERE session_name = ?1 AND content = ?2 AND network_id = ?3`,
    TARGET,
    content,
    NET,
  );
  return { r, row, content };
}

// ──────────────────────────────────────────────────────────────────────
// role authority matrix (real send_task handler)
// ──────────────────────────────────────────────────────────────────────

describe("L1 role authority — REAL send_task handler", () => {
  test("utok member/owner/viewer → network_members role; alias forge does NOT change it", async () => {
    for (const [tok, expected] of [
      [TOK.utokMember, "member"],
      [TOK.utokOwner, "owner"],
      [TOK.utokViewer, "viewer"],
    ] as const) {
      // forged display alias '指挥室' — allowed for utok (display-only)…
      const { r, row } = await sendTask(tok, { from: "指挥室" });
      expect(r.ok).toBe(true);
      expect(row!.from_session).toBe("指挥室");
      // …but the PRINCIPAL is resolved from auth ctx, alias-independent.
      expect(row!.sender_token_id).toBe(tok);
      expect(row!.sender_role).toBe(expected);
    }
  });

  test("plain ntok NEVER inherits its owner's 'owner' role → stamps 'node'", async () => {
    // TOK.ntok belongs to U_OWNER whose network_members role is 'owner'.
    const { r, row } = await sendTask(TOK.ntok, {
      callerAlias: CALLER,
      callerTokenIsNetwork: true,
    });
    expect(r.ok).toBe(true);
    expect(row!.sender_token_id).toBe(TOK.ntok);
    expect(row!.sender_role).toBe("node"); // NOT 'owner'
    const sender = senderFromInboxRow(row as never);
    expect(sender!.role).toBe("node");
  });

  test("ntok with bound alias + mismatched from_session → REFUSED, no insert", async () => {
    const { r, row } = await sendTask(TOK.ntok, {
      callerAlias: CALLER,
      callerTokenIsNetwork: true,
      from: "指挥室", // ≠ bound node identity → identity boundary violation
    });
    expect(r.ok).not.toBe(true);
    expect(row ?? null).toBeNull();
  });

  test("RFC-026 child token → 'child'", async () => {
    const { r, row } = await sendTask(TOK.child, {
      callerAlias: CALLER,
      callerTokenIsNetwork: true,
    });
    expect(r.ok).toBe(true);
    expect(row!.sender_role).toBe("child");
  });

  test("global system admin crossing a network they're not a member of → 'admin'", async () => {
    const { r, row } = await sendTask(TOK.utokGadmin, { from: DIRECTOR });
    expect(r.ok).toBe(true);
    expect(row!.sender_role).toBe("admin");
  });

  test("utok with NO membership and not admin → NULL principal, gateway refuses, delivery unaffected", async () => {
    const { r, row } = await sendTask(TOK.utokOutsider, { from: DIRECTOR });
    expect(r.ok).toBe(true); // ordinary delivery works
    expect(row!.sender_token_id ?? null).toBeNull();
    expect(row!.sender_role ?? null).toBeNull();
    expect(senderFromInboxRow(row as never)).toBeNull();
  });

  test("legacy 'full'-scope token → NULL principal (no guessing)", async () => {
    const { r, row } = await sendTask(TOK.legacyFull);
    expect(r.ok).toBe(true);
    expect(row!.sender_role ?? null).toBeNull();
  });

  test("no token at all → NULL principal", async () => {
    const { r, row } = await sendTask(null);
    expect(r.ok).toBe(true);
    expect(row!.sender_token_id ?? null).toBeNull();
    expect(senderFromInboxRow(row as never)).toBeNull();
  });

  test("bogus role smuggled into the column is refused by the gateway parser", () => {
    expect(
      senderFromInboxRow({
        id: "x1",
        from_session: "y",
        network_id: NET,
        sender_token_id: TOK.utokMember,
        sender_role: "superadmin",
      }),
    ).toBeNull();
    expect(
      senderFromInboxRow({
        id: "x2",
        from_session: "y",
        network_id: NET,
        sender_token_id: TOK.utokMember,
        sender_role: "unknown", // Δ12: 'unknown' NOT permitted on the wire
      }),
    ).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// write-once origin principal + canonical_task_id across retry/reassign
// ──────────────────────────────────────────────────────────────────────

describe("L1 origin principal + canonical_task_id — retry/reassign INHERIT", () => {
  test("send_task writes tasks.origin_*; retry by a DIFFERENT operator inherits it", async () => {
    const { r, content } = await sendTask(TOK.utokMember, { from: DIRECTOR });
    expect(r.ok).toBe(true);
    const taskId = (r.message_id ?? r.task_id) as string;

    const task0 = db.get<Record<string, unknown>>(
      "SELECT * FROM tasks WHERE task_id = ?1", taskId)!;
    expect(task0.origin_sender_token_id).toBe(TOK.utokMember);
    expect(task0.origin_sender_role).toBe("member");

    // Make it retryable, then retry as the GLOBAL ADMIN (different person).
    db.run("UPDATE tasks SET status = 'failed' WHERE task_id = ?1", [taskId]);
    const adminTools = buildHandlers({ callerTokenId: TOK.utokGadmin });
    const rr = await call(adminTools.retry_task, { task_id: taskId, from_session: DIRECTOR });
    expect(rr.ok).toBe(true);

    const requeued = db.get<Record<string, unknown>>(
      `SELECT * FROM inbox WHERE canonical_task_id = ?1 AND content = ?2 AND id != ?1`,
      taskId, content)!;
    expect(requeued).toBeDefined();
    // Inherited ORIGIN principal — not the admin retrier's.
    expect(requeued.sender_token_id).toBe(TOK.utokMember);
    expect(requeued.sender_role).toBe("member");
    // canonical stays the ORIGINAL task id; new inbox id is the messageId.
    expect(requeued.canonical_task_id).toBe(taskId);
    expect(requeued.id).not.toBe(taskId);
    // Origin on the task row is untouched (write-once).
    const task1 = db.get<Record<string, unknown>>(
      "SELECT origin_sender_token_id, origin_sender_role FROM tasks WHERE task_id = ?1", taskId)!;
    expect(task1.origin_sender_token_id).toBe(TOK.utokMember);
    expect(task1.origin_sender_role).toBe("member");
  });

  test("reassign by a different operator inherits origin principal + canonical id", async () => {
    const { r } = await sendTask(TOK.utokOwner, { from: DIRECTOR });
    const taskId = (r.message_id ?? r.task_id) as string;

    const adminTools = buildHandlers({ callerTokenId: TOK.utokGadmin });
    const rr = await call(adminTools.reassign_task, {
      task_id: taskId,
      new_alias: CALLER,
      from_session: DIRECTOR,
    });
    expect(rr.ok).toBe(true);

    const requeued = db.get<Record<string, unknown>>(
      `SELECT * FROM inbox WHERE canonical_task_id = ?1 AND session_name = ?2`,
      taskId, CALLER)!;
    expect(requeued).toBeDefined();
    expect(requeued.sender_token_id).toBe(TOK.utokOwner);
    expect(requeued.sender_role).toBe("owner");
    expect(requeued.canonical_task_id).toBe(taskId);
    expect(requeued.id).not.toBe(taskId);
  });
});

// ──────────────────────────────────────────────────────────────────────
// auto-chain inherits the TRIGGERING replier's principal
// ──────────────────────────────────────────────────────────────────────

describe("L1 auto-chain — notify row carries the reply trigger's principal", () => {
  test("parent←child chain: chain notify inherits the REPLIER's principal", async () => {
    // parent: DIRECTOR (member utok) → CALLER
    const memberTools = buildHandlers({ callerTokenId: TOK.utokMember });
    const parent = await call(memberTools.send_task, {
      alias: CALLER,
      task: "parent work",
      priority: "normal",
      from_session: DIRECTOR,
      network_id: NET,
    });
    expect(parent.ok).toBe(true);
    const parentId = (parent.message_id ?? parent.task_id) as string;

    // child: CALLER → TARGET, linked to parent
    const child = await call(memberTools.send_task, {
      alias: TARGET,
      task: "child work",
      priority: "normal",
      from_session: CALLER,
      network_id: NET,
      parent_task_id: parentId,
    });
    expect(child.ok).toBe(true);
    const childId = (child.message_id ?? child.task_id) as string;

    // TARGET replies via its ntok — the chain trigger is the NODE.
    const nodeTools = buildHandlers({
      callerTokenId: TOK.ntok,
      callerAlias: TARGET,
      callerTokenIsNetwork: true,
    });
    const rep = await call(nodeTools.send_reply, {
      alias: CALLER,
      text: "child done",
      in_reply_to: childId,
      status: "replied",
      from_session: TARGET,
    });
    expect(rep.ok).toBe(true);

    // The reply row itself: replier principal + canonical = child task.
    const replyRow = db.get<Record<string, unknown>>(
      `SELECT * FROM inbox WHERE in_reply_to = ?1 AND type = 'reply' AND session_name = ?2`,
      childId, CALLER)!;
    expect(replyRow.sender_token_id).toBe(TOK.ntok);
    expect(replyRow.sender_role).toBe("node");
    expect(replyRow.canonical_task_id).toBe(childId);

    // The auto-chain notify row to DIRECTOR: INHERITS the trigger (node).
    const chainRow = db.get<Record<string, unknown>>(
      `SELECT * FROM inbox WHERE in_reply_to = ?1 AND session_name = ?2 AND type = 'reply'`,
      parentId, DIRECTOR)!;
    expect(chainRow).toBeDefined();
    expect(chainRow.sender_token_id).toBe(TOK.ntok);
    expect(chainRow.sender_role).toBe("node");
    expect(chainRow.canonical_task_id).toBe(parentId);
  });
});

// ──────────────────────────────────────────────────────────────────────
// gateway pump: type allowlist + dead-letter + LIMIT starvation
// ──────────────────────────────────────────────────────────────────────

describe("L1 gateway pump — invalid principal rows cannot starve the LIMIT window", () => {
  const PUMP_TARGET = "pump-target";
  const LIMIT = 5;

  function readWindow() {
    return db.all<Record<string, unknown>>(
      `SELECT id, type, content, from_session, network_id, sender_token_id, sender_role, canonical_task_id
       FROM inbox WHERE session_name = ?1 AND acked = 0
       ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, created_at
       LIMIT ${LIMIT}`,
      PUMP_TARGET,
    );
  }

  test("poisoned head-of-queue rows are dead-lettered (ack+fail+audit, NO alias reply); good row still consumed; FIFO", async () => {
    db.run(
      `INSERT INTO sessions (resume_id, alias, network_id, last_seen_at, status)
       VALUES ('s_pump', ?1, ?2, datetime('now'), 'idle')`,
      [PUMP_TARGET, NET],
    );
    // LIMIT poisoned rows from the OUTSIDER (null principal) via the REAL
    // handler, then one GOOD member row behind them.
    const outsiderTools = buildHandlers({ callerTokenId: TOK.utokOutsider });
    const badIds: string[] = [];
    for (let i = 0; i < LIMIT; i++) {
      const r = await call(outsiderTools.send_task, {
        alias: PUMP_TARGET,
        task: `poison-${i}`,
        priority: "normal",
        from_session: "指挥室",
        network_id: NET,
      });
      expect(r.ok).toBe(true);
      badIds.push((r.message_id ?? r.task_id) as string);
    }
    const memberTools = buildHandlers({ callerTokenId: TOK.utokMember });
    const good = await call(memberTools.send_task, {
      alias: PUMP_TARGET,
      task: "good work",
      priority: "normal",
      from_session: DIRECTOR,
      network_id: NET,
    });
    expect(good.ok).toBe(true);

    // First LIMIT window: ALL poison (good row starved out of the window).
    const window1 = readWindow();
    expect(window1).toHaveLength(LIMIT);
    expect(window1.every((r) => r.sender_token_id === null)).toBe(true);

    const enqueued: string[] = [];
    const failed: string[] = [];
    const audited: string[] = [];
    const inboxCountBefore = db.get<{ c: number }>(
      "SELECT COUNT(*) as c FROM inbox")!.c;
    const hooks = {
      ack: (id: string) => { db.run("UPDATE inbox SET acked = 1 WHERE id = ?1", [id]); },
      markTaskFailed: (taskId: string, reason: string) => {
        db.run("UPDATE tasks SET status = 'failed', result = ?2 WHERE task_id = ?1", [taskId, reason]);
        failed.push(taskId);
      },
      audit: (e: { messageId: string }) => { audited.push(e.messageId); },
    };
    const gateway = {
      enqueueTask: async (args: { taskId: string; messageId: string }) => {
        enqueued.push(String(args.taskId));
        return { outcome: "accepted", taskId: args.taskId, queuePosition: null, duplicate: false } as never;
      },
    };

    // Batch 1: entire window is poison → all dead-lettered, none enqueued.
    const rep1 = await pumpInboxBatch(window1 as never, gateway as never, hooks);
    expect(rep1.deadLettered).toHaveLength(LIMIT);
    expect(rep1.enqueued).toHaveLength(0);
    expect(failed.sort()).toEqual(badIds.slice().sort()); // tasks visibly failed, not lost
    expect(audited).toHaveLength(LIMIT);

    // NO reply was sent toward the forged alias: inbox row count unchanged
    // (dead-letter only acks; it never inserts a reply row for '指挥室').
    const inboxCountAfter = db.get<{ c: number }>(
      "SELECT COUNT(*) as c FROM inbox")!.c;
    expect(inboxCountAfter).toBe(inboxCountBefore);

    // Batch 2 window now surfaces the good row → enqueued with canonical
    // taskId + row id as messageId. Starvation broken.
    const window2 = readWindow();
    expect(window2.length).toBeGreaterThanOrEqual(1);
    const rep2 = await pumpInboxBatch(window2 as never, gateway as never, hooks);
    expect(rep2.enqueued).toHaveLength(1);
    expect(enqueued).toContain((good.message_id ?? good.task_id) as string);
  });

  test("Phase-1 type allowlist: non-task rows are left for the ordinary runtime", async () => {
    const rows = [
      { id: "nt1", type: "message", content: "hi", network_id: NET, sender_token_id: TOK.utokMember, sender_role: "member" },
      { id: "nt2", type: "reply", content: "re", network_id: NET, sender_token_id: TOK.utokMember, sender_role: "member" },
      { id: "nt3", type: "broadcast", content: "all", network_id: NET, sender_token_id: TOK.utokMember, sender_role: "member" },
    ];
    let acked = 0;
    const rep = await pumpInboxBatch(
      rows as never,
      { enqueueTask: async () => { throw new Error("must not enqueue"); } } as never,
      { ack: () => { acked++; }, markTaskFailed: () => {}, audit: () => {} },
    );
    expect(rep.skippedNonTask).toBe(3);
    expect(rep.enqueued).toHaveLength(0);
    expect(rep.deadLettered).toHaveLength(0);
    expect(acked).toBe(0); // NOT acked — ordinary runtime still sees them
  });

  test("legacy bad row WITHOUT canonical mapping: audit/quarantine only — no task failure, no alias reply", async () => {
    const rows = [{
      id: "legacy_bad_1", type: "task", content: "legacy", network_id: NET,
      from_session: "指挥室", sender_token_id: null, sender_role: null,
      canonical_task_id: null,
    }];
    const failed: string[] = [];
    const audited: string[] = [];
    let acked = 0;
    const rep = await pumpInboxBatch(
      rows as never,
      { enqueueTask: async () => { throw new Error("must not enqueue"); } } as never,
      {
        ack: () => { acked++; },
        markTaskFailed: (id: string) => { failed.push(id); },
        audit: (e: { messageId: string }) => { audited.push(e.messageId); },
      },
    );
    expect(rep.deadLettered).toHaveLength(1);
    expect(acked).toBe(1); // quarantined out of the window
    expect(failed).toHaveLength(0); // no trusted task mapping → audit only
    expect(audited).toEqual(["legacy_bad_1"]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// migration backcompat
// ──────────────────────────────────────────────────────────────────────

describe("L1 migration — additive/backcompat", () => {
  test("pre-migration-shaped INSERT (no principal/canonical columns) still works and reads fine", () => {
    db.run(
      `INSERT INTO inbox (id, session_name, type, priority, content, from_session, network_id)
       VALUES ('legacy_rw_1', ?1, 'task', 'normal', 'old writer', 'somebody', ?2)`,
      [TARGET, NET],
    );
    const row = db.get<Record<string, unknown>>(
      "SELECT * FROM inbox WHERE id = 'legacy_rw_1'")!;
    expect(row.content).toBe("old writer");
    expect(row.sender_token_id ?? null).toBeNull();
    expect(row.canonical_task_id ?? null).toBeNull();
    expect(senderFromInboxRow(row as never)).toBeNull(); // gateway alone refuses
  });

  test("resolveSenderPrincipal never throws on garbage input", () => {
    expect(resolveSenderPrincipal(db, { callerTokenId: "tok_missing", effectiveNetId: NET })).toBeNull();
    expect(resolveSenderPrincipal(db, { callerTokenId: null, effectiveNetId: NET })).toBeNull();
    expect(resolveSenderPrincipal(db, { callerTokenId: TOK.utokMember, effectiveNetId: "net_nonexistent" })).toBeNull();
  });
});

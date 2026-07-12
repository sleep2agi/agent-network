// RFC-030 Wave 1B L1-followup — principal matrix on REAL handlers with
// SAME-SOURCE auth context (副指挥 2306718c #5): userId/tokenId/scope all
// derive from ONE api_tokens row exactly the way index.ts /mcp does
// (resolveToken → createServer → registerTools). No fixed enforceUserId
// with someone else's tokenId — the audited self-deception is gone.
//
// FALSIFIABILITY: every stamp assertion pins the exact token-derived
// value; if the implementation ever consumed the forged from_session /
// args instead of the auth context, these tests turn red (the forged
// display values are chosen to derive DIFFERENT principals).
//
// Also covers (per the same 整改令):
//   #2 pump result/ACK state machine — every branch
//   #4 server-side atomic conditional dead-letter (gatewayDeadLetterInboxRow)
//   #6 retry/reassign/cancel ack ALL delivery attempts of a canonical
//   #7 real-entry stamping for send_message / broadcast /
//      report_completion→auto-chain
//   #8 DB-level origin write-once trigger
//   #1 node/child tokens are principals ONLY in their bound network

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tmpDb = join(mkdtempSync(join(tmpdir(), "rfc030-handler-")), "test.db");
process.env.COMMHUB_DB = tmpDb;

const { db } = await import("./db");
const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { registerTools } = await import("./tools");
const { resolveSenderPrincipal } = await import("./principal");
const { gatewayDeadLetterInboxRow } = await import("./gateway-ops");
const { senderFromInboxRow } = await import(
  "../../agent-node/src/runtime/codex-policy-gateway/bridge-adapter"
);
const { pumpInboxBatch, runGatewayInboxCycle } = await import(
  "../../agent-node/src/runtime/codex-policy-gateway/inbox-pump"
);

const NET = "net_stamp_h";
const OTHER_NET = "net_stamp_other";
const U_OWNER = "u_stamp_owner";
const U_MEMBER = "u_stamp_member";
const U_VIEWER = "u_stamp_viewer";
const U_GADMIN = "u_stamp_gadmin";
const U_OUTSIDER = "u_stamp_outsider";

const TOK = {
  utokOwner: "tok_h_utok_owner",
  utokMember: "tok_h_utok_member",
  utokViewer: "tok_h_utok_viewer",
  utokGadmin: "tok_h_utok_gadmin",
  utokOutsider: "tok_h_utok_outsider",
  ntok: "tok_h_ntok_node", // bound NET, owned by U_OWNER (owner role)
  child: "tok_h_child", // bound NET
  legacyFull: "tok_h_full_legacy",
} as const;

const TARGET = "stamp-target";
const CALLER = "stamp-caller"; // the ntok's bound node alias
const DIRECTOR = "stamp-director";

interface ToolHandler {
  (args: Record<string, unknown>, extra?: unknown): Promise<{
    content: Array<{ type: "text"; text: string }>;
  }>;
}

beforeAll(() => {
  for (const [id, name, role] of [
    [U_OWNER, "stamp-owner", "user"],
    [U_MEMBER, "stamp-member", "user"],
    [U_VIEWER, "stamp-viewer", "user"],
    [U_GADMIN, "stamp-gadmin", "admin"],
    [U_OUTSIDER, "stamp-outsider", "user"],
  ] as const) {
    db.run(`INSERT INTO users (user_id, username, password_hash, role) VALUES (?1, ?2, 'x', ?3)`, [id, name, role]);
  }
  db.run(`INSERT INTO networks (network_id, network_name, owner_id) VALUES (?1, 'stamp-net', ?2)`, [NET, U_OWNER]);
  db.run(`INSERT INTO networks (network_id, network_name, owner_id) VALUES (?1, 'other-net', ?2)`, [OTHER_NET, U_OWNER]);
  for (const [uid, role] of [
    [U_OWNER, "owner"],
    [U_MEMBER, "member"],
    [U_VIEWER, "viewer"],
  ] as const) {
    db.run(`INSERT INTO network_members (network_id, user_id, role) VALUES (?1, ?2, ?3)`, [NET, uid, role]);
  }
  const tokens: Array<[string, string, string | null, string, string | null, string]> = [
    // [token_id, user_id, network_id, scope, role, name]
    [TOK.utokOwner, U_OWNER, null, "user", null, "user-login"],
    [TOK.utokMember, U_MEMBER, null, "user", null, "user-login"],
    [TOK.utokViewer, U_VIEWER, null, "user", null, "user-login"],
    [TOK.utokGadmin, U_GADMIN, null, "user", null, "user-login"],
    [TOK.utokOutsider, U_OUTSIDER, null, "user", null, "user-login"],
    [TOK.ntok, U_OWNER, NET, "network", null, `node:${CALLER}`],
    [TOK.child, U_OWNER, NET, "network", "child", `node:${CALLER}`],
    [TOK.legacyFull, U_OWNER, NET, "full", null, "legacy-full"],
  ];
  for (const [tid, uid, nid, scope, role, name] of tokens) {
    db.run(
      `INSERT INTO api_tokens (token_id, token_hash, user_id, network_id, name, scope, role)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      [tid, `h_${tid}`, uid, nid, name, scope, role],
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

/**
 * SAME-SOURCE auth context factory — mirrors index.ts /mcp verbatim:
 * one api_tokens row drives userId (join to users implied), scope,
 * enforceNetworkId (the token's OWN binding, null for utok), and the
 * callerAlias derivation from token name ('node:<alias>').
 */
function buildHandlers(tokenId: string | null): Record<string, ToolHandler> {
  let userId: string | null = null;
  let scope: string | null = null;
  let enforceNetId: string | null = null;
  let callerAlias: string | null = null;
  if (tokenId) {
    const row = db.get<{ user_id: string; scope: string | null; network_id: string | null; name: string | null }>(
      "SELECT user_id, scope, network_id, name FROM api_tokens WHERE token_id = ?1",
      tokenId,
    )!;
    userId = row.user_id;
    scope = row.scope;
    enforceNetId = row.network_id; // utok: null (network via args), ntok: bound
    const uname = db.get<{ username: string }>("SELECT username FROM users WHERE user_id = ?1", row.user_id)?.username ?? null;
    callerAlias = row.name?.startsWith("node:") ? row.name.slice("node:".length) : uname;
  }
  const server = new McpServer({ name: "t", version: "0" }) as unknown as { tool: (...a: unknown[]) => unknown };
  const tools: Record<string, ToolHandler> = {};
  const orig = (server.tool as (...a: unknown[]) => unknown).bind(server);
  server.tool = (name: string, d: string, sch: unknown, h: ToolHandler) => {
    tools[name] = h;
    return orig(name, d, sch, h);
  };
  registerTools(server as never, undefined, enforceNetId, userId, callerAlias, scope === "network", tokenId);
  return tools;
}

async function call(h: ToolHandler, args: Record<string, unknown>) {
  return JSON.parse((await h(args)).content[0].text) as Record<string, unknown>;
}

let seq = 0;
async function sendTask(tokenId: string | null, opts: { from?: string; content?: string } = {}) {
  const tools = buildHandlers(tokenId);
  const content = opts.content ?? `stamp-mx-${++seq}`;
  const r = await call(tools.send_task, {
    alias: TARGET,
    task: content,
    priority: "normal",
    ...(opts.from !== undefined ? { from_session: opts.from } : {}),
    network_id: NET,
  });
  const row = db.get<Record<string, unknown>>(
    `SELECT * FROM inbox WHERE session_name = ?1 AND content = ?2 AND network_id = ?3`,
    TARGET, content, NET,
  );
  return { r, row, content, tools };
}

// ──────────────────────────────────────────────────────────────────────
// #5 role authority on the SAME-SOURCE auth path
// ──────────────────────────────────────────────────────────────────────

describe("L1F #5 — role authority, same-source authCtx (falsifiable)", () => {
  test("utok member/owner: stamp equals the TOKEN's network role; forged from_session cannot shift it", async () => {
    for (const [tok, expected] of [
      [TOK.utokMember, "member"],
      [TOK.utokOwner, "owner"],
    ] as const) {
      // forged display '指挥室' — if the implementation derived the
      // principal from it, sender_role could not equal the token's role.
      const { r, row } = await sendTask(tok, { from: "指挥室" });
      expect(r.ok).toBe(true);
      expect(row!.from_session).toBe("指挥室"); // display forged fine
      expect(row!.sender_token_id).toBe(tok);
      expect(row!.sender_role).toBe(expected);
    }
  });

  test("utok viewer: MCP send_task REFUSED (canWrite), zero insert", async () => {
    const { r, row } = await sendTask(TOK.utokViewer);
    expect(r.ok).not.toBe(true);
    expect(row ?? null).toBeNull();
  });

  test("global admin WITHOUT membership: MCP send_task REFUSED (cross-network admin power is REST-only)", async () => {
    const { r, row } = await sendTask(TOK.utokGadmin);
    expect(r.ok).not.toBe(true);
    expect(row ?? null).toBeNull();
  });

  test("utok outsider: REFUSED, zero insert", async () => {
    const { r, row } = await sendTask(TOK.utokOutsider);
    expect(r.ok).not.toBe(true);
    expect(row ?? null).toBeNull();
  });

  test("plain ntok (owner's token): stamps 'node', NEVER the owner's network role", async () => {
    const { r, row } = await sendTask(TOK.ntok);
    expect(r.ok).toBe(true);
    expect(row!.from_session).toBe(CALLER); // bound identity
    expect(row!.sender_token_id).toBe(TOK.ntok);
    expect(row!.sender_role).toBe("node"); // falsifiable: owner-derived would be 'owner'
    expect(senderFromInboxRow(row as never)!.role).toBe("node");
  });

  test("ntok forged from_session (≠ bound alias): REFUSED, zero insert", async () => {
    const { r, row } = await sendTask(TOK.ntok, { from: "指挥室" });
    expect(r.ok).not.toBe(true);
    expect(row ?? null).toBeNull();
  });

  test("RFC-026 child token → 'child'", async () => {
    const { r, row } = await sendTask(TOK.child);
    expect(r.ok).toBe(true);
    expect(row!.sender_role).toBe("child");
  });

  test("legacy 'full' token / no token → NULL principal; gateway alone refuses", async () => {
    for (const tok of [TOK.legacyFull, null]) {
      const { r, row } = await sendTask(tok);
      expect(r.ok).toBe(true);
      expect(row!.sender_token_id ?? null).toBeNull();
      expect(row!.sender_role ?? null).toBeNull();
      expect(senderFromInboxRow(row as never)).toBeNull();
    }
  });

  test("#1 node/child tokens are principals ONLY in their bound network", () => {
    expect(resolveSenderPrincipal(db, { callerTokenId: TOK.ntok, effectiveNetId: NET })!.role).toBe("node");
    expect(resolveSenderPrincipal(db, { callerTokenId: TOK.ntok, effectiveNetId: OTHER_NET })).toBeNull();
    expect(resolveSenderPrincipal(db, { callerTokenId: TOK.child, effectiveNetId: OTHER_NET })).toBeNull();
  });

  test("bogus/unknown role values in the column are refused by the gateway parser", () => {
    for (const bad of ["superadmin", "unknown", ""]) {
      expect(
        senderFromInboxRow({
          id: "x",
          from_session: "y",
          network_id: NET,
          sender_token_id: TOK.utokMember,
          sender_role: bad,
        }),
      ).toBeNull();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// origin principal + canonical + #6 attempt cleanup + #8 write-once
// ──────────────────────────────────────────────────────────────────────

describe("L1F — origin/canonical + #6 all-attempts cleanup + #8 DB write-once", () => {
  async function dispatchAndFail() {
    const { r, content } = await sendTask(TOK.utokMember, { from: DIRECTOR });
    expect(r.ok).toBe(true);
    const taskId = (r.message_id ?? r.task_id) as string;
    db.run("UPDATE tasks SET status = 'failed' WHERE task_id = ?1", [taskId]);
    return { taskId, content };
  }

  function pendingAttempts(taskId: string): number {
    return db.get<{ c: number }>(
      "SELECT COUNT(*) as c FROM inbox WHERE (id = ?1 OR canonical_task_id = ?1) AND acked = 0",
      taskId,
    )!.c;
  }

  test("retry INHERITS origin; initial→retry leaves EXACTLY ONE pending attempt", async () => {
    const { taskId, content } = await dispatchAndFail();
    expect(pendingAttempts(taskId)).toBe(1); // initial

    const opTools = buildHandlers(TOK.ntok); // node operator (bound NET)
    const rr = await call(opTools.retry_task, { task_id: taskId });
    expect(rr.ok).toBe(true);
    // #6: stale initial attempt acked; only the fresh re-queue pending.
    expect(pendingAttempts(taskId)).toBe(1);
    const fresh = db.get<Record<string, unknown>>(
      "SELECT * FROM inbox WHERE canonical_task_id = ?1 AND acked = 0", taskId)!;
    expect(fresh.id).not.toBe(taskId);
    expect(fresh.content).toBe(content);
    // Inherited ORIGIN principal — not the node operator's ('node').
    expect(fresh.sender_token_id).toBe(TOK.utokMember);
    expect(fresh.sender_role).toBe("member");
  });

  test("retry→reassign: ALL prior attempts acked, single fresh attempt for the new alias", async () => {
    const { taskId } = await dispatchAndFail();
    const opTools = buildHandlers(TOK.ntok);
    await call(opTools.retry_task, { task_id: taskId });
    const rr = await call(opTools.reassign_task, { task_id: taskId, new_alias: DIRECTOR });
    expect(rr.ok).toBe(true);
    expect(pendingAttempts(taskId)).toBe(1);
    const fresh = db.get<Record<string, unknown>>(
      "SELECT * FROM inbox WHERE canonical_task_id = ?1 AND acked = 0", taskId)!;
    expect(fresh.session_name).toBe(DIRECTOR);
    expect(fresh.sender_token_id).toBe(TOK.utokMember); // origin held across both hops
  });

  test("retry→cancel: ZERO pending attempts remain", async () => {
    const { taskId } = await dispatchAndFail();
    const opTools = buildHandlers(TOK.ntok);
    await call(opTools.retry_task, { task_id: taskId });
    db.run("UPDATE tasks SET status = 'running' WHERE task_id = ?1", [taskId]); // make cancellable
    const rc = await call(opTools.cancel_task, { task_id: taskId });
    expect(rc.ok).toBe(true);
    expect(pendingAttempts(taskId)).toBe(0);
  });

  test("#8 DB trigger: origin principal is write-once (mutation aborts; NULL→value backfill allowed)", async () => {
    const { taskId } = await dispatchAndFail();
    expect(() =>
      db.run("UPDATE tasks SET origin_sender_token_id = 'tok_evil' WHERE task_id = ?1", [taskId]),
    ).toThrow(/write-once/);
    expect(() =>
      db.run("UPDATE tasks SET origin_sender_role = 'owner' WHERE task_id = ?1", [taskId]),
    ).toThrow(/write-once/);
    // untouched
    const row = db.get<Record<string, unknown>>(
      "SELECT origin_sender_token_id, origin_sender_role FROM tasks WHERE task_id = ?1", taskId)!;
    expect(row.origin_sender_token_id).toBe(TOK.utokMember);
    expect(row.origin_sender_role).toBe("member");
    // Legacy backfill (NULL → value) stays legal:
    db.run(
      `INSERT INTO tasks (task_id, from_name, to_name, priority, status, content, network_id)
       VALUES ('legacy_bf_1', 'a', 'b', 'normal', 'delivered', 'x', ?1)`, [NET]);
    db.run("UPDATE tasks SET origin_sender_token_id = ?1, origin_sender_role = 'member' WHERE task_id = 'legacy_bf_1'", [TOK.utokMember]);
    expect(db.get<Record<string, unknown>>(
      "SELECT origin_sender_token_id FROM tasks WHERE task_id = 'legacy_bf_1'")!.origin_sender_token_id).toBe(TOK.utokMember);
  });
});

// ──────────────────────────────────────────────────────────────────────
// #7 real-entry coverage: send_message / broadcast / report_completion
// ──────────────────────────────────────────────────────────────────────

describe("L1F #7 — real-entry stamping for the remaining write sites", () => {
  test("send_message: operator stamp via real handler (node caller)", async () => {
    const tools = buildHandlers(TOK.ntok);
    const r = await call(tools.send_message, { alias: TARGET, message: "hi-stamp" });
    expect(r.ok).toBe(true);
    const row = db.get<Record<string, unknown>>(
      "SELECT * FROM inbox WHERE id = ?1", r.message_id as string)!;
    expect(row.sender_token_id).toBe(TOK.ntok);
    expect(row.sender_role).toBe("node"); // falsifiable: owner-derived would be 'owner'
  });

  test("broadcast: every recipient row stamped with the operator", async () => {
    const tools = buildHandlers(TOK.utokOwner);
    const r = await call(tools.broadcast, { message: "bc-stamp", network_id: NET });
    expect(r.ok).toBe(true);
    const ids = r.message_ids as string[];
    expect(ids.length).toBeGreaterThanOrEqual(1);
    for (const id of ids) {
      const row = db.get<Record<string, unknown>>("SELECT * FROM inbox WHERE id = ?1", id)!;
      expect(row.sender_token_id).toBe(TOK.utokOwner);
      expect(row.sender_role).toBe("owner");
    }
  });

  test("report_completion → auto-chain: notify row inherits the REPORTER's principal", async () => {
    // parent: member DIRECTOR → TARGET; child: TARGET → CALLER (linked).
    const memberTools = buildHandlers(TOK.utokMember);
    const parent = await call(memberTools.send_task, {
      alias: TARGET, task: "p-work", priority: "normal", from_session: DIRECTOR, network_id: NET,
    });
    const parentId = (parent.message_id ?? parent.task_id) as string;
    const child = await call(memberTools.send_task, {
      alias: CALLER, task: "c-work", priority: "normal", from_session: TARGET, network_id: NET,
      parent_task_id: parentId,
    });
    const childId = (child.message_id ?? child.task_id) as string;
    void childId;

    // CALLER's own ntok reports its completion — REAL handler; the
    // auto-chain trigger principal must be the reporter's server-resolved
    // node identity, not any display value.
    const nodeTools = buildHandlers(TOK.ntok);
    const rep = await call(nodeTools.report_completion, {
      alias: CALLER, task: "c-work", result: "c-done", network_id: NET,
    });
    expect(rep.ok).toBe(true);
    const chainRow = db.get<Record<string, unknown>>(
      `SELECT * FROM inbox WHERE in_reply_to = ?1 AND session_name = ?2 AND type = 'reply'`,
      parentId, DIRECTOR,
    )!;
    expect(chainRow).toBeDefined();
    expect(chainRow.sender_token_id).toBe(TOK.ntok); // trigger principal, server-resolved
    expect(chainRow.sender_role).toBe("node");
    expect(chainRow.canonical_task_id).toBe(parentId);
  });
});

// ──────────────────────────────────────────────────────────────────────
// #2 pump result/ACK state machine + #4 server-side dead-letter + #3 demux
// ──────────────────────────────────────────────────────────────────────

describe("L1F #2/#3/#4 — pump state machine, server dead-letter, demux", () => {
  const PUMP_TARGET = "pump-target";
  beforeAll(() => {
    db.run(
      `INSERT INTO sessions (resume_id, alias, network_id, last_seen_at, status)
       VALUES ('s_pump', ?1, ?2, datetime('now'), 'idle')`,
      [PUMP_TARGET, NET],
    );
  });

  function windowFor(alias: string, limit = 10) {
    return db.all<Record<string, unknown>>(
      `SELECT id, type, content, from_session, network_id, sender_token_id, sender_role, canonical_task_id
       FROM inbox WHERE session_name = ?1 AND acked = 0
       ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, created_at
       LIMIT ${limit}`,
      alias,
    );
  }

  /** Production-shaped hooks: ack via SQL, dead-letter via the SERVER op. */
  const hooks = {
    ack: (id: string) => { db.run("UPDATE inbox SET acked = 1 WHERE id = ?1", [id]); },
    deadLetter: (req: { messageId: string; canonicalTaskId: string | null; reason: string }) =>
      gatewayDeadLetterInboxRow({
        messageId: req.messageId,
        canonicalTaskId: req.canonicalTaskId,
        networkId: NET,
        reason: req.reason,
        actor: PUMP_TARGET,
      }),
  };

  function gatewayReturning(outcome: Record<string, unknown>) {
    const calls: string[] = [];
    return {
      calls,
      enqueueTask: async (args: { taskId: unknown }) => {
        calls.push(String(args.taskId));
        return outcome as never;
      },
    };
  }

  async function seedTask(content: string, tok: string = TOK.utokMember) {
    const tools = buildHandlers(tok);
    const r = await call(tools.send_task, {
      alias: PUMP_TARGET, task: content, priority: "normal", from_session: DIRECTOR, network_id: NET,
    });
    expect(r.ok).toBe(true);
    return (r.message_id ?? r.task_id) as string;
  }

  test("accepted → durable-then-ACK; duplicate → ACK; window drains", async () => {
    const id1 = await seedTask("pump-acc-1");
    const id2 = await seedTask("pump-acc-2");
    const gw = {
      enqueueTask: async (args: { messageId: unknown }) =>
        (String(args.messageId) === id1
          ? { outcome: "accepted", taskId: args.messageId, queuePosition: null, duplicate: false }
          : { outcome: "accepted", taskId: args.messageId, queuePosition: null, duplicate: true }) as never,
    };
    const rep = await pumpInboxBatch(windowFor(PUMP_TARGET) as never, gw as never, hooks as never);
    expect(rep.enqueued.map((e) => e.messageId)).toContain(id1);
    expect(rep.duplicates.map((e) => e.messageId)).toContain(id2);
    // BOTH acked — the audited "accepted ack=0" hole is closed.
    expect(windowFor(PUMP_TARGET)).toHaveLength(0);
  });

  test("queue_full / no_owner / shutting_down → NOT acked, reported deferred (backoff signal)", async () => {
    const id = await seedTask("pump-defer-1");
    for (const [outcome, reason] of [
      ["refused_queue_full", "queue_full"],
      ["refused_no_owner", "no_owner"],
      ["refused_shutting_down", "shutting_down"],
    ] as const) {
      const gw = gatewayReturning({ outcome, queueDepth: 1, limit: 1 });
      const rep = await pumpInboxBatch(windowFor(PUMP_TARGET) as never, gw as never, hooks as never);
      expect(rep.deferred).toEqual([{ messageId: id, reason }]);
      expect(rep.enqueued).toHaveLength(0);
      expect(rep.deadLettered).toHaveLength(0);
      expect(windowFor(PUMP_TARGET).map((r) => r.id)).toContain(id); // STILL pending
    }
    hooks.ack(id); // cleanup
  });

  test("refused_invalid_arg → SERVER-side conditional dead-letter (verified mapping: atomic ack+fail+audit)", async () => {
    const id = await seedTask("pump-invalidarg-1");
    const gw = gatewayReturning({ outcome: "refused_invalid_arg", field: "text", reason: "empty" });
    const rep = await pumpInboxBatch(windowFor(PUMP_TARGET) as never, gw as never, hooks as never);
    expect(rep.deadLettered).toHaveLength(1);
    expect(rep.deadLettered[0].result.outcome).toBe("dead_lettered");
    // Atomic effects: acked + canonical task failed + audit event.
    expect(windowFor(PUMP_TARGET)).toHaveLength(0);
    expect(db.get<Record<string, unknown>>("SELECT status FROM tasks WHERE task_id = ?1", id)!.status).toBe("failed");
    const ev = db.get<{ c: number }>(
      "SELECT COUNT(*) as c FROM task_events WHERE task_id = ?1 AND detail LIKE '%dead-letter%'", id)!.c;
    expect(ev).toBeGreaterThanOrEqual(1);
  });

  test("#4 falsifiability: a LYING canonical claim is quarantined (audit-only), never fails the claimed task", async () => {
    const victim = await seedTask("pump-victim-1"); // healthy other task
    const outsiderTools = buildHandlers(TOK.legacyFull); // null principal writer
    const bad = await call(outsiderTools.send_task, {
      alias: PUMP_TARGET, task: "poison-claim", priority: "normal", from_session: "指挥室", network_id: NET,
    });
    const badId = (bad.message_id ?? bad.task_id) as string;
    // The pump lies: claims the poison row maps to the VICTIM task.
    const res = gatewayDeadLetterInboxRow({
      messageId: badId,
      canonicalTaskId: victim, // ← forged claim
      networkId: NET,
      reason: "codex_gateway_invalid_principal",
      actor: PUMP_TARGET,
    });
    expect(res.outcome).toBe("quarantined"); // server column contradicts the claim
    if (res.outcome === "quarantined") expect(res.reason).toBe("mapping_mismatch");
    // Victim task untouched; poison row still quarantined out of the window.
    expect(db.get<Record<string, unknown>>("SELECT status FROM tasks WHERE task_id = ?1", victim)!.status).toBe("delivered");
    expect(windowFor(PUMP_TARGET).map((r) => r.id)).not.toContain(badId);
    // Quarantine audit landed.
    const audits = db.get<{ c: number }>(
      "SELECT COUNT(*) as c FROM audit_log WHERE action = 'gateway_dead_letter_quarantine' AND target_id = ?1", badId)!.c;
    expect(audits).toBe(1);
    hooks.ack(victim);
  });

  test("#4 cross-network: a gateway cannot ack/fail rows of a foreign network (no-op)", async () => {
    const id = await seedTask("pump-foreign-1");
    const res = gatewayDeadLetterInboxRow({
      messageId: id,
      canonicalTaskId: id,
      networkId: OTHER_NET, // caller scoped to the WRONG network
      reason: "x",
      actor: "evil-gateway",
    });
    expect(res.outcome).toBe("not_found");
    expect(windowFor(PUMP_TARGET).map((r) => r.id)).toContain(id); // untouched
    hooks.ack(id);
  });

  test("#3 demux cycle: mixed window — ordinary rows delivered un-acked, tasks pumped; neither starves", async () => {
    // 3 non-task rows + 2 task rows (one valid, one null-principal).
    const msgTools = buildHandlers(TOK.ntok); // send_message takes no network_id arg → bound node caller
    for (let i = 0; i < 3; i++) {
      const mr = await call(msgTools.send_message, { alias: PUMP_TARGET, message: `ord-${i}` });
      if (mr.ok !== true) throw new Error('seed message failed: ' + JSON.stringify(mr));
    }
    const goodId = await seedTask("demux-good");
    const nullTools = buildHandlers(TOK.legacyFull);
    const badR = await call(nullTools.send_task, {
      alias: PUMP_TARGET, task: "demux-bad", priority: "normal", from_session: "指挥室", network_id: NET,
    });
    const badId = (badR.message_id ?? badR.task_id) as string;

    const delivered: string[] = [];
    const gw = gatewayReturning({ outcome: "accepted", taskId: "demux-good", queuePosition: null, duplicate: false });
    const rep = await runGatewayInboxCycle(
      windowFor(PUMP_TARGET) as never,
      gw as never,
      hooks as never,
      (row) => { delivered.push(String((row as { content?: unknown }).content)); },
    );
    expect(rep.ordinaryDelivered).toBe(3);
    expect(delivered).toEqual(["ord-0", "ord-1", "ord-2"]);
    expect(rep.enqueued.map((e) => e.messageId)).toContain(goodId);
    expect(rep.deadLettered.map((d) => d.messageId)).toContain(badId);
    // Post-cycle window: ordinary rows REMAIN (their handler owns the
    // ack); every task row resolved — tasks were not starved by the
    // non-task majority, and the gateway didn't eat ordinary rows.
    const left = windowFor(PUMP_TARGET);
    expect(left.every((r) => r.type === "message")).toBe(true);
    expect(left).toHaveLength(3);
    for (const r of left) hooks.ack(String(r.id)); // cleanup
  });
});

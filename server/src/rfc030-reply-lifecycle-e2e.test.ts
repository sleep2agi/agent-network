// RFC-030 Wave 1B L3-R7 — reply lifecycle E2E (通信龙 L3 硬验收 ①②):
//
//   ① after retry (a DIFFERENT operator re-queues the task), the gateway's
//     send_reply still lands on the ORIGINAL canonical task row AND the
//     owner sees it (tasks.status='replied' + result — the dashboard's
//     source of truth) — integrated flow, not a stamp unit test;
//   ② the gateway inbox pump REALLY consumes the stamped sender_* columns
//     (the AuthenticatedSender handed to enqueueTask is asserted to be the
//     ORIGIN principal inherited across the retry);
//   plus the originator is WOKEN over a REAL SSE subscription (HTTP
//   /events/:alias) by the new_reply push — the send_reply→new_reply wire,
//   not a pushEvent unit test.
//
// Real pieces on the path: Bun.serve (index.ts) + auth.ts issueUserToken +
// registerTools handlers (send_task / retry_task / send_reply) + principal
// resolver + inbox-pump (agent-node) + SSE stream over HTTP.

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tmpDb = join(mkdtempSync(join(tmpdir(), "rfc030-reply-e2e-")), "test.db");
process.env.COMMHUB_DB = tmpDb;
const PORT = 21000 + Math.floor(Math.random() * 2000);
process.env.PORT = String(PORT);

const { db } = await import("./db");
const { issueUserToken } = await import("./auth");
const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { registerTools } = await import("./tools");
const { pumpInboxBatch } = await import(
  "../../agent-node/src/runtime/codex-policy-gateway/inbox-pump"
);
await import("./index"); // real Bun.serve on PORT

const BASE = `http://127.0.0.1:${PORT}`;
const NET = "net_reply_e2e";
const U_MEMBER = "u_reply_member"; // originator human (member)
const U_OPS = "u_reply_ops"; // a DIFFERENT member (owner role) performing the retry
const DIRECTOR = "reply-director"; // originator agent alias (session)
const GATEWAY_NODE = "reply-gateway-node"; // the codex gateway node alias

const TOK_NTOK = "tok_reply_ntok"; // gateway node's own ntok

let memberUtok = { token: "", token_id: "" };

interface ToolHandler {
  (args: Record<string, unknown>, extra?: unknown): Promise<{
    content: Array<{ type: "text"; text: string }>;
  }>;
}

function buildHandlers(opts: {
  callerAlias?: string | null;
  callerTokenIsNetwork?: boolean;
  callerTokenId?: string | null;
  userId?: string;
}): Record<string, ToolHandler> {
  const server = new McpServer({ name: "t", version: "0" }) as unknown as {
    tool: (...a: unknown[]) => unknown;
  };
  const tools: Record<string, ToolHandler> = {};
  const orig = (server.tool as (...a: unknown[]) => unknown).bind(server);
  server.tool = (name: string, d: string, sch: unknown, h: ToolHandler) => {
    tools[name] = h;
    return orig(name, d, sch, h);
  };
  registerTools(
    server as never,
    undefined,
    NET,
    opts.userId ?? U_MEMBER,
    opts.callerAlias ?? null,
    opts.callerTokenIsNetwork ?? false,
    opts.callerTokenId ?? null,
  );
  return tools;
}

async function call(h: ToolHandler, args: Record<string, unknown>) {
  return JSON.parse((await h(args)).content[0].text) as Record<string, unknown>;
}

beforeAll(() => {
  db.run(`INSERT INTO users (user_id, username, password_hash, role) VALUES (?1, 'reply-member', 'x', 'user')`, [U_MEMBER]);
  db.run(`INSERT INTO users (user_id, username, password_hash, role) VALUES (?1, 'reply-ops', 'x', 'user')`, [U_OPS]);
  db.run(`INSERT INTO networks (network_id, network_name, owner_id) VALUES (?1, 'reply-net', ?2)`, [NET, U_MEMBER]);
  db.run(`INSERT INTO network_members (network_id, user_id, role) VALUES (?1, ?2, 'member')`, [NET, U_MEMBER]);
  db.run(`INSERT INTO network_members (network_id, user_id, role) VALUES (?1, ?2, 'owner')`, [NET, U_OPS]);
  // utok for the ORIGINATOR (real mint — used for both handlers and SSE auth).
  memberUtok = issueUserToken(U_MEMBER, "reply-e2e-login");
  // Retrier's utok row (handler path only needs the token_id).
  db.run(
    `INSERT INTO api_tokens (token_id, token_hash, user_id, network_id, name, scope) VALUES ('tok_reply_ops', 'ha', ?1, NULL, 'ops-login', 'user')`,
    [U_OPS],
  );
  // Gateway node's ntok.
  db.run(
    `INSERT INTO api_tokens (token_id, token_hash, user_id, network_id, name, scope) VALUES (?1, 'hn', ?2, ?3, 'node:${GATEWAY_NODE}', 'network')`,
    [TOK_NTOK, U_MEMBER, NET],
  );
  for (const alias of [DIRECTOR, GATEWAY_NODE]) {
    db.run(
      `INSERT INTO sessions (resume_id, alias, network_id, last_seen_at, status)
       VALUES (?1, ?2, ?3, datetime('now'), 'idle')`,
      [`s_${alias}`, alias, NET],
    );
  }
});

/** Subscribe to the originator's REAL SSE channel; resolve on new_reply. */
async function waitForNewReply(signal: AbortSignal): Promise<Record<string, unknown>> {
  const res = await fetch(
    `${BASE}/events/${encodeURIComponent(DIRECTOR)}?network_id=${NET}`,
    { headers: { Authorization: `Bearer ${memberUtok.token}` }, signal },
  );
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error("SSE stream closed before new_reply");
    buf += dec.decode(value, { stream: true });
    for (const line of buf.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try {
        const ev = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
        if (ev.type === "new_reply") return ev;
      } catch {
        // partial JSON — keep buffering
      }
    }
  }
}

describe("L3-R7 reply lifecycle E2E — retry → pump(sender_*) → send_reply → canonical task + SSE wake", () => {
  test("hard acceptance ①②: canonical hit after retry, pump consumes principal, owner sees replied + SSE new_reply", async () => {
    // 1 — originator dispatches to the gateway node (REAL send_task handler,
    //     member utok → stamped member principal + origin on tasks).
    const memberTools = buildHandlers({ callerTokenId: memberUtok.token_id });
    const sent = await call(memberTools.send_task, {
      alias: GATEWAY_NODE,
      task: "produce the quarterly summary",
      priority: "normal",
      from_session: DIRECTOR,
      network_id: NET,
    });
    expect(sent.ok).toBe(true);
    const originalTaskId = (sent.message_id ?? sent.task_id) as string;

    // 2 — first attempt fails (gateway replies failed — REAL send_reply).
    const gatewayTools = buildHandlers({
      callerTokenId: TOK_NTOK,
      callerAlias: GATEWAY_NODE,
      callerTokenIsNetwork: true,
    });
    const failRep = await call(gatewayTools.send_reply, {
      alias: DIRECTOR,
      text: "first attempt exploded",
      in_reply_to: originalTaskId,
      status: "failed",
      from_session: GATEWAY_NODE,
    });
    expect(failRep.ok).toBe(true);
    // ack the original inbox row (the gateway consumed it)
    db.run("UPDATE inbox SET acked = 1 WHERE id = ?1", [originalTaskId]);

    // 3 — a DIFFERENT operator (network owner) retries the failed task.
    const opsTools = buildHandlers({ callerTokenId: "tok_reply_ops", userId: U_OPS });
    const retried = await call(opsTools.retry_task, {
      task_id: originalTaskId,
      from_session: "reply-ops",
    });
    expect(retried.ok).toBe(true);

    // 4 — the gateway pump consumes the RE-QUEUED row exactly as production
    //     would read it (get_inbox-shaped window) and hands the gateway a
    //     typed enqueue. Assertions: taskId == ORIGINAL canonical id even
    //     though the inbox row id (messageId) is fresh; the Authenticated-
    //     Sender is the INHERITED ORIGIN principal (member), proving the
    //     pump consumes sender_* — not from_session, which is the admin's.
    const window = db.all<Record<string, unknown>>(
      `SELECT id, type, content, from_session, network_id, sender_token_id, sender_role, canonical_task_id
       FROM inbox WHERE session_name = ?1 AND acked = 0
       ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, created_at LIMIT 5`,
      GATEWAY_NODE,
    );
    expect(window.length).toBe(1);
    const enqueues: Array<{ taskId: string; messageId: string; sender: Record<string, unknown> }> = [];
    const report = await pumpInboxBatch(
      window as never,
      {
        enqueueTask: async (args: {
          taskId: string;
          messageId: string;
          authenticatedSender: Record<string, unknown>;
        }) => {
          enqueues.push({
            taskId: String(args.taskId),
            messageId: String(args.messageId),
            sender: args.authenticatedSender,
          });
          return { outcome: "accepted", taskId: args.taskId, queuePosition: null, duplicate: false } as never;
        },
      } as never,
      {
        ack: (id: string) => { db.run("UPDATE inbox SET acked = 1 WHERE id = ?1", [id]); },
        deadLetter: () => { throw new Error("must not dead-letter a valid row"); },
      },
    );
    expect(report.enqueued).toHaveLength(1);
    expect(report.deadLettered).toHaveLength(0);
    expect(enqueues[0].taskId).toBe(originalTaskId); // canonical held across retry
    expect(enqueues[0].messageId).not.toBe(originalTaskId); // fresh attempt id
    expect(enqueues[0].sender.tokenId).toBe(memberUtok.token_id); // ORIGIN principal…
    expect(enqueues[0].sender.role).toBe("member"); // …not the OWNER retrier

    // 5 — originator subscribes over REAL SSE, then the gateway completes
    //     and send_replies against the canonical task id from the enqueue.
    const abort = new AbortController();
    const replyEvent = waitForNewReply(abort.signal);
    await new Promise((r) => setTimeout(r, 150)); // let the subscription land

    const done = await call(gatewayTools.send_reply, {
      alias: DIRECTOR,
      text: "quarterly summary attached",
      in_reply_to: enqueues[0].taskId,
      status: "replied",
      from_session: GATEWAY_NODE,
    });
    expect(done.ok).toBe(true);

    // 6 — OWNER-VISIBLE: the ORIGINAL task row is replied with the result
    //     (this is what the dashboard renders).
    const task = db.get<Record<string, unknown>>(
      "SELECT status, result FROM tasks WHERE task_id = ?1",
      originalTaskId,
    )!;
    expect(task.status).toBe("replied");
    expect(String(task.result)).toContain("quarterly summary attached");

    // 7 — SSE WAKE: the originator's real HTTP subscription received the
    //     new_reply push pointing at the canonical task.
    const ev = await Promise.race([
      replyEvent,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("SSE new_reply timeout")), 5_000)),
    ]);
    expect(ev.type).toBe("new_reply");
    expect(ev.in_reply_to).toBe(originalTaskId);
    expect(ev.status).toBe("replied");
    abort.abort();
  }, 20_000);
});

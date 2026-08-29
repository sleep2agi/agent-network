// SSE `inbox_count` contract for the message-shaped events.
//
// Background: `new_task` has shipped a real unacked count since #1304,
// but `new_message` / `new_reply` carried NO count at all and
// `broadcast` carried a hardcoded `inbox_count: 1`. A client that
// renders "N new" from the SSE payload therefore never moved for plain
// messages and replies, and showed a constant 1 for broadcasts.
//
// Gate discipline: every assertion below expects a count that is NOT 1
// (pre-seeded unacked rows push the expected value to 2 or 3). A
// hardcoded `1` — the exact defect being fixed — fails these tests
// rather than passing them. Asserting `=== 1` would have been a fake
// gate that the old code satisfied.
//
// Run: COMMHUB_DB=/tmp/inbox-count-sse.db bun test src/inbox-count-sse.test.ts

import { afterAll, beforeEach, afterEach, describe, expect, test } from "bun:test";
import { db, uuidv4 } from "./db.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";
import { __resetSSEClientsForTest, createSSEStream } from "./push.js";
import { pendingInboxCount } from "./inbox-count.js";

const NET = "net_inboxcount";
const OWNER = "u_inboxcount_owner";
const RECV = "peer-inboxcount-recv";   // receives messages/replies
const OTHER = "peer-inboxcount-other"; // second broadcast recipient
const SENDER = "peer-inboxcount-send";
const ALIASES = [RECV, OTHER, SENDER];

type ToolHandler = (args: any, extra?: any) => Promise<{ content: Array<{ type: "text"; text: string }> }>;

function cleanup() {
  for (const t of ["tasks", "inbox", "task_events"]) {
    try { db.run(`DELETE FROM ${t} WHERE network_id = ?1`, [NET]); } catch {}
  }
  try { db.run("DELETE FROM sessions WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM nodes WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM network_members WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM networks WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM users WHERE user_id = ?1", [OWNER]); } catch {}
}

function seed() {
  db.run(
    `INSERT INTO users (user_id, username, password_hash, role, created_at)
     VALUES (?1, ?1, 'x', 'user', datetime('now'))`,
    [OWNER],
  );
  db.run(`INSERT INTO networks (network_id, network_name, owner_id, created_at) VALUES (?1, ?1, ?2, datetime('now'))`, [NET, OWNER]);
  db.run(`INSERT INTO network_members (user_id, network_id, role, joined_at) VALUES (?1, ?2, 'owner', datetime('now'))`, [OWNER, NET]);
  for (const alias of ALIASES) {
    db.run(
      `INSERT INTO nodes (node_id, node_name, alias, network_id, hostname, created_at, updated_at, lifecycle_state)
       VALUES (?1, ?2, ?2, ?3, ?4, datetime('now'), datetime('now'), 'active')`,
      [`node_${alias}`, alias, NET, `host-${alias}`],
    );
    db.run(
      `INSERT INTO sessions (resume_id, alias, status, node_id, network_id, updated_at, last_seen_at)
       VALUES (?1, ?2, 'idle', ?3, ?4, datetime('now'), datetime('now'))`,
      [`res_${alias}`, alias, `node_${alias}`, NET],
    );
  }
}

beforeEach(() => { cleanup(); seed(); });
afterEach(() => { __resetSSEClientsForTest(); });
afterAll(cleanup);

function buildHandlers(alias: string): Record<string, ToolHandler> {
  const server = new McpServer({ name: "test", version: "0" }) as any;
  const tools: Record<string, ToolHandler> = {};
  const origTool = server.tool.bind(server);
  server.tool = (name: string, _desc: string, schema: any, handler: ToolHandler) => {
    tools[name] = handler;
    return origTool(name, _desc, schema, handler);
  };
  registerTools(server, undefined, NET, OWNER, alias, true, null);
  return tools;
}

async function call(handler: ToolHandler, args: any): Promise<Record<string, any>> {
  const r = await handler(args);
  return JSON.parse(r.content[0].text);
}

/** Read the next SSE data frame, with a hard timeout so a silent stream
 *  fails instead of hanging. Skips keepalive comment frames. */
async function readFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs = 2_000,
): Promise<Record<string, any>> {
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error(`no SSE frame within ${timeoutMs}ms`)), deadline - Date.now()),
      ),
    ]);
    if (result.done) throw new Error("SSE stream ended unexpectedly");
    buf += decoder.decode(result.value, { stream: true });
    const sep = buf.indexOf("\n\n");
    if (sep === -1) continue;
    const rawFrame = buf.slice(0, sep);
    buf = buf.slice(sep + 2);
    const dataLine = rawFrame.split("\n").find((l) => l.startsWith("data: "));
    if (!dataLine) continue;
    return JSON.parse(dataLine.slice(6));
  }
  throw new Error(`no SSE frame within ${timeoutMs}ms`);
}

/** Subscribe and swallow the initial `connected` frame. */
async function subscribe(alias: string) {
  const reader = createSSEStream(alias, NET).body!.getReader();
  await readFrame(reader);
  return reader;
}

/** Pre-existing unacked inbox rows, so the expected count is never 1. */
function seedUnacked(alias: string, n: number, type = "message") {
  for (let i = 0; i < n; i++) {
    db.run(
      `INSERT INTO inbox (id, session_name, node_id, type, priority, content, from_session, network_id)
       VALUES (?1, ?2, ?3, ?4, 'normal', ?5, ?6, ?7)`,
      [uuidv4(), alias, `node_${alias}`, type, `backlog ${i}`, SENDER, NET],
    );
  }
}

function makeTask(from: string, to: string, content: string, status = "delivered"): string {
  const id = uuidv4();
  db.run(
    `INSERT INTO tasks (task_id, from_name, to_name, priority, status, content, requires_response, created_at, network_id)
     VALUES (?1, ?2, ?3, 'normal', ?4, ?5, 'reply', datetime('now'), ?6)`,
    [id, from, to, status, content, NET],
  );
  return id;
}

describe("SSE inbox_count", () => {
  test("new_message carries the recipient's real unacked count, not a hardcoded 1", async () => {
    seedUnacked(RECV, 2);
    const reader = await subscribe(RECV);

    const tools = buildHandlers(SENDER);
    const res = await call(tools.send_message, { alias: RECV, message: "hello", network_id: NET });
    expect(res.ok ?? true).not.toBe(false);

    const evt = await readFrame(reader);
    expect(evt.type).toBe("new_message");
    // 2 seeded + this one. A hardcoded 1 — or a missing field — fails here.
    expect(evt.inbox_count).toBe(3);
    expect(evt.inbox_count).toBe(pendingInboxCount(RECV, NET));
  });

  test("new_reply carries the reply target's real unacked count", async () => {
    seedUnacked(RECV, 1);
    const taskId = makeTask(RECV, SENDER, "please do the thing");
    const reader = await subscribe(RECV);

    const tools = buildHandlers(SENDER);
    const res = await call(tools.send_reply, {
      alias: RECV,
      text: "done",
      in_reply_to: taskId,
      status: "completed",
      network_id: NET,
    });
    expect(res.ok).toBe(true);

    const evt = await readFrame(reader);
    expect(evt.type).toBe("new_reply");
    // 1 seeded + the reply row. Not 1, and not absent.
    expect(evt.inbox_count).toBe(2);
    expect(evt.inbox_count).toBe(pendingInboxCount(RECV, NET));
  });

  test("broadcast counts per recipient instead of shipping a constant 1", async () => {
    // Asymmetric backlogs: if the payload were hardcoded, both
    // recipients would report the same number. They must not.
    seedUnacked(RECV, 2);
    const recvReader = await subscribe(RECV);
    const otherReader = await subscribe(OTHER);

    const tools = buildHandlers(SENDER);
    await call(tools.broadcast, { message: "all hands", network_id: NET });

    const recvEvt = await readFrame(recvReader);
    const otherEvt = await readFrame(otherReader);
    expect(recvEvt.type).toBe("broadcast");
    expect(otherEvt.type).toBe("broadcast");

    // RECV: 2 seeded + the broadcast row. OTHER: only the broadcast row.
    expect(recvEvt.inbox_count).toBe(3);
    expect(otherEvt.inbox_count).toBe(1);
    expect(recvEvt.inbox_count).not.toBe(otherEvt.inbox_count);
  });

  test("acked rows are excluded — the count tracks what is still unread", async () => {
    seedUnacked(RECV, 3);
    db.run("UPDATE inbox SET acked = 1 WHERE session_name = ?1 AND network_id = ?2", [RECV, NET]);
    const reader = await subscribe(RECV);

    const tools = buildHandlers(SENDER);
    await call(tools.send_message, { alias: RECV, message: "after the catch-up", network_id: NET });

    const evt = await readFrame(reader);
    // 3 acked rows contribute nothing; only the new one is outstanding.
    expect(evt.inbox_count).toBe(1);
  });
});

// #1440 ② — `retry_task` and `reassign_task` re-queue a task and push
// `new_task`, but both shipped a hardcoded `inbox_count: 1` while the
// hub already knew the real number. Same defect family as the
// `broadcast` case above; same gate discipline — the expected counts
// here are 3, so a hardcoded 1 cannot satisfy them.
describe("#1440 new_task inbox_count on requeue paths", () => {
  test("retry_task carries the real unacked count, not a hardcoded 1", async () => {
    seedUnacked(RECV, 2);
    const taskId = makeTask(SENDER, RECV, "flaky job", "failed");
    const reader = await subscribe(RECV);

    const tools = buildHandlers(SENDER);
    const res = await call(tools.retry_task, { task_id: taskId, network_id: NET });
    expect(res.ok).toBe(true);

    const evt = await readFrame(reader);
    expect(evt.type).toBe("new_task");
    // 2 seeded + the re-queued task row.
    expect(evt.inbox_count).toBe(3);
    expect(evt.inbox_count).toBe(pendingInboxCount(RECV, NET));
  });

  test("reassign_task carries the NEW assignee's real unacked count", async () => {
    seedUnacked(RECV, 2);
    const taskId = makeTask(SENDER, OTHER, "moved job");
    const reader = await subscribe(RECV);

    const tools = buildHandlers(SENDER);
    const res = await call(tools.reassign_task, { task_id: taskId, new_alias: RECV, network_id: NET });
    expect(res.ok).toBe(true);
    expect(res.reassigned_to).toBe(RECV);

    const evt = await readFrame(reader);
    expect(evt.type).toBe("new_task");
    // 2 seeded on the new assignee + the row reassign just wrote.
    expect(evt.inbox_count).toBe(3);
    expect(evt.inbox_count).toBe(pendingInboxCount(RECV, NET));
  });
});

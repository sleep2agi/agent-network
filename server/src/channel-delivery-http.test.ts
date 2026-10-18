import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "channel-delivery-"));
process.env.COMMHUB_DB = join(dir, "hub.db");
process.env.COMMHUB_UPLOADS_DIR = join(dir, "uploads");
let db: typeof import("./db").db;
let hub: ReturnType<typeof Bun.serve>;
let base = "", ownerToken = "", foreignToken = "", nodeToken = "", otherNodeToken = "", net = "";
const alias = "channel-worker", otherAlias = "channel-other";
let sse: ReadableStreamDefaultReader<Uint8Array> | undefined;
let next = 0;

async function mcp(token: string, name: string, args: Record<string, unknown>) {
  const res = await fetch(base + "/mcp", {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++next, method: "tools/call", params: { name, arguments: args } }),
  });
  const raw = await res.text();
  const line = raw.split("\n").filter(x => x.startsWith("data:")).at(-1);
  const envelope = JSON.parse(line ? line.slice(5).trim() : raw);
  if (envelope.error || envelope.result?.isError) return { ok: false, error: "rpc_rejected" };
  return JSON.parse(envelope.result.content[0].text);
}
async function detail(id: string, token = ownerToken) {
  const res = await fetch(base + "/api/tasks/" + id, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, body: await res.json() as any };
}
async function dispatch() {
  const sent = await mcp(ownerToken, "send_task", { alias, task: `synthetic-body-not-evidence-${++next}`, priority: "normal" });
  expect(sent.ok).toBe(true);
  return sent.task_id ?? sent.message_id;
}
async function ack(id: string) {
  return mcp(nodeToken, "ack_inbox", { alias, message_id: id, channel_notification_injected: true });
}
const events = (id: string) => db.all<any>("SELECT * FROM task_events WHERE task_id=?1 AND event_type='task.delivery.channel_notification_injected'", id);

beforeAll(async () => {
  ({ db } = await import("./db"));
  const { register, createNetworkTokenForNode } = await import("./auth");
  // First account is global admin: leave it unused so isolation has teeth.
  expect(register("channel_bootstrap", "Synthetic-bootstrap-1492!").ok).toBe(true);
  const owner = register("channel_owner", "Synthetic-owner-1492!");
  const foreign = register("channel_foreign", "Synthetic-foreign-1492!");
  expect(owner.ok && foreign.ok).toBe(true);
  ownerToken = owner.token!; foreignToken = foreign.token!; net = owner.network_id!;
  const ownerId = owner.user!.user_id;
  expect(db.get<any>("SELECT role FROM users WHERE user_id=?1", ownerId).role).toBe("user");
  nodeToken = createNetworkTokenForNode(ownerId, net, alias, "node_channel_worker").token!;
  otherNodeToken = createNetworkTokenForNode(ownerId, net, otherAlias, "node_channel_other").token!;
  expect(nodeToken && otherNodeToken).toBeTruthy();
  db.run(`INSERT INTO sessions (resume_id,alias,status,agent,node_id,network_id,updated_at,last_seen_at)
    VALUES ('channel-resume',?1,'idle','claude-code','node_channel_worker',?2,datetime('now'),datetime('now'))`, [alias, net]);
  const { bootServer } = await import("./server");
  hub = bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${hub.port}`;
  const stream = await fetch(`${base}/events/${alias}?network_id=${net}`, { headers: { Authorization: `Bearer ${nodeToken}` } });
  expect(stream.status).toBe(200); sse = stream.body!.getReader();
  expect(new TextDecoder().decode((await sse.read()).value)).toContain('"type":"connected"');
}, 30_000);

afterAll(async () => {
  await sse?.cancel().catch(() => {});
  hub?.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

describe("recipient-checked channel receipt over real MCP/HTTP, isolated SQLite", () => {
  test("capability + injection does not fake CLI admission/consumption; reply closes normally", async () => {
    const id = await dispatch();
    const inbox = await mcp(nodeToken, "get_inbox", { alias, limit: 20 });
    expect(inbox.delivery_evidence).toEqual({ channel_notification_injected: 1 });
    expect((await ack(id)).channel_notification_injected).toBe(true);
    const before = await detail(id);
    expect(before.body.diagnostic.code).toBe("runtime_evidence_channel_absent");
    expect(before.body.task.status).toBe("acked");
    expect([before.body.task.runtime_submitted_at, before.body.task.consumed_at]).toEqual([null, null]);
    expect(before.body.task.channel_delivery.cli_admitted.state).toBe("unknown");
    expect(before.body.task.channel_delivery.turn_started.state).toBe("unknown");
    expect(before.body.task.channel_delivery.channel_notification_injected.state).toBe("observed");
    expect(events(id)).toHaveLength(1); expect(events(id)[0].detail).toBeNull();
    expect(JSON.stringify(before.body.task.channel_delivery)).not.toContain("synthetic-body");
    const replied = await mcp(nodeToken, "send_reply", { in_reply_to: id, text: "synthetic terminal reply", status: "replied", from_session: alias });
    expect(replied.ok).toBe(true);
    const after = await detail(id);
    expect(after.body.diagnostic.code).toBe("terminal");
    expect(after.body.task.channel_delivery.replied.state).toBe("observed");
    expect(after.body.task.channel_delivery.cli_admitted.state).toBe("unknown");
    expect(after.body.task.consumed_at).toBeNull();
    const polled = await mcp(ownerToken, "get_task", { task_id: id });
    expect(polled.task.channel_delivery).toEqual(after.body.task.channel_delivery);
  });

  test("plain old ACK remains compatible and produces no transport-start claim", async () => {
    const id = await dispatch();
    expect((await mcp(nodeToken, "ack_inbox", { alias, message_id: id })).ok).toBe(true);
    expect(events(id)).toHaveLength(0);
    expect((await detail(id)).body.task.channel_delivery).toBeUndefined();
  });

  test("peer/foreign callers cannot stamp another recipient's evidence", async () => {
    const id = await dispatch();
    expect((await mcp(otherNodeToken, "ack_inbox", { alias, message_id: id, channel_notification_injected: true })).ok).toBe(false);
    expect((await mcp(foreignToken, "ack_inbox", { alias, message_id: id, network_id: net, channel_notification_injected: true })).ok).toBe(false);
    expect((await detail(id, foreignToken)).status).toBe(404);
    expect(events(id)).toHaveLength(0);
    expect(db.get<any>("SELECT acked FROM inbox WHERE task_id=?1", id).acked).toBe(0);
  });

  test("stage/metadata injection is rejected by real schema before ACK", async () => {
    const id = await dispatch();
    expect((await mcp(nodeToken, "ack_inbox", { alias, message_id: id, channel_notification_injected: "turn_started" })).ok).toBe(false);
    expect(events(id)).toHaveLength(0);
    expect(db.get<any>("SELECT acked FROM inbox WHERE task_id=?1", id).acked).toBe(0);
  });

  test("event storage failure rolls back ACK and task lifecycle together", async () => {
    const id = await dispatch();
    db.exec(`CREATE TRIGGER channel_fixture_failure BEFORE INSERT ON task_events
      WHEN NEW.event_type='task.delivery.channel_notification_injected'
      BEGIN SELECT RAISE(ABORT,'synthetic channel event fault'); END`);
    try {
      expect((await ack(id)).ok).toBe(false);
      expect(db.get<any>("SELECT acked FROM inbox WHERE task_id=?1", id).acked).toBe(0);
      expect(db.get<any>("SELECT status FROM tasks WHERE task_id=?1", id).status).toBe("delivered");
      expect(events(id)).toHaveLength(0);
    } finally { db.exec("DROP TRIGGER channel_fixture_failure"); }
    expect((await ack(id)).ok).toBe(true);
  });

  test("same-second retry cannot inherit the old delivery event; logical id ACK binds the new row", async () => {
    const id = await dispatch(); expect((await ack(id)).ok).toBe(true);
    expect((await mcp(ownerToken, "cancel_task", { task_id: id })).ok).toBe(true);
    expect((await mcp(ownerToken, "retry_task", { task_id: id })).ok).toBe(true);
    db.run("UPDATE inbox SET created_at='2026-10-19 00:00:00' WHERE task_id=?1", [id]);
    expect((await detail(id)).body.task.channel_delivery).toBeUndefined();
    expect((await ack(id)).ok).toBe(true);
    expect(events(id)).toHaveLength(2);
    expect(new Set(events(id).map((e: any) => e.event_key)).size).toBe(2);
    expect((await detail(id)).body.task.consumed_at).toBeNull();
  });

  test("a retried delivery acked by an old bridge cannot revive the prior receipt", async () => {
    const id = await dispatch();
    expect((await ack(id)).ok).toBe(true);
    expect((await detail(id)).body.task.channel_delivery.channel_notification_injected.state).toBe("observed");
    expect((await mcp(ownerToken, "cancel_task", { task_id: id })).ok).toBe(true);
    expect((await mcp(ownerToken, "retry_task", { task_id: id })).ok).toBe(true);
    expect((await mcp(nodeToken, "ack_inbox", { alias, message_id: id })).ok).toBe(true);
    expect((await detail(id)).body.task.channel_delivery).toBeUndefined();
    expect(events(id)).toHaveLength(1);
  });

});

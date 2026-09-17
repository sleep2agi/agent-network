import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { register } from "./auth.js";
import { db } from "./db.js";

// #1909 —— POST /api/messages/ack 的 `{ agent }` 形态:把调用者收到的、来自该 agent 的
// 两张表(user_inbox + inbox reply/task/message)全部标已读。角标分母 unread_by_agent
// 数的是全集,按 id 只能 ack 拉到的那一页 ⇒ 老行永远清不掉,这一形态补上。
const PRIVATE_DB_DIR = mkdtempSync(join(tmpdir(), "anet-ack-by-agent-http-"));
let server: any;
let base = "";
let tokenA = "";
let tokenB = "";
let userA = "";
let userB = "";
let userIdA = "";
let userIdB = "";
let netA = "";
let netB = "";

const AGENT = "ack-agent-x";
const OTHER = "ack-agent-y";

function seed() {
  const ui = (id: string, net: string, uid: string, from: string) =>
    db.run(
      `INSERT INTO user_inbox (message_id, network_id, user_id, from_session, kind, content) VALUES (?1, ?2, ?3, ?4, 'agent_message', 'x')`,
      [id, net, uid, from],
    );
  const ib = (id: string, net: string, to: string, from: string, type: string) =>
    db.run(
      `INSERT INTO inbox (id, session_name, type, content, from_session, network_id) VALUES (?1, ?2, ?3, 'x', ?4, ?5)`,
      [id, to, type, from, net],
    );
  ui("ui_a_x_1", netA, userIdA, AGENT);
  ui("ui_a_x_2", netA, userIdA, AGENT);
  ui("ui_a_y_1", netA, userIdA, OTHER);
  ui("ui_b_x_1", netB, userIdB, AGENT);
  ib("ib_a_x_reply", netA, userA, AGENT, "reply");
  ib("ib_a_x_task", netA, userA, AGENT, "task");
  ib("ib_a_x_status", netA, userA, AGENT, "status"); // 不在 reply/task/message 内,不该被 ack
  ib("ib_a_y_reply", netA, userA, OTHER, "reply");
  ib("ib_b_x_reply", netB, userB, AGENT, "reply");
}

beforeAll(async () => {
  process.env.COMMHUB_DB = process.env.COMMHUB_DB || join(PRIVATE_DB_DIR, "hub.db");
  const stamp = `${Date.now()}_${process.pid}`;
  userA = `ack_agent_a_${stamp}`;
  userB = `ack_agent_b_${stamp}`;
  const a = register(userA, "AckAgent123!", undefined, "seed");
  const b = register(userB, "AckAgent123!", undefined, "seed");
  expect(a.ok).toBe(true);
  expect(b.ok).toBe(true);
  tokenA = a.token!; netA = a.network_id!;
  tokenB = b.token!; netB = b.network_id!;
  userIdA = db.get<{ user_id: string }>("SELECT user_id FROM users WHERE username = ?1", [userA])!.user_id;
  userIdB = db.get<{ user_id: string }>("SELECT user_id FROM users WHERE username = ?1", [userB])!.user_id;
  seed();
  const mod: any = await import("./server.js");
  server = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${server.port}`;
}, 30_000);

afterAll(() => {
  try { server?.stop?.(true); } catch {}
  try { rmSync(PRIVATE_DB_DIR, { recursive: true, force: true }); } catch {}
});

async function ack(token: string, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}/api/messages/ack`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

const uiAcked = (id: string) => db.get<{ acked: number }>("SELECT acked FROM user_inbox WHERE message_id = ?1", [id])!.acked;
const ibAcked = (id: string) => db.get<{ acked: number }>("SELECT acked FROM inbox WHERE id = ?1", [id])!.acked;

async function unreadByAgent(token: string): Promise<Record<string, number>> {
  const response = await fetch(`${base}/api/messages?scope=user&limit=5`, { headers: { Authorization: `Bearer ${token}` } });
  expect(response.status).toBe(200);
  return ((await response.json()) as any).unread_by_agent ?? {};
}

describe("POST /api/messages/ack { agent } (#1909)", () => {
  test("missing everything → message_id_required; agent + ids → ambiguous_ack", async () => {
    const none = await ack(tokenA, {});
    expect(none.status).toBe(400);
    expect(none.body.error).toBe("message_id_required");
    const both = await ack(tokenA, { agent: AGENT, message_ids: ["ui_a_x_1"] });
    expect(both.status).toBe(400);
    expect(both.body.error).toBe("ambiguous_ack");
    // 拒绝的那次不能有副作用
    expect(uiAcked("ui_a_x_1")).toBe(0);
  });

  test("unread_by_agent counts the seeded rows before ack", async () => {
    const by = await unreadByAgent(tokenA);
    expect(by[AGENT]).toBe(4); // 2 user_inbox + reply + task (status 不计)
    expect(by[OTHER]).toBe(2);
  });

  test("agent form acks both tables, only that agent, only the caller", async () => {
    const r = await ack(tokenA, { agent: `  ${AGENT}  ` });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, scope: "agent", agent: AGENT, acked: 4, acked_user_inbox: 2, acked_inbox: 2 });
    expect(uiAcked("ui_a_x_1")).toBe(1);
    expect(uiAcked("ui_a_x_2")).toBe(1);
    expect(ibAcked("ib_a_x_reply")).toBe(1);
    expect(ibAcked("ib_a_x_task")).toBe(1);
    // 不该动的:别的 agent、非 reply/task/message 类型、别的用户
    expect(uiAcked("ui_a_y_1")).toBe(0);
    expect(ibAcked("ib_a_x_status")).toBe(0);
    expect(ibAcked("ib_a_y_reply")).toBe(0);
    expect(uiAcked("ui_b_x_1")).toBe(0);
    expect(ibAcked("ib_b_x_reply")).toBe(0);
    const by = await unreadByAgent(tokenA);
    expect(by[AGENT] ?? 0).toBe(0);
    expect(by[OTHER]).toBe(2);
    expect((await unreadByAgent(tokenB))[AGENT]).toBe(2);
  });

  test("agent form is idempotent: second call changes 0 rows", async () => {
    const r = await ack(tokenA, { agent: AGENT });
    expect(r.status).toBe(200);
    expect(r.body.acked).toBe(0);
  });

  test("id form still works and now reports scope ids", async () => {
    const r = await ack(tokenA, { message_ids: ["ui_a_y_1", "ib_a_y_reply", "ui_b_x_1"] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, scope: "ids", acked: 2, acked_user_inbox: 1, acked_inbox: 1 });
    expect(uiAcked("ui_a_y_1")).toBe(1);
    expect(ibAcked("ib_a_y_reply")).toBe(1);
    expect(uiAcked("ui_b_x_1")).toBe(0); // 别人的 id 匹配不到
  });
});

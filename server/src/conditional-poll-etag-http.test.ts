// 聊天页三条轮询的条件请求（2026-11-23）。
//
// App 的入站 / 出站 / 主动消息三条轮询都走同一个带 If-None-Match 的共享 get()：
// 只要端点回 ETag，它就会自动发条件请求。所以这里钉住：
//   ① /api/tasks?to_name=… 与 /api/tasks?from_name=… 都带 ETag；内容没变 + If-None-Match ⇒ 304 空体；
//   ② /api/messages（默认分支）与 /api/messages?scope=user 同理；
//   ③ **状态一变 ETag 必变**：改任务 status/result、改 user_inbox 的 acked，都要换 ETag；
//   ④ 304 响应保留 ETag 且没有正文（客户端要能继续用同一个 ETag 轮询）。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "anet-cond-poll-"));
process.env.COMMHUB_DB ||= join(DIR, "hub.db");
process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");

const PW = "CondPollPassw0rd!";
let BASE = "";
let hub: any = null;
let token = "";
let db: any;

const H = () => ({ Authorization: `Bearer ${token}` });

async function getJson(path: string, etag?: string) {
  const headers: Record<string, string> = H();
  if (etag) headers["If-None-Match"] = etag;
  const res = await fetch(`${BASE}${path}`, { headers });
  const text = await res.text();
  return { status: res.status, etag: res.headers.get("etag"), text, body: text ? JSON.parse(text) : null };
}

beforeAll(async () => {
  process.env.HOST = "127.0.0.1";
  const { register } = await import("./auth.js");
  const dbMod = await import("./db.js");
  db = dbMod.db;
  const a = register(`condpoll_${Date.now()}`, PW);
  token = a.token!;
  db.run("UPDATE users SET role = 'admin' WHERE user_id = ?1", [a.user!.user_id]);
  // 种两条任务 + 一条用户消息
  db.run("INSERT INTO networks (network_id,network_name,owner_id) VALUES ('net_c','C',?1)", [a.user!.user_id]);
  db.run("INSERT INTO network_members (network_id,user_id,role) VALUES ('net_c',?1,'owner')", [a.user!.user_id]);
  db.run("INSERT INTO tasks (task_id,from_name,to_name,status,content,result,network_id,created_at) VALUES ('t1','node-a','node-b','replied','hi','old result','net_c','2026-11-23 10:00:00')");
  db.run("INSERT INTO tasks (task_id,from_name,to_name,status,content,result,network_id,created_at) VALUES ('t2','node-b','node-a','replied','yo','other','net_c','2026-11-23 10:01:00')");
  db.run("INSERT INTO user_inbox (message_id,network_id,user_id,from_session,kind,title,content,severity,meta_json,acked,created_at) VALUES ('m1','net_c',?1,'node-a','message','t','body','info','{}',0,'2026-11-23 10:00:00')", [a.user!.user_id]);
  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;
}, 30_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("/api/tasks 条件请求（入站 to_name / 出站 from_name）", () => {
  test("to_name：先 200 带 ETag，未变时 304 空体", async () => {
    const a = await getJson("/api/tasks?to_name=node-b&limit=30&skip_stats=1&network_id=net_c");
    expect(a.status).toBe(200);
    expect(a.etag).toBeTruthy();
    expect(a.body.tasks.length).toBe(1);
    const b = await getJson("/api/tasks?to_name=node-b&limit=30&skip_stats=1&network_id=net_c", a.etag!);
    expect(b.status).toBe(304);
    expect(b.text).toBe("");
    expect(b.etag).toBe(a.etag);
  });

  test("from_name：同样带 ETag 且未变时 304", async () => {
    const a = await getJson("/api/tasks?from_name=node-a&limit=30&skip_stats=1&network_id=net_c");
    expect(a.status).toBe(200);
    expect(a.etag).toBeTruthy();
    const b = await getJson("/api/tasks?from_name=node-a&limit=30&skip_stats=1&network_id=net_c", a.etag!);
    expect(b.status).toBe(304);
  });

  test("状态一变 ETag 必变（result 改了）", async () => {
    const a = await getJson("/api/tasks?to_name=node-b&limit=30&skip_stats=1&network_id=net_c");
    db.run("UPDATE tasks SET result = 'new result' WHERE task_id = 't1'");
    const b = await getJson("/api/tasks?to_name=node-b&limit=30&skip_stats=1&network_id=net_c", a.etag!);
    expect(b.status).toBe(200);
    expect(b.etag).not.toBe(a.etag);
  });

  test("状态一变 ETag 必变（status 改了）", async () => {
    const a = await getJson("/api/tasks?to_name=node-b&limit=30&skip_stats=1&network_id=net_c");
    db.run("UPDATE tasks SET status = 'failed' WHERE task_id = 't1'");
    const b = await getJson("/api/tasks?to_name=node-b&limit=30&skip_stats=1&network_id=net_c", a.etag!);
    expect(b.status).toBe(200);
    expect(b.etag).not.toBe(a.etag);
  });
});

describe("/api/messages 条件请求（默认分支 + scope=user）", () => {
  test("scope=user：未变时 304，改 acked 后 ETag 必变", async () => {
    const a = await getJson("/api/messages?scope=user&limit=50");
    expect(a.status).toBe(200);
    expect(a.etag).toBeTruthy();
    const b = await getJson("/api/messages?scope=user&limit=50", a.etag!);
    expect(b.status).toBe(304);
    db.run("UPDATE user_inbox SET acked = 1 WHERE message_id = 'm1'");
    const c = await getJson("/api/messages?scope=user&limit=50", a.etag!);
    expect(c.status).toBe(200);
    expect(c.etag).not.toBe(a.etag);
  });

  test("默认分支（agent 消息）：带 ETag 且未变时 304", async () => {
    const a = await getJson("/api/messages?alias=node-a&limit=50");
    expect(a.status).toBe(200);
    expect(a.etag).toBeTruthy();
    const b = await getJson("/api/messages?alias=node-a&limit=50", a.etag!);
    expect(b.status).toBe(304);
    expect(b.text).toBe("");
  });
});

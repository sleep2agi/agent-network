// #1459 ① P3 —— per-user 收件回读 + ack + 未读数 + redact-at-read。
//
// 承重的是**隔离**：A 只能读到 A 的。所以下面每条隔离断言都额外钉住探针身份 ——
// 首个注册用户会自动成为全局 admin，而 admin 在别处走的是不过滤的分支；
// 若探针恰好是 admin，隔离断言会"通过但什么都没证明"（#500/#506 同款）。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PRIVATE_DB_DIR = mkdtempSync(join(tmpdir(), "anet-user-inbox-read-"));
process.env.COMMHUB_DB ||= join(PRIVATE_DB_DIR, "hub.db");

let server: ReturnType<typeof Bun.serve>;
let base = "";
let adminToken = "", aToken = "", bToken = "";
const MASTER_TOKEN = "legacy-master-token-for-test";
let aUserId = "", bUserId = "", aNet = "", bNet = "";

const get = async (path: string, token: string) => {
  const r = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, body: await r.json() as any };
};
const post = async (path: string, token: string, body: unknown) => {
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() as any };
};

function seedMessage(mid: string, userId: string, netId: string, content: string, meta?: string, acked = 0) {
  const { db } = require("./db.js");
  db.run(
    `INSERT INTO user_inbox (message_id, network_id, user_id, from_session, kind, title, content, severity, meta_json, acked, acked_at)
     VALUES (?1, ?2, ?3, 'node-x', 'agent_message', NULL, ?4, 'info', ?5, ?6, ?7)`,
    [mid, netId, userId, content, meta ?? null, acked, acked ? "2026-01-01 00:00:00" : null],
  );
}

beforeAll(async () => {
  // 传统全局 master token：requireAuth 对 GET /api/* 放行，但 resolveRequestAuth
  // 返回 null（没有 user）。这条路径是分支内 `if (!callerUserId)` 唯一能被触发的
  // 场景 —— 必须在 import server.js 之前设，AUTH_TOKEN 是模块加载期读的常量。
  process.env.COMMHUB_AUTH_TOKEN ||= MASTER_TOKEN;

  const { db } = await import("./db.js");
  const { register, addNetworkMember } = await import("./auth.js");
  const stamp = Date.now();

  // 首个注册用户 = 全局 admin。**故意先注册一个用不到的 admin**，这样下面
  // 两个探针 A/B 都不是 admin —— 隔离断言才有分辨力。
  const admin = register(`ui_admin_${stamp}`, "UiAdmin-Strong-1!");
  expect(admin.ok).toBe(true);
  adminToken = admin.token!;

  const a = register(`ui_a_${stamp}`, "UiA-Strong-1!");
  const b = register(`ui_b_${stamp}`, "UiB-Strong-1!");
  expect(a.ok && b.ok).toBe(true);
  aToken = a.token!; bToken = b.token!;
  aNet = a.network_id!; bNet = b.network_id!;
  aUserId = db.get<{ user_id: string }>("SELECT user_id FROM users WHERE username = ?1", `ui_a_${stamp}`)!.user_id;
  bUserId = db.get<{ user_id: string }>("SELECT user_id FROM users WHERE username = ?1", `ui_b_${stamp}`)!.user_id;

  // 前提断言：探针不是 admin。靠"注册顺序"是隐式前提，会随夹具变化悄悄失效，
  // 所以显式断言。
  // 承重的是 role ≠ "admin"；这里钉死具体值（auth.ts:88 非首用户写 "user"），
  // 因为 `not.toBe("admin")` 在 role 为 undefined（查不到行）时也会通过 —— 松判据
  // 会朝"没问题"那边失败。
  for (const [name, id] of [["A", aUserId], ["B", bUserId]] as const) {
    const role = db.get<{ role: string }>("SELECT role FROM users WHERE user_id = ?1", id)?.role;
    expect([name, role]).toEqual([name, "user"]);
  }

  // 🔴 B 必须在**同一个 network** 里也有一条私信。
  //    第一版夹具让 A/B 各处一网，于是 addNetworkScope 顺手挡住了 B 的行 ——
  //    变异掉 `WHERE user_id = ?1` 后隔离断言照样通过（M1/M2/M4 全部存活）。
  //    同网同事之间，user_id 过滤是**唯一**的隔离手段，夹具必须落在那一格。
  expect(addNetworkMember(aNet, bUserId, "member").ok).toBe(true);

  seedMessage("dm_a1", aUserId, aNet, "A 的第一条");
  seedMessage("dm_a2", aUserId, aNet, "A 的第二条");
  seedMessage("dm_b_same_net", bUserId, aNet, "B 在 A 同网里的私信");
  seedMessage("dm_b1", bUserId, bNet, "B 的私信");
  // A 自己的、但落在 A 不是成员的 network 上的行（例如 A 被移出该网后的遗留）。
  // 它是 addNetworkScope 这次调用的唯一 witnessed-red 对象：user_id 过滤对它无效。
  seedMessage("dm_a_foreign_net", aUserId, bNet, "A 在外网的遗留私信");
  // network_id 为 NULL 的行：P2 写路径在 effectiveNetId 为空时会写出这种行。
  seedMessage("dm_a_nonet", aUserId, null as any, "A 的无网络私信");
  seedMessage("dm_a_read", aUserId, aNet, "A 已读的一条", undefined, 1);
  seedMessage("dm_a_secret", aUserId, aNet,
    "凭据在正文里 ntok_abcdef123456", JSON.stringify({ k: "ghp_" + "A".repeat(24) }));

  const mod = await import("./server.js");
  server = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  try { server?.stop(true); } catch {}
  try { rmSync(PRIVATE_DB_DIR, { recursive: true, force: true }); } catch {}
});

describe("#1459 ① P3 GET /api/messages?scope=user", () => {
  test("🔴 只返回调用者自己的消息 —— A 读不到 B 的", async () => {
    const { status, body } = await get("/api/messages?scope=user", aToken);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    const ids = body.messages.map((m: any) => m.message_id);
    expect(ids).toContain("dm_a1");
    expect(ids).toContain("dm_a_read");          // 不加 unacked 时已读也要回来
    expect(ids).not.toContain("dm_b_same_net");  // 承重：同网，只有 user_id 过滤挡得住
    expect(ids).not.toContain("dm_b1");          // 跨网，scope 助手挡
    expect(ids).not.toContain("dm_a_foreign_net"); // 承重：A 自己的行，只有 scope 助手挡得住
    expect(body.messages.every((m: any) => m.user_id === aUserId)).toBe(true);
  });

  test("🔴 收件人取自 auth ctx —— query 里指定别人的 user_id 无效", async () => {
    const { body } = await get(`/api/messages?scope=user&user_id=${bUserId}`, aToken);
    const ids = body.messages.map((m: any) => m.message_id);
    expect(ids).not.toContain("dm_b_same_net");
    expect(ids).not.toContain("dm_b1");
    expect(body.messages.every((m: any) => m.user_id === aUserId)).toBe(true);
  });

  test("🔴 redact-at-read：正文与 meta 里的凭据形状被遮住", async () => {
    const { body } = await get("/api/messages?scope=user", aToken);
    const row = body.messages.find((m: any) => m.message_id === "dm_a_secret");
    expect(row).toBeTruthy();
    expect(row.content).toContain("ntok_***redacted***");
    expect(row.content).not.toContain("ntok_abcdef123456");
    expect(row.meta_json).toContain("ghp_***redacted***");
  });

  // 记录的是**当前行为**，不是我认为应该的行为：network_id 为 NULL 的行对
  // 网络受限的调用者不可见（addNetworkScope 生成的是 `network_id IN (...)`，
  // NULL 不匹配任何 IN 列表）。P2 写路径在 effectiveNetId 为空时会写出这种行，
  // 于是它写得进去、读不出来。已在 PR 正文里点名，交 Hub马/通信龙 定夺，
  // 这里先把行为钉住，免得日后无声改变。
  test("network_id 为 NULL 的行不会回给受网络限制的调用者（当前行为）", async () => {
    const { body } = await get("/api/messages?scope=user", aToken);
    const ids = body.messages.map((m: any) => m.message_id);
    expect(ids).not.toContain("dm_a_nonet");
  });

  test("unread 是未读数而非总数（A：4 条里 3 条未读）", async () => {
    const { body } = await get("/api/messages?scope=user", aToken);
    expect(body.messages.length).toBe(4);
    expect(body.unread).toBe(3);
    expect(body.pending_count).toBe(body.unread);
  });

  test("unacked=1 排掉已读那条", async () => {
    const { body } = await get("/api/messages?scope=user&unacked=1", aToken);
    const ids = body.messages.map((m: any) => m.message_id);
    expect(ids).not.toContain("dm_a_read");      // 承重：集合里确实有已读行才有分辨力
    expect(ids.sort()).toEqual(["dm_a1", "dm_a2", "dm_a_secret"]);
  });

  test("未鉴权 ⇒ 401（/api 全局闸）", async () => {
    const r = await fetch(`${base}/api/messages?scope=user`);
    expect(r.status).toBe(401);
  });

  test("🔴 legacy master token 过得了全局闸但没有 user ⇒ 401，不能回一个空列表", async () => {
    // 这条才是分支内 `if (!callerUserId)` 的 witnessed-red：把它换成
    // `?? ""` 后本条从 401 变成 200 + 空列表 —— "看起来正常"的错误答案。
    const { status, body } = await get("/api/messages?scope=user", MASTER_TOKEN);
    expect([status, body.error]).toEqual([401, "auth_required"]);
  });

  test("alias 分支未受影响（dashboard 依赖它）", async () => {
    const { status, body } = await get("/api/messages", adminToken);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.unread).toBeUndefined();          // 老分支不该多出新字段
  });
});

describe("#1459 ① P3 POST /api/messages/ack", () => {
  test("ack 自己的消息 ⇒ acked 置位、未读数下降", async () => {
    const before = (await get("/api/messages?scope=user", aToken)).body.unread;
    const { status, body } = await post("/api/messages/ack", aToken, { message_id: "dm_a1" });
    expect(status).toBe(200);
    expect(body.acked).toBe(1);
    const after = (await get("/api/messages?scope=user", aToken)).body.unread;
    expect(after).toBe(before - 1);
  });

  test("🔴 ack 不了同网同事的消息 —— 改动行数为 0，且对方仍是未读", async () => {
    const { body } = await post("/api/messages/ack", aToken, { message_id: "dm_b_same_net" });
    expect(body.acked).toBe(0);
    const bView = (await get("/api/messages?scope=user", bToken)).body;
    expect(bView.messages.find((m: any) => m.message_id === "dm_b_same_net").acked).toBe(0);
  });

  test("ack 跨网的消息同样为 0", async () => {
    const { body } = await post("/api/messages/ack", aToken, { message_id: "dm_b1" });
    expect(body.acked).toBe(0);
  });

  test("缺参 ⇒ 400；未鉴权 ⇒ 401", async () => {
    expect((await post("/api/messages/ack", aToken, {})).status).toBe(400);
    const r = await fetch(`${base}/api/messages/ack`, { method: "POST", body: "{}" });
    expect(r.status).toBe(401);
  });
});

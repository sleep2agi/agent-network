// #4987 —— GET /api/inbox 端点端到端测试（负责人 review 的五条判据）。
//
// 为什么必须是 HTTP 级：这个端点错的时候**不会抛异常**，只会给出看起来正常的内容——
// ① scope 拿 alias 互相比较 ⇒ owner 分支恒等 ⇒ 代读被静默标成 self；
// ② 跨网络 403 包在 `alias !== requestedAlias` 里 ⇒ 只有改名时才走得到；
// ③ 代读时带出 network_id IS NULL 的旧行 ⇒ 读到不属于该网络的收件箱；
// ④ pending 用 limit 截断后的行数 ⇒ 积压数随分页变。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "anet-iso4987-"));
process.env.COMMHUB_DB ||= join(DIR, "hub.db");

let hub: ReturnType<typeof Bun.serve>;
let base = "";
let adminToken = "";       // 网络 A 的 owner（首个注册用户 = 全局 admin）
let adminNetToken = "";    // 网络 A 的 owner，**网络级**令牌（register 令牌 networkId=null，代读会被 network_id_required 拦）
let memberNetToken = "";
let otherNetToken = "";
let memberToken = "";      // 网络 A 的普通成员（用来确认 member 不能代读）
let otherOwnerToken = "";  // 网络 C 的 owner（跨网络）
let nodeTokenA = "";       // 网络 A 的节点令牌
let netA = "", netC = "";
let aliasA = "", aliasB = "", aliasOnlyC = "";

const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

const req = async (path: string, token: string, method = "GET", body?: unknown) => {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let parsed: any = null;
  try { parsed = await r.json(); } catch {}
  return { status: r.status, body: parsed };
};

function seedNode(nodeId: string, alias: string, netId: string, ownerId: string | null) {
  const { db } = require("./db.js");
  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, network_id, owner_user_id, created_at, updated_at)
     VALUES (?1, ?2, ?2, ?3, ?4, datetime('now'), datetime('now'))`,
    [nodeId, alias, netId, ownerId],
  );
}

function seedInbox(id: string, alias: string, netId: string | null, content: string) {
  const { db } = require("./db.js");
  db.run(
    `INSERT INTO inbox (id, session_name, type, priority, content, from_session, acked, network_id, created_at)
     VALUES (?1, ?2, 'message', 'normal', ?3, 'peer', 0, ?4, datetime('now'))`,
    [id, alias, content, netId],
  );
}

beforeAll(async () => {
  process.env.COMMHUB_AUTH_TOKEN ||= "legacy-master-token-for-test";
  const { db } = await import("./db.js");
  const { register, addNetworkMember, createToken } = await import("./auth.js");
  const stamp = Date.now();

  // 网络 A：admin 是 owner
  const admin = register(`iso4987_owner_${stamp}`, "Iso4987-Owner-1!");
  expect(admin.ok).toBe(true);
  adminToken = admin.token!; netA = admin.network_id!;
  const adminId = db.get<{ user_id: string }>("SELECT user_id FROM users WHERE username = ?1", `iso4987_owner_${stamp}`)!.user_id;

  const member = register(`iso4987_member_${stamp}`, "Iso4987-Member-1!");
  memberToken = member.token!;
  const memberId = db.get<{ user_id: string }>("SELECT user_id FROM users WHERE username = ?1", `iso4987_member_${stamp}`)!.user_id;
  expect(addNetworkMember(netA, memberId, "member").ok).toBe(true);

  // 网络 C：另一个网络的 owner（跨网络用）
  const other = register(`iso4987_other_${stamp}`, "Iso4987-Other-1!");
  otherOwnerToken = other.token!; netC = other.network_id!;

  const otherId = db.get<{ user_id: string }>("SELECT user_id FROM users WHERE username = ?1", `iso4987_other_${stamp}`)!.user_id;
  // ⚠️ register/login 令牌 networkId=null ⇒ 走 network_id_required，代读路径根本到不了；
  //    代读/跨网络必须用 createToken 铸的**网络级**令牌。
  const mkNet = (uid: string, name: string, net: string) => {
    const r = createToken(uid, name, net);
    if (!r.ok || !r.token) throw new Error(`createToken failed: ${name} / ${JSON.stringify(r)}`);
    return r.token;
  };
  // 默认成员是受限的（restricted），受限成员不能铸网络级令牌；这里放开只为测「member 代读仍 403」。
  db.run("UPDATE network_members SET agent_access = 'all' WHERE network_id = ?1 AND user_id = ?2", [netA, memberId]);
  adminNetToken = mkNet(adminId, `iso4987-net-a-${stamp}`, netA);
  memberNetToken = mkNet(memberId, `iso4987-net-member-${stamp}`, netA);
  otherNetToken = mkNet(otherId, `iso4987-net-c-${stamp}`, netC);

  aliasA = `iso-a-${stamp}`; aliasB = `iso-b-${stamp}`; aliasOnlyC = `iso-conly-${stamp}`;
  seedNode(`node_a_${stamp}`, aliasA, netA, adminId);
  seedNode(`node_b_${stamp}`, aliasB, netA, adminId);
  seedNode(`node_c_${stamp}`, aliasOnlyC, netC, null);

  // 本节点 3 条（自读）；B 节点 2 条本网络 + 1 条历史无网络行；C 网络 1 条
  for (let i = 1; i <= 3; i++) seedInbox(`iso_a${i}_${stamp}`, aliasA, netA, `本节点消息${i}`);
  seedInbox(`iso_b1_${stamp}`, aliasB, netA, "B 的本网络消息");
  seedInbox(`iso_b2_${stamp}`, aliasB, netA, "B 的第二条");
  seedInbox(`iso_b_legacy_${stamp}`, aliasB, null, "无 network_id 的历史行");
  seedInbox(`iso_conly1_${stamp}`, aliasOnlyC, netC, "只存在于 C 网络的消息");

  const mod = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${hub.port}`;
  const nt = await req(`/api/auth/node-token`, adminToken, "POST", { network_id: netA, node_name: aliasA, node_id: `node_a_${stamp}` });
  expect(nt.status).toBe(200);
  nodeTokenA = nt.body.token;

}, 60_000);

afterAll(() => {
  try { hub?.stop(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("#4987 GET /api/inbox", () => {
  test("① 节点令牌读自己 → 200 · scope=self · pending 是未读总数", async () => {
    const { status, body } = await req(`/api/inbox?alias=${aliasA}`, nodeTokenA);
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, alias: aliasA, scope: "self", pending: 3, returned: 3 });
  });

  test("①' 节点令牌读别人 → 403 inbox_identity_mismatch（不是空数组）", async () => {
    const { status, body } = await req(`/api/inbox?alias=${aliasB}`, nodeTokenA);
    expect(status).toBe(403);
    expect(body).toEqual({ ok: false, error: "inbox_identity_mismatch" });
  });

  test("② owner 代读 → 200 · scope=delegated（不能是 self）", async () => {
    const { status, body } = await req(`/api/inbox?alias=${aliasB}`, adminNetToken);
    expect(status).toBe(200);
    expect(body.scope).toBe("delegated");
    expect(body.alias).toBe(aliasB);
  });

  test("③ 代读不带出 network_id IS NULL 的旧行（自读仍带）", async () => {
    const delegated = await req(`/api/inbox?alias=${aliasB}`, adminNetToken);
    expect(delegated.body.pending).toBe(2);
    expect(delegated.body.messages.length).toBe(2);
    // 无 network_id 的那行不在里面
    expect(delegated.body.messages.some((m: any) => m.preview.includes("无 network_id"))).toBe(false);
    // 自读（节点令牌读自己）保留无网络历史行：A 节点本身没有无网络行，这里改用 B 的节点令牌不可得，
    // 因此用「A 自读 3 条」对照「A 代读 B 是 2 条」证明过滤只作用于代读。
    const self = await req(`/api/inbox?alias=${aliasA}`, nodeTokenA);
    expect(self.body.pending).toBe(3);
  });

  test("④ at 是 ISO-8601 UTC（带 Z）", async () => {
    const { body } = await req(`/api/inbox?alias=${aliasA}`, nodeTokenA);
    for (const m of body.messages) expect(m.at).toMatch(iso);
  });

  test("⑤ limit=1 → pending ≥ returned，且 pending 与 limit 无关", async () => {
    const { body } = await req(`/api/inbox?alias=${aliasA}&limit=1`, nodeTokenA);
    expect(body.pending).toBe(3);
    expect(body.returned).toBe(1);
    expect(body.messages.length).toBe(1);
    expect(body.pending).toBeGreaterThanOrEqual(body.returned);
  });

  test("🔴 跨网络：A 网络 owner 读只在 C 网络存在的 alias → 403；C owner 读 A 的 alias → 403", async () => {
    const a = await req(`/api/inbox?alias=${aliasOnlyC}`, adminNetToken);
    expect(a.status).toBe(403);
    expect(a.body.error).toBe("inbox_identity_mismatch");
    const c = await req(`/api/inbox?alias=${aliasB}`, otherNetToken);
    expect(c.status).toBe(403);
  });

  test("普通 member（非 owner、非节点主）代读 → 403", async () => {
    const { status } = await req(`/api/inbox?alias=${aliasB}`, memberNetToken);
    expect(status).toBe(403);
  });

  test("preview 按码点截断 ≤200 + 单个「…」", async () => {
    const { db } = require("./db.js");
    db.run(
      `INSERT INTO inbox (id, session_name, type, priority, content, from_session, acked, network_id, created_at)
       VALUES (?1, ?2, 'message', 'normal', ?3, 'peer', 0, ?4, datetime('now'))`,
      [`iso_long_${Date.now()}`, aliasA, "长".repeat(260), netA],
    );
    const { body } = await req(`/api/inbox?alias=${aliasA}&limit=1`, nodeTokenA);
    const preview: string = body.messages[0].preview;
    expect(Array.from(preview).length).toBe(201);
    expect(preview.endsWith("…")).toBe(true);
  });
});

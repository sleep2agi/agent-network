// #1521 全团队规则 —— GET/PUT /api/networks/:id/network-rules(Hub 首片:network_rules 存储 + revision)。
// HTTP 集成测试(真实 Bun.serve、私有端口、临时库)。
//
// 判据:
//   读 = 网络成员 / 本网络节点令牌 / Hub 管理员;别的网络的人和节点一律 403;无令牌 401;
//   写 = owner / admin / Hub 管理员;成员、节点令牌 403 network_rules_write_denied;
//   revision 内容一字不变不涨(幂等),变了 +1,清空也算一次(+1,受管块据此回滚);
//   空文本读出来是 {content:"",revision:0} 而不是 404;上限 256 KiB(与 write_node_rules_file 同尺);
//   写入留审计(只记 revision/字节数,不记正文);删网络时 network_rules 随网络清掉。
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { register, createNetworkTokenForNode } from "./auth.js";
import { db } from "./db.js";

const DIR = mkdtempSync(join(tmpdir(), "anet-network-rules-"));
let BASE = "";
let hub: any = null;
const PW = "NetworkRulesPassw0rd!xyz";
let NET = "";
let NET_OTHER = "";
const U: Record<string, { token: string; id: string }> = {};
let NODE_TOKEN = "";
let FOREIGN_TOKEN = "";

async function send(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null;
  const text = await res.text();
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, body: json };
}
const get = (token: string) => send(token, "GET", `/api/networks/${NET}/network-rules`);
const put = (token: string, content: unknown) => send(token, "PUT", `/api/networks/${NET}/network-rules`, { content });

beforeAll(async () => {
  process.env.COMMHUB_DB ||= join(DIR, "hub.db");
  process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
  process.env.HOST = "127.0.0.1";
  const stamp = Date.now();
  const a = register(`nr_owner_${stamp}`, PW, undefined, "规则 Owner");
  U.owner = { token: a.token!, id: a.user!.user_id };
  NET = a.network_id!;
  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;
  // 建成员要 Hub 管理员;建完立刻把 owner 攘回普通成员,后面走的才是「网络 owner 角色」这条路。
  db.run("UPDATE users SET role = 'admin' WHERE user_id = ?1", [U.owner.id]);
  const username = `nr_member_${stamp}`;
  expect((await send(U.owner.token, "POST", "/api/admin/users", { username, password: PW, network_id: NET, role: "member" })).status).toBe(200);
  const login = await send("", "POST", "/api/auth/login", { username, password: PW });
  U.member = { token: login.body.token, id: login.body.user.user_id };
  db.run("UPDATE users SET role = 'user' WHERE user_id = ?1", [U.owner.id]);
  // 另外两个网络:一个普通外网用户,一个是别的网络的 Hub 管理员(全局 role=admin)。
  const b = register(`nr_other_${stamp}`, PW, undefined, "外网用户");
  U.other = { token: b.token!, id: b.user!.user_id };
  NET_OTHER = b.network_id!;
  const c = register(`nr_hubadmin_${stamp}`, PW, undefined, "外网管理员");
  U.hubadmin = { token: c.token!, id: c.user!.user_id };
  db.run("UPDATE users SET role = 'admin' WHERE user_id = ?1", [U.hubadmin.id]);
  const t = createNetworkTokenForNode(U.owner.id, NET, "规则节点", "node_rules_1");
  expect(t.error ?? null).toBe(null);
  NODE_TOKEN = t.token!;
  FOREIGN_TOKEN = U.other.token;
}, 60_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("#1521 读:成员 / 本网络节点令牌 / Hub 管理员", () => {
  test("没写过时返回空文本 + revision 0(不是 404)", async () => {
    const r = await get(U.owner.token);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, network_id: NET, content: "", revision: 0 });
  });
  test("成员、本网络节点令牌可读;无令牌 401;外网的人 / 节点 403", async () => {
    expect((await get(U.member.token)).status).toBe(200);
    expect((await get(NODE_TOKEN)).status).toBe(200);
    expect((await send("", "GET", `/api/networks/${NET}/network-rules`)).status).toBe(401);
    expect((await get(FOREIGN_TOKEN)).status).toBe(403);
    // 别的网络的节点令牌:走不到本网络
    const foreignNode = createNetworkTokenForNode(U.other.id, NET_OTHER, "外网节点", "node_rules_x");
    expect(foreignNode.error ?? null).toBe(null);
    expect((await get(foreignNode.token!)).status).toBe(403);
  });
  test("不存在的网络:非成员先撞 403,Hub 管理员才看得见 network_not_found(与 agent-teams 同序)", async () => {
    expect((await send(U.owner.token, "GET", "/api/networks/net_missing/network-rules")).status).toBe(403);
    expect((await send(U.hubadmin.token, "GET", "/api/networks/net_missing/network-rules")).body.error).toBe("network_not_found");
  });
});

describe("#1521 写:只有 owner / admin / Hub 管理员", () => {
  test("成员与节点令牌 403 network_rules_write_denied", async () => {
    const m = await put(U.member.token, "# 我也想改");
    expect(m.status).toBe(403); expect(m.body.error).toBe("network_rules_write_denied");
    const n = await put(NODE_TOKEN, "# 节点也想改");
    expect(n.status).toBe(403); expect(n.body.error).toBe("network_rules_write_denied");
    expect((await get(U.owner.token)).body.revision).toBe(0); // 被拒的写不留痕
  });
  test("owner 写入 → revision 1;同内容再写不涨;改内容 +1;清空也算一次", async () => {
    const body = "# 全团队规则\n\n- 所有节点每日汇报";
    const w = await put(U.owner.token, body);
    expect(w.status).toBe(200);
    expect(w.body).toMatchObject({ ok: true, revision: 1, changed: true });
    expect(w.body.content).toBe(body);

    const same = await put(U.owner.token, body);
    expect(same.status).toBe(200);
    expect(same.body).toMatchObject({ revision: 1, changed: false });

    const w2 = await put(U.owner.token, body + "\n- 第二条");
    expect(w2.body).toMatchObject({ revision: 2, changed: true });
    expect((await get(U.member.token)).body.revision).toBe(2);

    const clear = await put(U.owner.token, "");
    expect(clear.body).toMatchObject({ revision: 3, changed: true, content: "" });
    expect((await get(U.owner.token)).body).toMatchObject({ content: "", revision: 3 });
  });
  test("校验:非字符串 400、超过 256 KiB 400、坏 JSON 400、写路径非 PUT 405", async () => {
    expect((await put(U.owner.token, 42)).status).toBe(400);
    expect((await put(U.owner.token, undefined)).body.error).toBe("content required");
    expect((await put(U.owner.token, "x".repeat(256 * 1024 + 1))).body.error).toBe("content_too_long");
    expect((await put(U.owner.token, "x".repeat(256 * 1024))).status).toBe(200); // 正好卡线可写
    const bad = await fetch(`${BASE}/api/networks/${NET}/network-rules`, { method: "PUT", headers: { Authorization: `Bearer ${U.owner.token}`, "Content-Type": "application/json" }, body: "{oops" });
    expect(bad.status).toBe(400);
    expect((await send(U.owner.token, "DELETE", `/api/networks/${NET}/network-rules`)).status).toBe(405);
    expect((await send(U.owner.token, "POST", `/api/networks/${NET}/network-rules`, { content: "x" })).status).toBe(405);
  });
  test("Hub 管理员(别的网络)可读可写", async () => {
    const before = (await get(U.owner.token)).body.revision as number;
    const w = await put(U.hubadmin.token, "# Hub 管理员下发的规则");
    expect(w.status).toBe(200);
    expect(w.body).toMatchObject({ ok: true, revision: before + 1, changed: true });
    expect((await get(U.hubadmin.token)).status).toBe(200);
  });
  test("审计只记 revision / 字节数,不记正文", async () => {
    const rows = db.all<{ action: string; detail: string }>(
      "SELECT action, detail FROM audit_log WHERE network_id = ?1 AND action = 'network_rules_put' ORDER BY id DESC LIMIT 1",
      NET,
    );
    expect(rows.length).toBe(1);
    const detail = JSON.parse(rows[0].detail);
    expect(typeof detail.revision).toBe("number");
    expect(typeof detail.bytes).toBe("number");
    expect(rows[0].detail).not.toContain("Hub 管理员下发的规则");
  });
});

describe("#1521 删网络时随网络清掉(NETWORK_CLEANUP_TABLES)", () => {
  test("写过规则的空网络删除后行消失", async () => {
    const stamp = Date.now();
    const r = register(`nr_del_${stamp}`, PW, undefined, "删我");
    const net = r.network_id!;
    expect((await send(r.token!, "PUT", `/api/networks/${net}/network-rules`, { content: "# 将随网络删除" })).status).toBe(200);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM network_rules WHERE network_id = ?1", net)!.n).toBe(1);
    const del = await send(r.token!, "DELETE", `/api/networks/${net}`);
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true); // 归属者删自己的网络:只回 ok,cleaned 计数是 Hub 管理员那条路径才给
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM network_rules WHERE network_id = ?1", net)!.n).toBe(0);
  });
});

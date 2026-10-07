// 节点令牌不继承签发者的账号权限与 Hub 管理员身份。
//
// 生产上几乎所有节点令牌(ntok_)都由管理员签发,resolveToken 把它解析成那个管理员用户。
// 以前一部分端点直接看 `resolved.user.role === "admin"` 或把令牌当成用户本人,于是任何一个节点
// 都能:列全部用户、读服务端日志与审计日志、给签发者再签用户令牌 / 节点令牌、改签发者资料与密码、
// 建 / 改 / 删网络、管成员与邀请、读别的网络详情、看全部网络的 SSE 拓扑。
// 这里每一条在修复前(main)都是红的;管理员自己的用户令牌作为正控,照常可用。

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { register, createNetwork, createNetworkTokenForNode } from "./auth.js";
import { db } from "./db.js";

const DIR = mkdtempSync(join(tmpdir(), "anet-ntok-priv-"));
let BASE = "";
let hub: any = null;
const PW = "NtokPrivPassw0rd!";
let adminToken = "", adminId = "", NET = "", OTHER_NET = "", ntok = "";

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
async function call(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...auth(token), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}

beforeAll(async () => {
  process.env.COMMHUB_DB ||= join(DIR, "hub.db");
  process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
  process.env.HOST = "127.0.0.1";
  const admin = register(`ntok_admin_${Date.now()}`, PW);
  adminToken = admin.token!; adminId = admin.user!.user_id; NET = admin.network_id!;
  db.run("UPDATE users SET role = 'admin' WHERE user_id = ?1", [adminId]);
  const other = createNetwork(adminId, "ntok-other");
  OTHER_NET = (other as any).network_id;
  const minted = createNetworkTokenForNode(adminId, NET, "ntok-node", "node_ntok_priv");
  expect(minted.ok).toBe(true);
  ntok = minted.token!;
  register(`ntok_someone_${Date.now()}`, PW);
  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;
}, 30_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("hub-admin powers need a user token", () => {
  test("GET /api/users", async () => {
    expect((await call(ntok, "GET", "/api/users")).status).toBe(403);
    expect((await call(adminToken, "GET", "/api/users")).status).toBe(200);
  });
  test("GET /api/server-logs", async () => {
    expect((await call(ntok, "GET", "/api/server-logs")).status).toBe(403);
    expect((await call(adminToken, "GET", "/api/server-logs")).status).toBe(200);
  });
  test("GET /api/audit-log", async () => {
    expect((await call(ntok, "GET", "/api/audit-log")).status).toBe(403);
    expect((await call(adminToken, "GET", "/api/audit-log")).status).toBe(200);
  });
  test("GET /api/networks/:id of a network the token is not bound to", async () => {
    expect((await call(ntok, "GET", `/api/networks/${OTHER_NET}`)).status).toBe(403);
    expect((await call(ntok, "GET", `/api/networks/${NET}`)).status).toBe(200);
  });
  test("GET /api/stats/sse is limited to the bound network", async () => {
    const ctrl = new AbortController();
    const sub = await fetch(`${BASE}/events/some-agent?network_id=${OTHER_NET}`, { headers: auth(adminToken), signal: ctrl.signal }).catch(() => null);
    const r = await call(ntok, "GET", "/api/stats/sse");
    ctrl.abort();
    expect(r.status).toBe(200);
    expect(Object.keys(r.body.sessions).every((k) => k.split(":").includes(NET))).toBe(true);
    expect(JSON.stringify(r.body)).not.toContain(OTHER_NET);
    void sub;
  });
  test("POST /api/admin/users and agent-grants", async () => {
    expect((await call(ntok, "POST", "/api/admin/users", { username: "ntok_made", password: PW })).status).toBe(403);
    expect((await call(ntok, "GET", `/api/networks/${NET}/members/${adminId}/agent-grants`)).status).toBe(403);
  });
});

describe("account and network management need a user token", () => {
  test("token management: cannot list, mint user tokens, mint node tokens or revoke", async () => {
    expect((await call(ntok, "GET", "/api/auth/tokens")).status).toBe(403);
    const minted = await call(ntok, "POST", "/api/auth/tokens", { name: "escalate" });
    expect(minted.status).toBe(403);
    expect(minted.body.token).toBeUndefined();
    expect((await call(ntok, "POST", "/api/auth/node-token", { network_id: OTHER_NET, node_name: "x" })).status).toBe(403);
    expect((await call(ntok, "DELETE", "/api/auth/tokens/tok_whatever")).status).toBe(403);
    expect((await call(adminToken, "GET", "/api/auth/tokens")).status).toBe(200);
  });
  test("cannot edit the owner's profile or password", async () => {
    expect((await call(ntok, "PUT", "/api/auth/me", { display_name: "pwned" })).status).toBe(403);
    expect(db.get<{ display_name: string }>("SELECT display_name FROM users WHERE user_id = ?1", adminId)?.display_name).not.toBe("pwned");
    expect((await call(ntok, "POST", "/api/auth/password", { old_password: PW, new_password: "AnotherPassw0rd!" })).status).toBe(403);
  });
  test("cannot create, rename or delete networks", async () => {
    expect((await call(ntok, "POST", "/api/networks", { name: "ntok-made" })).status).toBe(403);
    expect((await call(ntok, "PUT", `/api/networks/${OTHER_NET}`, { name: "renamed" })).status).toBe(403);
    expect((await call(ntok, "DELETE", `/api/networks/${OTHER_NET}`)).status).toBe(403);
    expect(db.get("SELECT 1 FROM networks WHERE network_id = ?1", OTHER_NET)).toBeTruthy();
  });
  test("cannot manage members, invites or join", async () => {
    expect((await call(ntok, "GET", `/api/networks/${NET}/members`)).status).toBe(403);
    expect((await call(ntok, "POST", `/api/networks/${NET}/members`, { user_id: "u_x" })).status).toBe(403);
    expect((await call(ntok, "POST", `/api/networks/${NET}/invite`, { role: "admin" })).status).toBe(403);
    expect((await call(ntok, "POST", "/api/networks/join", { invite_code: "inv_x" })).status).toBe(403);
    expect((await call(adminToken, "GET", `/api/networks/${NET}/members`)).status).toBe(200);
  });
  test("renames: a node token may only rename ITSELF in its bound network", async () => {
    // 别的网络 / 别的节点 → user_token_required
    expect((await call(ntok, "POST", "/api/node-rename/prepare", { network_id: OTHER_NET, old_alias: "ntok-node", new_alias: "b" })).status).toBe(403);
    db.run(`INSERT INTO sessions (resume_id, alias, status, network_id) VALUES ('r_other_node', 'other-node', 'idle', ?1)`, [NET]);
    expect((await call(ntok, "POST", "/api/node-rename/prepare", { network_id: NET, old_alias: "other-node", new_alias: "b" })).status).toBe(403);
    // 另一个节点(管理员用户令牌)开的事务,本节点不能提交
    const foreign = await call(adminToken, "POST", "/api/node-rename/prepare", { network_id: NET, old_alias: "other-node", new_alias: "other-node-2" });
    expect(foreign.body.ok).toBe(true);
    expect((await call(ntok, "POST", "/api/node-rename/commit", { txn_id: foreign.body.txn_id })).status).toBe(403);
    expect((await call(adminToken, "POST", "/api/node-rename/abort", { txn_id: foreign.body.txn_id })).body.ok).toBe(true);
    // 自己:照常(anet node rename 就是这么用的)
    db.run(`INSERT INTO sessions (resume_id, alias, status, network_id) VALUES ('r_self_node', 'ntok-node', 'idle', ?1)`, [NET]);
    const mine = await call(ntok, "POST", "/api/node-rename/prepare", { network_id: NET, old_alias: "ntok-node", new_alias: "ntok-node-2" });
    expect(mine.body.ok).toBe(true);
    expect((await call(ntok, "POST", "/api/node-rename/abort", { txn_id: mine.body.txn_id })).body.ok).toBe(true);
  });
  test("rename rejects line breaks, tabs and other control characters before reserving an alias", async () => {
    for (const newAlias of ["hidden\nnode", "hidden\tnode", "hidden\u001fnode", "hidden\u007fnode", "hidden\u2028node", "hidden\u2029node"]) {
      const r = await call(ntok, "POST", "/api/node-rename/prepare", { network_id: NET, old_alias: "ntok-node", new_alias: newAlias });
      expect(r.status).toBe(400);
      expect(r.body).toMatchObject({ ok: false, error: "node_alias_invalid", code: "node_alias_invalid", reason: "control_character" });
      expect(r.body.message).toContain("control character U+");
    }
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM rename_txn WHERE network_id = ?1 AND status = 'prepared'", NET)?.n).toBe(0);
  });
});

describe("/api/auth/me says what the credential is", () => {
  test("node token: owner user for compatibility, but credential.kind=node and only the bound network", async () => {
    const r = await call(ntok, "GET", "/api/auth/me");
    expect(r.status).toBe(200);
    expect(r.body.credential).toMatchObject({ kind: "node", network_id: NET, node_alias: "ntok-node", acts_as_owner: false });
    expect(r.body.current_network).toBe(NET);
    expect(r.body.networks.map((n: any) => n.network_id)).toEqual([NET]);
    const u = await call(adminToken, "GET", "/api/auth/me");
    expect(u.body.credential).toEqual({ kind: "user" });
    expect(u.body.networks.map((n: any) => n.network_id).sort()).toEqual([NET, OTHER_NET].sort());
  });
  test("node token keeps its own network powers (still a member): status and tasks read fine", async () => {
    expect((await call(ntok, "GET", "/api/status")).status).toBe(200);
    expect((await call(ntok, "GET", "/api/tasks")).status).toBe(200);
  });
});

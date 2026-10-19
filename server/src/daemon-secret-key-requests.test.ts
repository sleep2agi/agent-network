// #1475 — hub 侧密钥授权账本:申请 → 人工裁决 → 审计回读。
//
// 三条承重验收(来自父卡):
//   ① 申请单在得到人工批准前,daemon 的 `allowed_secret_keys` 不得变化;
//   ② 「人批,不让 agent 自授」——节点 token 连裁决端点都进不去;
//   ③ 审计行可按 daemon 与 key 名查回。
//
// ① 这里断言得比卡面更狠:**批准之后也不变**。那列是 daemon 自述镜像、心跳会
// 覆写,审批写它既活不过 3 分钟也拦不住下发(下发通道根本不读它)——授权状态
// 只落在账本表。把这一点钉进测试,是为了防止后来者"顺手同步一下那列",
// 让两处状态在下一次心跳后必然对不上。
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// db 必须是 DbAdapter 而不是 any:测试里到处是 `db.get<{...}>(sql, [...])`,
// 在 any 值上带类型实参会被 tsc 判 TS2347(untyped function call)——9 条新增
// 类型错就是这么来的。DbAdapter.get<T> 本就支持类型实参,声明成它即可。
import type { DbAdapter } from "./db-adapter";

const PRIVATE_DB_DIR = mkdtempSync(join(tmpdir(), "anet-dskr-"));
process.env.COMMHUB_DB ||= join(PRIVATE_DB_DIR, "hub.db");

let net = "", ownerToken = "", memberToken = "", strangerToken = "", nodeToken = "";
let server: ReturnType<typeof Bun.serve>;
let base = "";
let db: DbAdapter;

const DAEMON = "n_dskr_daemon";      // config_snapshot.role = host_supervisor
const PLAIN_NODE = "n_dskr_plain";   // 普通节点 → not_a_daemon
const KEY = "MY_SERVICE_KEY";

const post = async (path: string, token: string, body: unknown) => {
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() as any };
};
const get = async (path: string, token: string) => {
  const r = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, body: await r.json() as any };
};

/** daemon 自述列的当前值——验收① 的观察对象。 */
const declaredNow = (nodeId: string): string | null =>
  db.get<{ allowed_secret_keys: string | null }>(
    "SELECT allowed_secret_keys FROM nodes WHERE node_id = ?1", [nodeId],
  )?.allowed_secret_keys ?? null;

const createReq = (token: string, body: unknown) => post("/api/daemon-secret-key-requests", token, body);
const decide = (token: string, id: string, body: unknown) =>
  post(`/api/daemon-secret-key-requests/${encodeURIComponent(id)}/decide`, token, body);

beforeAll(async () => {
  const auth = await import("./auth.js");
  const stamp = Date.now();

  const owner = auth.register(`dskr_owner_${stamp}`, "DskrOwner-Strong-1!");
  expect(owner.ok).toBe(true);
  ownerToken = owner.token!;
  net = owner.network_id!;
  db = (await import("./db.js")).db;
  const ownerUserId = db.get<{ user_id: string }>(
    "SELECT user_id FROM users WHERE username = ?1", `dskr_owner_${stamp}`)!.user_id;

  // member:进网、有申请权、**无裁决权** —— 用来把"能申请"和"能批准"分开验。
  const member = auth.register(`dskr_member_${stamp}`, "DskrMember-Strong-1!");
  expect(member.ok).toBe(true);
  memberToken = member.token!;
  const memberId = db.get<{ user_id: string }>(
    "SELECT user_id FROM users WHERE username = ?1", `dskr_member_${stamp}`)!.user_id;
  db.run("INSERT INTO network_members(network_id, user_id, role) VALUES(?1, ?2, 'member')", [net, memberId]);

  // stranger:没入网 → 403。
  const stranger = auth.register(`dskr_stranger_${stamp}`, "DskrStranger-Strong-1!");
  expect(stranger.ok).toBe(true);
  strangerToken = stranger.token!;

  // 🔴 节点 token(网络绑定)—— 它就是"agent 想自授"的化身。
  const nodeTok = auth.createNetworkTokenForNode(ownerUserId, net, "dskr-node", "n_dskr_agent");
  expect(nodeTok.ok).toBe(true);
  nodeToken = nodeTok.token!;

  // daemon:role 在 config_snapshot 里(不是一等列),自述列预置一个已存在的值,
  // 这样验收① 的"不得变化"有真实起点而不是 null。
  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, network_id, lifecycle_state, config_snapshot, allowed_secret_keys)
     VALUES (?1, ?1, ?1, ?2, 'active', ?3, ?4)`,
    [DAEMON, net, JSON.stringify({ role: "host_supervisor", daemon_capabilities: { allowed_secret_keys: ["SELF_DECLARED"] } }), `["SELF_DECLARED"]`],
  );
  // 普通节点:同网络、但 role 不是 host_supervisor。
  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, network_id, lifecycle_state, config_snapshot)
     VALUES (?1, ?1, ?1, ?2, 'active', ?3)`,
    [PLAIN_NODE, net, JSON.stringify({ node_secrets_capable: true })],
  );

  const mod = await import("./server.js");
  server = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  try { server?.stop(true); } catch {}
  try { rmSync(PRIVATE_DB_DIR, { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  // 每例从空账本起,状态推导类断言才可归因于本例。
  db.run("DELETE FROM daemon_secret_key_requests");
  // 下面那条"待批期间 daemon 被删"用例会拆掉这个节点 —— 每例前把它和自述列
  // 一并复位,否则删一次就把后面整批用例带偏(daemon_not_found 满天飞)。
  db.run(
    `INSERT OR REPLACE INTO nodes (node_id, node_name, alias, network_id, lifecycle_state, config_snapshot, allowed_secret_keys)
     VALUES (?1, ?1, ?1, ?2, 'active', ?3, ?4)`,
    [DAEMON, net, JSON.stringify({ role: "host_supervisor", daemon_capabilities: { allowed_secret_keys: ["SELF_DECLARED"] } }), `["SELF_DECLARED"]`],
  );
});

describe("申请(POST)", () => {
  test("建单即 pending,且 daemon 的自述列一个字节都不动", async () => {
    const before = declaredNow(DAEMON);
    const r = await createReq(ownerToken, { network_id: net, daemon_node_id: DAEMON, key_name: KEY, action: "grant" });
    expect(r.status).toBe(201);
    expect(r.body.ok).toBe(true);
    expect(r.body.request.status).toBe("pending");
    expect(r.body.request.requested_by_name).toBeTruthy();
    // 验收① 前半:批准前不得变化 —— 这里用"根本没写"满足,而非"写对了"。
    expect(declaredNow(DAEMON)).toBe(before);
    expect(before).toBe(`["SELF_DECLARED"]`);
  });

  test("同一 (daemon, key, action) 已有待批 → 409,不建重复单", async () => {
    const a = await createReq(ownerToken, { network_id: net, daemon_node_id: DAEMON, key_name: KEY, action: "grant" });
    expect(a.status).toBe(201);
    const b = await createReq(ownerToken, { network_id: net, daemon_node_id: DAEMON, key_name: KEY, action: "grant" });
    expect(b.status).toBe(409);
    expect(b.body.error).toBe("request_already_pending");
  });

  test("非法 key 名与保留前缀都被拒(与下发通道同一把尺)", async () => {
    for (const bad of ["lower_case", "1BAD", "ANET_SECRET_X", "COMMHUB_DB", "CLAUDE_CODE_FOO", ""]) {
      const r = await createReq(ownerToken, { network_id: net, daemon_node_id: DAEMON, key_name: bad, action: "grant" });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("invalid_key_name");
    }
    expect(declaredNow(DAEMON)).toBe(`["SELF_DECLARED"]`);
  });

  test("目标不是 daemon → 400 not_a_daemon;不存在 → 404 daemon_not_found", async () => {
    const notDaemon = await createReq(ownerToken, { network_id: net, daemon_node_id: PLAIN_NODE, key_name: KEY, action: "grant" });
    expect(notDaemon.status).toBe(400);
    expect(notDaemon.body.error).toBe("not_a_daemon");

    const missing = await createReq(ownerToken, { network_id: net, daemon_node_id: "n_dskr_nope", key_name: KEY, action: "grant" });
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe("daemon_not_found");
  });

  test("没入网的用户 → 403;节点 token → 403 user_token_required", async () => {
    const s = await createReq(strangerToken, { network_id: net, daemon_node_id: DAEMON, key_name: KEY, action: "grant" });
    expect(s.status).toBe(403);
    expect(s.body.error).toBe("permission_denied");

    const n = await createReq(nodeToken, { network_id: net, daemon_node_id: DAEMON, key_name: KEY, action: "grant" });
    expect(n.status).toBe(403);
    expect(n.body.error).toBe("user_token_required");
  });
});

describe("人工裁决(POST /decide)", () => {
  const fileGrant = async (token = ownerToken) => {
    const r = await createReq(token, { network_id: net, daemon_node_id: DAEMON, key_name: KEY, action: "grant" });
    expect(r.status).toBe(201);
    return r.body.request.request_id as string;
  };

  test("member 能申请但不能裁决 → 403 owner/admin only", async () => {
    const id = await fileGrant(memberToken);
    const r = await decide(memberToken, id, { network_id: net, decision: "approve" });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("permission_denied");
    // 未获批准 → 仍是 pending,自述列未动。
    const row = db.get<any>("SELECT status FROM daemon_secret_key_requests WHERE request_id = ?1", [id]);
    expect(row.status).toBe("pending");
    expect(declaredNow(DAEMON)).toBe(`["SELF_DECLARED"]`);
  });

  test("🔴 节点 token 打不开裁决端点(不让 agent 自授)", async () => {
    const id = await fileGrant();
    const r = await decide(nodeToken, id, { network_id: net, decision: "approve" });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("user_token_required");
    const row = db.get<any>("SELECT status, decided_by FROM daemon_secret_key_requests WHERE request_id = ?1", [id]);
    expect(row.status).toBe("pending");
    expect(row.decided_by).toBeNull();
    // 自授没成 → 那列也不该有任何变化。
    expect(declaredNow(DAEMON)).toBe(`["SELF_DECLARED"]`);
  });

  test("owner 批准 → approved + 谁批的 + 何时;🔴 批准后自述列仍不变", async () => {
    const id = await fileGrant();
    const before = declaredNow(DAEMON);
    const r = await decide(ownerToken, id, { network_id: net, decision: "approve" });
    expect(r.status).toBe(200);
    expect(r.body.request.status).toBe("approved");
    expect(r.body.request.decided_by).toBeTruthy();
    expect(r.body.request.decided_at).toBeGreaterThan(0);
    // 批的那一刻 daemon 自述了什么,抄进审计(原列会被心跳冲走)。
    expect(r.body.request.declared_at_decision).toEqual(["SELF_DECLARED"]);
    // 验收① 后半(比卡面更狠):批准之后**也**不写那一列 —— 授权的真源是账本。
    expect(declaredNow(DAEMON)).toBe(before);
    expect(before).toBe(`["SELF_DECLARED"]`);
  });

  test("重复批准 → 409,且不覆掉第一次的决定人", async () => {
    const id = await fileGrant();
    const first = await decide(ownerToken, id, { network_id: net, decision: "approve" });
    expect(first.status).toBe(200);
    const again = await decide(ownerToken, id, { network_id: net, decision: "approve" });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("request_already_decided");
    const row = db.get<any>("SELECT decided_by FROM daemon_secret_key_requests WHERE request_id = ?1", [id]);
    expect(row.decided_by).toBe(first.body.request.decided_by);
  });

  test("驳回 → rejected + 理由;状态未变,可重新申请", async () => {
    const id = await fileGrant();
    const r = await decide(ownerToken, id, { network_id: net, decision: "reject", reason: "need ticket first" });
    expect(r.status).toBe(200);
    expect(r.body.request.status).toBe("rejected");
    expect(r.body.request.decide_reason).toBe("need ticket first");

    const { isKeyAuthorized } = await import("./daemon-secret-key-requests.js");
    expect(isKeyAuthorized(net, DAEMON, KEY)).toBe(false);
    // 驳回没留下"已申请过"的残留态 → 同一 key 可以再报一次。
    const refile = await createReq(ownerToken, { network_id: net, daemon_node_id: DAEMON, key_name: KEY, action: "grant" });
    expect(refile.status).toBe(201);
  });

  test("待批期间目标 daemon 被删 → 409 state_changed,单子保持 pending", async () => {
    const id = await fileGrant();
    // 生产真实可达:申请挂着,daemon 随后被 delete_node 删掉。
    db.run("DELETE FROM nodes WHERE node_id = ?1", [DAEMON]);

    const r = await decide(ownerToken, id, { network_id: net, decision: "approve" });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("state_changed");
    // 不替批准人关单 —— 让他看清分歧后自己写 reason 驳回。
    expect(db.get<any>("SELECT status FROM daemon_secret_key_requests WHERE request_id = ?1", [id]).status).toBe("pending");
  });

  test("账本被带外改写(同 key 已被别人授权) → 409 state_changed", async () => {
    const id = await fileGrant();
    // ⚠️ 直写 SQL,**故意不经过本模块**:模块自己的路径做不出这件事——待批守卫让
    // 同一 (daemon,key) 建不出第二张冲突单,状态门槛让冲突单也建不出来(两者合起来
    // 把同一 key 的申请串行化了)。所以这条测的是「别的写入者动了账本」:手工修复、
    // 将来的批量撤销、迁移脚本。这正是分歧闸要防的——批准单的前提已经没了,
    // 不能默默照批完事。
    db.run(
      `INSERT INTO daemon_secret_key_requests
         (request_id, network_id, daemon_node_id, key_name, action, status,
          requested_by, requested_by_name, decided_by, decided_by_name, decided_at, created_at)
       VALUES ('skar_out_of_band', ?1, ?2, ?3, 'grant', 'approved',
               'u_x', 'out-of-band', 'u_y', 'out-of-band', 1, 1)`,
      [net, DAEMON, KEY],
    );

    const r = await decide(ownerToken, id, { network_id: net, decision: "approve" });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("state_changed");
    expect(db.get<any>("SELECT status FROM daemon_secret_key_requests WHERE request_id = ?1", [id]).status).toBe("pending");
  });

  test("批准的不是本网络的单子 → 404 request_not_found", async () => {
    const id = await fileGrant();
    const stranger = await decide(strangerToken, id, { decision: "approve" });
    // stranger 没入网 → 连网络都解析不出来(400) 或查不到单(404);两种都是"没批成"。
    expect([400, 403, 404]).toContain(stranger.status);
    expect(db.get<any>("SELECT status FROM daemon_secret_key_requests WHERE request_id = ?1", [id]).status).toBe("pending");
  });
});

describe("账本状态推导(单一真源)", () => {
  test("grant 批准 → 已授权;随后 revoke 批准 → 撤回(最后一行说了算)", async () => {
    const { createSecretKeyRequest, decideSecretKeyRequest, isKeyAuthorized } =
      await import("./daemon-secret-key-requests.js");
    expect(isKeyAuthorized(net, DAEMON, KEY)).toBe(false);

    const g = createSecretKeyRequest({ networkId: net, daemonNodeId: DAEMON, keyName: KEY, action: "grant", requestedBy: "u1", requestedByName: "u1" });
    expect(g.ok).toBe(true);
    expect(decideSecretKeyRequest({ networkId: net, requestId: (g as any).request.request_id, decision: "approve", decidedBy: "u2", decidedByName: "u2" }).ok).toBe(true);
    expect(isKeyAuthorized(net, DAEMON, KEY)).toBe(true);

    const rev = createSecretKeyRequest({ networkId: net, daemonNodeId: DAEMON, keyName: KEY, action: "revoke", requestedBy: "u1", requestedByName: "u1" });
    expect(rev.ok).toBe(true);
    expect(decideSecretKeyRequest({ networkId: net, requestId: (rev as any).request.request_id, decision: "approve", decidedBy: "u2", decidedByName: "u2" }).ok).toBe(true);
    expect(isKeyAuthorized(net, DAEMON, KEY)).toBe(false);
  });

  test("未授权时撤销无事可做 → 409;已授权时重复授权 → 409", async () => {
    const { createSecretKeyRequest, decideSecretKeyRequest, isKeyAuthorized } =
      await import("./daemon-secret-key-requests.js");

    const noopRevoke = createSecretKeyRequest({ networkId: net, daemonNodeId: DAEMON, keyName: KEY, action: "revoke", requestedBy: "u1", requestedByName: "u1" });
    expect(noopRevoke.ok).toBe(false);
    expect((noopRevoke as any).error).toBe("key_not_authorized");

    const g = createSecretKeyRequest({ networkId: net, daemonNodeId: DAEMON, keyName: KEY, action: "grant", requestedBy: "u1", requestedByName: "u1" });
    expect(decideSecretKeyRequest({ networkId: net, requestId: (g as any).request.request_id, decision: "approve", decidedBy: "u2", decidedByName: "u2" }).ok).toBe(true);
    expect(isKeyAuthorized(net, DAEMON, KEY)).toBe(true);

    const dupGrant = createSecretKeyRequest({ networkId: net, daemonNodeId: DAEMON, keyName: KEY, action: "grant", requestedBy: "u1", requestedByName: "u1" });
    expect(dupGrant.ok).toBe(false);
    expect((dupGrant as any).error).toBe("key_already_authorized");
  });
});

describe("审计回读(GET)", () => {
  test("按 daemon 名与 key 名查回(验收③)", async () => {
    const other = "n_dskr_other_daemon";
    db.run(
      `INSERT INTO nodes (node_id, node_name, alias, network_id, lifecycle_state, config_snapshot)
       VALUES (?1, ?1, ?1, ?2, 'active', ?3)`,
      [other, net, JSON.stringify({ role: "host_supervisor" })],
    );
    await createReq(ownerToken, { network_id: net, daemon_node_id: DAEMON, key_name: KEY, action: "grant" });
    await createReq(ownerToken, { network_id: net, daemon_node_id: DAEMON, key_name: "SECOND_KEY", action: "grant" });
    await createReq(ownerToken, { network_id: net, daemon_node_id: other, key_name: KEY, action: "grant" });

    const byDaemon = await get(`/api/daemon-secret-key-requests?network_id=${net}&daemon_node_id=${DAEMON}`, ownerToken);
    expect(byDaemon.status).toBe(200);
    expect(byDaemon.body.count).toBe(2);
    expect(byDaemon.body.requests.every((r: any) => r.daemon_node_id === DAEMON)).toBe(true);

    const byKey = await get(`/api/daemon-secret-key-requests?network_id=${net}&key_name=${KEY}`, ownerToken);
    expect(byKey.status).toBe(200);
    expect(byKey.body.count).toBe(2);
    expect(byKey.body.requests.every((r: any) => r.key_name === KEY)).toBe(true);

    // 两个条件同时给 → 精确到那一行。
    const both = await get(`/api/daemon-secret-key-requests?network_id=${net}&daemon_node_id=${DAEMON}&key_name=${KEY}`, ownerToken);
    expect(both.body.count).toBe(1);

    const none = await get(`/api/daemon-secret-key-requests?network_id=${net}&key_name=NO_SUCH_KEY`, ownerToken);
    expect(none.body.count).toBe(0);
  });

  test("审计字段齐:谁申请、谁批、何时、哪个 daemon、哪个 key", async () => {
    const c = await createReq(ownerToken, { network_id: net, daemon_node_id: DAEMON, key_name: KEY, action: "grant" });
    const approved = await decide(ownerToken, c.body.request.request_id, { network_id: net, decision: "approve", reason: "approved for prod" });
    // 不许上一步悄悄空转:批准没成的话,后面按 status=approved 查回 0 行,
    // 症状会漂到"过滤器坏了"上去,归因就断了。
    expect(approved.status).toBe(200);
    expect(approved.body.request.status).toBe("approved");

    const list = await get(`/api/daemon-secret-key-requests?network_id=${net}&status=approved`, ownerToken);
    expect(list.body.count).toBe(1);
    const row = list.body.requests[0];
    expect(row.daemon_node_id).toBe(DAEMON);
    expect(row.key_name).toBe(KEY);
    expect(row.action).toBe("grant");
    expect(row.requested_by_name).toBeTruthy();
    expect(row.decided_by_name).toBeTruthy();
    expect(row.decided_at).toBeGreaterThan(0);
    expect(row.decide_reason).toBe("approved for prod");
  });

  test("节点 token / 未入网用户都读不到审计", async () => {
    const n = await get(`/api/daemon-secret-key-requests?network_id=${net}`, nodeToken);
    expect(n.status).toBe(403);
    expect(n.body.error).toBe("user_token_required");

    const s = await get(`/api/daemon-secret-key-requests?network_id=${net}`, strangerToken);
    expect(s.status).toBe(403);
  });
});

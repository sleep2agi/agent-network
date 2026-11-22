// #4821 HTTP 级：请求 → daemon ack → 轮询拿到投影结果；越界 403。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "anet-ssr-http-"));
process.env.COMMHUB_DB ||= join(DIR, "hub.db");
let hub: ReturnType<typeof Bun.serve>;
let base = "", ownerToken = "", net = "", nodeId = "ssr-node-1";
const call = async (method: string, path: string, token: string, body?: unknown) => {
  const r = await fetch(`${base}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j: any = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};

beforeAll(async () => {
  process.env.COMMHUB_AUTH_TOKEN ||= "legacy-master-token-for-test";
  const { db } = await import("./db.js");
  const { register } = await import("./auth.js");
  const stamp = Date.now();
  const owner = register(`ssr_owner_${stamp}`, "Ssr-Owner-1!");
  net = owner.network_id!;
  ownerToken = owner.token!;
  // 合并后这条路由先过 #4825 的 runtime 检查：必须是 opencode 运行时才继续
  db.run(`INSERT OR REPLACE INTO nodes (node_id, node_name, network_id, alias, runtime, config_snapshot, created_at, updated_at)
          VALUES (?1, 'ssr-node', ?2, 'ssr-node', 'opencode-cli', ?3, ?4, ?4)`,
    [nodeId, net, JSON.stringify({ flags: { opencodeGeneration: "v2" } }), Date.now()]);
  const mod = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${hub.port}`;
}, 60_000);

afterAll(() => { try { hub?.stop(true); } catch {}; try { rmSync(DIR, { recursive: true, force: true }); } catch {} });

describe("#4821 /api/nodes/:id/opencode-sessions", () => {
  test("第一次是 pending；daemon ack 后轮询拿到投影结果；随后再有 60 秒缓存", async () => {
    const first = await call("GET", `/api/nodes/${nodeId}/opencode-sessions?network_id=${net}`, ownerToken);
    expect(first.status).toBe(200);
    expect(first.body.pending).toBe(true);
    const requestId = first.body.request_id as string;
    expect(requestId.startsWith("ssr_")).toBe(true);

    // 模拟 daemon：拉 + 回填（投影后的形状）
    const m = await import("./opencode-session-requests.js");
    const { db } = await import("./db.js");
    expect(m.takePendingForDaemon(db, nodeId).map(r => r.request_id)).toContain(requestId);
    const payload = JSON.stringify({ data: [{ id: "ses_a", title: "hello", project_id: "p1", model: null, updated_at: "2026-01-01T00:00:00Z", directory: "/w" }], cursor: { previous: null, next: "next1" } });
    m.ackSessionRequest(db, { requestId, ok: true, resultJson: payload });

    const poll = await call("GET", `/api/session-requests/${requestId}`, ownerToken);
    expect(poll.status).toBe(200);
    expect(poll.body.status).toBe("succeeded");
    expect(poll.body.data[0].id).toBe("ses_a");
    expect(poll.body.next_cursor).toBe("next1");

    // 同一个 cursor 再来一次 ⇒ 走缓存，不再排队
    const cached = await call("GET", `/api/nodes/${nodeId}/opencode-sessions?network_id=${net}`, ownerToken);
    expect(cached.body.cached).toBe(true);
    expect(cached.body.data[0].id).toBe("ses_a");
  });

  test("🔴 部门范围越界 ⇒ 403（不是 404），owner 不受限", async () => {
    const { db } = await import("./db.js");
    const { register, addNetworkMember } = await import("./auth.js");
    const stamp = Date.now();
    const member = register(`ssr_member_${stamp}`, "Ssr-Member-1!");
    const memberId = db.get<{ user_id: string }>("SELECT user_id FROM users WHERE username = ?1", [`ssr_member_${stamp}`])!.user_id;
    addNetworkMember(net, memberId, "member");
    db.run("UPDATE network_members SET agent_access = 'all' WHERE network_id = ?1 AND user_id = ?2", [net, memberId]);
    db.run("INSERT INTO network_departments (network_id, department_id, name, sort) VALUES (?1,'d-a','A',0)", [net]);
    db.run("UPDATE nodes SET department_id = 'd-a' WHERE node_id = ?1", [nodeId]);
    // 给该成员授「只管 d-b 部门」
    db.run("INSERT INTO network_departments (network_id, department_id, name, sort) VALUES (?1,'d-b','B',1)", [net]);
    const ug = await import("./user-grants.js");
    ug.setUserGrant({ networkId: net, userId: memberId, capability: "manage_nodes", scopeKind: "department", scopeId: "d-b", level: "read", grantedBy: null });
    // 2026-11-22 —— 两套实现合并后，权限码统一走 #4825 的判定函数
    const denied = await call("GET", `/api/nodes/${nodeId}/opencode-sessions?network_id=${net}`, member.token!);
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe("insufficient_role_for_list_sessions");
    const owner = await call("GET", `/api/nodes/${nodeId}/opencode-sessions?network_id=${net}`, ownerToken);
    expect(owner.status).toBe(200);
  });
});

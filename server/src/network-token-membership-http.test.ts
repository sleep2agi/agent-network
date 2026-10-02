// #488 —— 网络令牌只在它的用户还是这个网络的成员时有效(RFC-041 §1)。
//
// 以前:被移出网络的成员留下的节点令牌照样解析 —— MCP 每个工具都拒(not a member),REST 读却拿得到整个网络
// (GET /api/status 返回全部名册)。受限成员的令牌本来就在 resolveToken 被拒,但 401 只写 unauthorized。
//
// 钉住:
//   (i)   非成员的网络令牌:每个 REST GET 与 /mcp 都 401,reason = not_network_member(下面 GETS 是逐条探过的读路径)。
//   (ii)  removeNetworkMember 在同一个事务里吊销这个人在该网络的令牌(revoked_at),别的网络的令牌不动。
//   (iii) 受限成员的节点令牌:401 带 reason = node_owner_restricted + hint;不认识的令牌只有 unauthorized。
//   成员的节点令牌、不受限的情况与以前完全一样。
//
// 跑法:cd server && COMMHUB_DB=/tmp/x.db bun test src/network-token-membership-http.test.ts
//       PG:COMMHUB_TEST_PG_URL=… COMMHUB_PG_EXPERIMENTAL=1(tests/test2123-hub-postgres-ladder 里注册)
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { addNetworkMember, createNetworkTokenForNode, createNetwork, register, removeNetworkMember } from "./auth.js";
import { replaceAgentGrants } from "./agent-access.js";
import { db } from "./db.js";

const activeDbPath = process.env.COMMHUB_DB ?? (process.env.COMMHUB_TEST_PG_URL ? "postgres" : undefined);
if (!activeDbPath) throw new Error("network-token-membership requires COMMHUB_DB (or COMMHUB_TEST_PG_URL) before module import");

const stamp = Date.now();
const PW = "TokenMember123!";
const OTHER = `other-${stamp}`; // 网络里别人的 Agent —— 出现在响应里 = 读到了不该读的
let server: any, base = "", net = "", net2 = "", taskId = "";
const tok: Record<string, string> = {};
const ids: Record<string, string> = {};

const get = (t: string, path: string) =>
  fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${t}` } })
    .then(async (r) => ({ status: r.status, text: await r.text() }));
const mcp = (t: string, name: string, args: Record<string, unknown>) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  }).then(async (r) => ({ status: r.status, text: await r.text() }));

// 拿网络令牌能调的 REST GET 读路径(server.ts 里 restScope 之后的每个 GET,加上之前自己解析令牌的 /api/auth/me、/api/networks)。
const GETS = () => [
  "/api/auth/me", "/api/networks",
  `/api/status?network_id=${net}`, `/api/status?light=1`, "/api/servers", "/api/server/unknown/health", "/api/server/unknown/agents",
  "/api/messages", "/api/messages?scope=user", "/api/stats", "/api/stats/sse", "/api/stats/routes", "/api/server-logs", "/api/audit-log",
  "/api/task_events", "/api/nodes", `/api/nodes/${ids.other}/config`, "/api/node-create-requests", "/api/host-supervisors",
  `/api/task/${taskId}`, "/api/tasks", "/api/completions", "/api/dm/threads", "/api/requirements",
];

beforeAll(async () => {
  const boss = register(`tm_boss_${stamp}`, PW); net = boss.network_id!; ids.boss = boss.user!.user_id; tok.bossUser = boss.token!;
  for (const k of ["exm", "rem", "mia", "stay"]) {
    const u = register(`tm_${k}_${stamp}`, PW); ids[k] = u.user!.user_id;
    expect(addNetworkMember(net, ids[k], "member", ids.boss, { agentAccess: "all" }).ok).toBe(true);
    const t = createNetworkTokenForNode(ids[k], net, `${k}-${stamp}`, `n_tm_${k}_${stamp}`);
    expect(t.ok).toBe(true);
    tok[k] = t.token!;
  }
  // rem 在另一个网络里也有令牌 —— 被移出 net 时那枚不能被一起吊销。
  const n2 = createNetwork(ids.rem, `tm-net2-${stamp}`); expect(n2.ok).toBe(true); net2 = n2.network_id!;
  const t2 = createNetworkTokenForNode(ids.rem, net2, `rem2-${stamp}`, `n_tm_rem2_${stamp}`); tok.rem2 = t2.token!;

  ids.other = `n_tm_other_${stamp}`;
  db.run("INSERT INTO nodes (node_id, node_name, alias, network_id, owner_user_id) VALUES (?1, ?2, ?2, ?3, ?4)", [ids.other, OTHER, net, ids.boss]);
  db.run("INSERT INTO sessions (resume_id, alias, status, node_id, network_id, server) VALUES (?1, ?2, 'idle', ?3, ?4, 'unknown')", [`r_${ids.other}`, OTHER, ids.other, net]);
  taskId = `task_tm_${stamp}`;
  db.run("INSERT INTO tasks (task_id, from_name, to_name, to_node_id, content, status, network_id) VALUES (?1, 'boss', ?2, ?3, 'secret plan', 'pending', ?4)", [taskId, OTHER, ids.other, net]);

  // exm:老数据 —— 成员行没了,令牌还在(移出前的版本不吊销)。rem:走真实的 removeNetworkMember。
  db.run("DELETE FROM network_members WHERE network_id = ?1 AND user_id = ?2", [net, ids.exm]);
  expect(removeNetworkMember(net, ids.rem).ok).toBe(true);
  // mia:铸完令牌后被收窄成只看授权的 Agent。
  expect(replaceAgentGrants({ networkId: net, userId: ids.mia, grants: [], agentAccess: "granted", actorUserId: ids.boss }).ok).toBe(true);

  const mod: any = await import("./server.js");
  server = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${server.port}`;
}, 60_000);
afterAll(() => { server?.stop?.(true); });

describe("#488 (i) a network token whose user left the network", () => {
  test("every REST GET read is 401 not_network_member and leaks nothing", async () => {
    const leaks: string[] = [];
    for (const path of GETS()) {
      const r = await get(tok.exm, path);
      if (r.status !== 401 || r.text.includes(OTHER) || r.text.includes("secret plan")) leaks.push(`${path} → ${r.status}`);
      else expect(JSON.parse(r.text).reason).toBe("not_network_member");
    }
    expect(leaks).toEqual([]);
  });

  test("/mcp is 401 too, with the reason", async () => {
    const r = await mcp(tok.exm, "get_all_status", {});
    expect(r.status).toBe(401);
    expect(JSON.parse(r.text).reason).toBe("not_network_member");
    expect(JSON.parse(r.text).hint).toContain("no longer a member");
  });
});

describe("#488 (ii) removeNetworkMember revokes the member's tokens for that network", () => {
  test("revoked_at is set for that network only, and the token is rejected", async () => {
    const rows = db.all<{ network_id: string; revoked_at: string | null }>("SELECT network_id, revoked_at FROM api_tokens WHERE user_id = ?1 AND network_id IS NOT NULL", ids.rem);
    expect(rows.filter((r) => r.network_id === net).length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.network_id === net).every((r) => !!r.revoked_at)).toBe(true);
    expect(rows.filter((r) => r.network_id === net2).every((r) => !r.revoked_at)).toBe(true);
    expect((await get(tok.rem, `/api/status?network_id=${net}`)).status).toBe(401);
    expect((await get(tok.rem2, "/api/status")).status).toBe(200);
  });
});

describe("#488 (iii) a restricted owner's node token says why it is refused", () => {
  test("401 with reason node_owner_restricted + hint on REST and /mcp", async () => {
    for (const r of [await get(tok.mia, "/api/status"), await mcp(tok.mia, "report_status", { resume_id: "r", alias: `mia-${stamp}`, status: "idle" })]) {
      expect(r.status).toBe(401);
      const body = JSON.parse(r.text);
      expect(body.reason).toBe("node_owner_restricted");
      expect(body.hint).toContain("Agent access");
    }
    const me = await get(tok.mia, "/api/auth/me");
    expect(me.status).toBe(401);
    expect(JSON.parse(me.text).reason).toBe("node_owner_restricted");
  });

  test("an unknown token gets no reason (nothing to explain, nothing leaked)", async () => {
    const r = await get("ntok_doesnotexist", "/api/status");
    expect(r.status).toBe(401);
    expect(JSON.parse(r.text)).toEqual({ error: "unauthorized" });
  });
});

describe("#488 unchanged for members", () => {
  test("an all-access member's node token reads and heartbeats as before", async () => {
    const st = await get(tok.stay, `/api/status?network_id=${net}`);
    expect(st.status).toBe(200);
    expect(st.text).toContain(OTHER);
    const hb = await mcp(tok.stay, "report_status", { resume_id: `r_stay_${stamp}`, alias: `stay-${stamp}`, status: "idle" });
    expect(hb.status).toBe(200);
    expect(hb.text).toContain('\\"ok\\":true');
    expect((await get(tok.bossUser, `/api/task/${taskId}`)).status).toBe(200);
  });
});

// #3309 读数覆盖第十批 —— 两条此前在测试里一次都没出现过的 error：
//
//   restart_node : adopted_restart_requires_daemon
//   start_node   : forbidden_cross_tenant
//
// 第一条是「adopted 节点不能被 restart」：binding 证明的是 stop/start 授权，
// 不是 exit-75 supervisor 能力 —— 代码里这段注释写得很清楚，但此前没有任何测试走过它。
// 这条特别值得钉住，因为它是**「有权限做 A 不等于有权限做 B」**的一个具体实例：
// 同一个 binding 让 stop/start 可用，却让 restart 必须拒绝。
//
// ⚠ 没测 daemon_cross_tenant：那需要「daemon 与 child 分属不同网络」的夹具，
// 而 resolveTargetNode 本身会在采到那种行之前就按网络拦掉 —— 要造出来只能伪造
// 一个正常路径不会产生的状态。留在待补清单里，不在这里假装覆盖。
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "./db.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";

const NET = "net_10th_err";
const NET_OTHER = "net_10th_other";   // 调用者**不在**里面的网络（用来触发 scope.denied）
const NET_DAEMON = "net_10th_daemon"; // daemon 所在的另一个网络（用来触发 daemon_cross_tenant）
const OWNER = "u_10th_owner";
const DAEMON = "node_10th_daemon";
const ADOPTED = "node_10th_adopted";
const DAEMON_OTHER_NET = "node_10th_daemon_other";

type ToolHandler = (args: any) => Promise<{ content: Array<{ type: "text"; text: string }> }>;

function handlers(): Record<string, ToolHandler> {
  const server = new McpServer({ name: "t", version: "0" }) as any;
  const out: Record<string, ToolHandler> = {};
  const orig = server.tool.bind(server);
  server.tool = (n: string, d: string, s: any, h: ToolHandler) => { out[n] = h; return orig(n, d, s, h); };
  registerTools(server, undefined, NET, OWNER, null, false, null);
  return out;
}

async function call(name: string, args: Record<string, unknown>) {
  const r = await handlers()[name](args);
  return JSON.parse(r.content[0].text) as { ok?: boolean; error?: string; [k: string]: unknown };
}

function cleanup() {
  for (const t of ["node_daemon_bindings", "node_create_requests", "nodes", "network_members"]) {
    try { db.run(`DELETE FROM ${t} WHERE network_id = ?1`, [NET]); } catch {}
  }
  for (const n of [NET, NET_OTHER, NET_DAEMON]) {
    try { db.run("DELETE FROM networks WHERE network_id = ?1", [n]); } catch {}
  }
  try { db.run("DELETE FROM users WHERE user_id = ?1", [OWNER]); } catch {}
}

function node(node_id: string, alias: string, snapshot: Record<string, unknown> | null) {
  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, network_id, runtime, model, channels, config_snapshot,
                        hostname, created_at, updated_at, lifecycle_state)
     VALUES (?1, ?2, ?2, ?3, 'opencode-cli', 'm', '[]', ?4, 'host-x', datetime('now'), datetime('now'), 'active')`,
    [node_id, alias, NET, snapshot ? JSON.stringify(snapshot) : null],
  );
}

function seed() {
  cleanup();
  db.run("INSERT INTO users (user_id, username, password_hash, role, created_at) VALUES (?1, ?1, 'x', 'user', datetime('now'))", [OWNER]);
  db.run("INSERT INTO networks (network_id, network_name, owner_id, created_at) VALUES (?1, ?1, ?2, datetime('now'))", [NET, OWNER]);
  db.run("INSERT INTO network_members (user_id, network_id, role, joined_at) VALUES (?1, ?2, 'owner', datetime('now'))", [OWNER, NET]);
  // 两个「不属于我」的网络：NET_OTHER 我完全不在里面；NET_DAEMON 里放一台别的网络的 daemon
  for (const n of [NET_OTHER, NET_DAEMON]) {
    db.run("INSERT INTO networks (network_id, network_name, owner_id, created_at) VALUES (?1, ?1, ?2, datetime('now'))", [n, OWNER]);
  }
  node(DAEMON, "10th-daemon", { role: "host_supervisor" });
  node(ADOPTED, "10th-adopted", null);
  // adopted 的判据：有 **active** binding，且不是 created（没有 cr_ 记录）
  db.run(
    `INSERT INTO node_daemon_bindings (request_id, network_id, node_id, daemon_node_id, workdir,
                                       requested_by, status, created_at, updated_at)
     VALUES ('ndb_10th', ?1, ?2, ?3, '/tmp', ?4, 'active', ?5, ?5)`,
    [NET, ADOPTED, DAEMON, OWNER, Date.now()],
  );
}

beforeEach(seed);
afterAll(cleanup);

describe("#3309 restart_node / start_node 的两条拒绝", () => {
  test("adopted 节点（binding 证明的是 stop/start 授权）⇒ restart 必须拒", async () => {
    const r = await call("restart_node", { node_id: ADOPTED });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("adopted_restart_requires_daemon");
    // 提示必须给出**替代动作**（Stop → Start），否则读的人只知道被拒。
    expect(String(r.message)).toContain("Stop");
  });

  test("反向：supervisor 节点（created/role=host_supervisor）不会被这条挡", async () => {
    const r = await call("restart_node", { node_id: DAEMON });
    // 会不会成功取决于后续的生命周期校验，但**不该**是 adopted 这条。
    expect(r.error).not.toBe("adopted_restart_requires_daemon");
  });

  test("start_node 传一个我不属于的 network_id ⇒ forbidden_cross_tenant（scope.denied）", async () => {
    // 先让 child→daemon 可解析，否则会先撞 daemon_not_resolvable（我上一轮就撞过）。
    db.run(
      `INSERT INTO node_create_requests (request_id, daemon_node_id, child_name, network_id, runtime, model,
                                         flags_json, env_keys, status, created_at, created_by_token)
       VALUES ('cr_lc_child_x', ?1, 'lc-child-x', ?2, 'opencode-cli', NULL, '{}', '[]', 'succeeded', ?3, 'tok_x')`,
      [DAEMON, NET, Date.now()],
    );
    const r = await call("start_node", { node_id: "node_lc_child_x", network_id: NET_OTHER });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("forbidden_cross_tenant");
  });

  test("stop_node：daemon 与 child 分属不同网络 ⇒ daemon_cross_tenant（SEC-1 加固）", async () => {
    // 这个状态正常流程造不出来（代码注释也这么写：shouldn't be possible in normal flow），
    // 所以这条测的是**加固分支本身**：库被写坏时它必须拒绝，而不是跨租户操作。
    // 夹具：child 在 NET，daemon 在 NET_DAEMON，且 create 记录把两者绑在一起。
    node(DAEMON_OTHER_NET, "10th-daemon-other", null);
    db.run("UPDATE nodes SET network_id = ?1 WHERE node_id = ?2", [NET_DAEMON, DAEMON_OTHER_NET]);
    node("node_lc_child_2", "10th-child-2", null);
    db.run(
      `INSERT INTO node_create_requests (request_id, daemon_node_id, child_name, network_id, runtime, model,
                                         flags_json, env_keys, status, created_at, created_by_token)
       VALUES ('cr_lc_child_2', ?1, 'lc-child-2', ?2, 'opencode-cli', NULL, '{}', '[]', 'succeeded', ?3, 'tok_x')`,
      [DAEMON_OTHER_NET, NET, Date.now()],
    );
    const r = await call("stop_node", { node_id: "node_lc_child_2" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("daemon_cross_tenant");
  });

  test("start_node 对不存在的 node ⇒ **第三次值** daemon_not_resolvable（不是我猜的两个）", async () => {
    // 我原本以为这里是 forbidden_cross_tenant 或 node_not_found —— 实测都不是。
    // 这是本组测试里唯一一次「期望值被真实调用纠正」：猜错的那个值（daemon_not_resolvable）
    // 是一个此前没人写过的形状，而它恰好说明 start_node 的**第一道**门是「能不能解析出 daemon」，
    // 而不是「这个 node 存不存在」。
    const r = await call("start_node", { node_id: "node_not_in_my_networks" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("daemon_not_resolvable");
    expect(r.error).not.toBe("node_not_found");
  });

  test("两条载荷都没有 code 字段（现状，不是契约）", async () => {
    const replies = [await call("restart_node", { node_id: ADOPTED }), await call("start_node", { node_id: "node_nope" })];
    for (const r of replies) {
      expect(r.ok).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(r, "code")).toBe(false);
    }
  });
});

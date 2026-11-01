// #3309 读数覆盖第四批 —— `create_node` 的 3 个 error 字面量此前在测试里一次都没出现过：
//
//   insufficient_role_for_create_node / runtime_not_in_local_allowlist / daemon_max_children
//
// 现有 create_node 测试覆盖的是成功建节点、blocked gate、network_id 回传 ——
// 这三条**拒绝**分支都没被走过。
//
// 三条的共同点：它们都发生在「请求已经合法、但**这台 daemon 现在不能接**」这一刻。
// 只断言 ok===false 时，它们与「名字非法」「网络不对」完全同形，而处置完全不同：
//   权限不够   ⇒ 换人 / 提权
//   runtime 不支持 ⇒ 换 runtime，或在 daemon 侧放开 allowlist（要动那台机器）
//   子节点满了 ⇒ 等，或调大 max_concurrent_children
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import "./require-explicit-test-db.js";
import { db } from "./db.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";

const NET = "net_cn_err";
const OWNER = "u_cn_err_owner";
const MEMBER = "u_cn_err_member";
const DAEMON = "node_cn_err_daemon";
const DAEMON_ALIAS = "cn-err-daemon";

type ToolHandler = (args: any) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
type Reply = { ok?: boolean; error?: string; [k: string]: unknown };

function tools(callerUserId: string): Record<string, ToolHandler> {
  const server = new McpServer({ name: "t", version: "0" }) as any;
  const out: Record<string, ToolHandler> = {};
  const orig = server.tool.bind(server);
  server.tool = (n: string, d: string, s: any, h: ToolHandler) => { out[n] = h; return orig(n, d, s, h); };
  registerTools(server, undefined, NET, callerUserId, null, false, null);
  return out;
}

// 🔴 basis: impl —— 下面这些键集**取自真实调用的响应**，因此它是**变更探测器**，不是契约读数。
//   红的意思是「实现变了，去看是不是故意的」；而「实现错了」这一类它测不出来
//   （若实现多返回一个字段，断言会红，但那可能是正确的修复）。
//   要不要升级成 spec 列：需要一处**独立于实现**的书面来源；指不出来时，它就只能留在这里。
function expectKeys(obj: Record<string, unknown>, want: string[]) {
  expect(Object.keys(obj).sort(), "键集合必须完全等于期望").toEqual([...want].sort());
}

async function callCreate(userId: string, spec: Record<string, unknown> = {}) {
  const h = tools(userId).create_node;
  const r = await h({
    daemon_node_id: DAEMON,
    node_spec: { name: "cn-err-child", runtime: "opencode-cli", model: null, flags: {}, ...spec },
  });
  return JSON.parse(r.content[0].text) as Reply;
}

function cleanup() {
  for (const t of ["node_create_requests", "audit_log", "nodes", "sessions", "api_tokens", "network_members"]) {
    try { db.run(`DELETE FROM ${t} WHERE network_id = ?1`, [NET]); } catch {}
  }
  try { db.run("DELETE FROM networks WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM users WHERE user_id IN (?1, ?2)", [OWNER, MEMBER]); } catch {}
}

function seed(caps: Record<string, unknown>) {
  cleanup();
  db.run("INSERT INTO users (user_id, username, password_hash, role, created_at) VALUES (?1, ?1, 'x', 'user', datetime('now'))", [OWNER]);
  db.run("INSERT INTO users (user_id, username, password_hash, role, created_at) VALUES (?1, ?1, 'x', 'user', datetime('now'))", [MEMBER]);
  db.run("INSERT INTO networks (network_id, network_name, owner_id, created_at) VALUES (?1, ?1, ?2, datetime('now'))", [NET, OWNER]);
  db.run("INSERT INTO network_members (user_id, network_id, role, joined_at) VALUES (?1, ?2, 'owner', datetime('now'))", [OWNER, NET]);
  db.run("INSERT INTO network_members (user_id, network_id, role, joined_at) VALUES (?1, ?2, 'member', datetime('now'))", [MEMBER, NET]);
  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, network_id, runtime, model, channels, config_snapshot,
                        hostname, created_at, updated_at, lifecycle_state)
     VALUES (?1, ?2, ?2, ?3, 'opencode-cli', 'm', '[]', ?4, 'host-cn', datetime('now'), datetime('now'), 'active')`,
    [DAEMON, DAEMON_ALIAS, NET, JSON.stringify({ role: "host_supervisor", daemon_capabilities: caps })],
  );
}

beforeEach(() => seed({ runtimes_supported: ["opencode-cli"] }));
afterAll(cleanup);

describe("#3309 create_node 错误值域：三条「这台 daemon 现在不能接」的拒绝", () => {
  test("成员建节点 ⇒ insufficient_role_for_create_node（带 required_role / caller_role）", async () => {
    const r = await callCreate(MEMBER);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("insufficient_role_for_create_node");
    expect(r.required_role).toBe("admin");
    expect(r.caller_role).toBe("member");
    expectKeys(r, ["ok", "error", "required_role", "caller_role"]);
  });

  test("daemon 只支持 codex，却要求 opencode-cli ⇒ runtime_not_in_local_allowlist（回显 allowed）", async () => {
    seed({ runtimes_supported: ["codex"] });
    const r = await callCreate(OWNER, { runtime: "opencode-cli" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("runtime_not_in_local_allowlist");
    expect(r.runtime).toBe("opencode-cli");
    // 回显这台机器**允许**什么，否则读的人只知道"不行"，要回 daemon 上自己查。
    expect(r.allowed).toEqual(["codex"]);
    expectKeys(r, ["ok", "error", "runtime", "allowed"]);
  });

  test("子节点已达上限 ⇒ daemon_max_children（带 current / max）", async () => {
    seed({ runtimes_supported: ["opencode-cli"], max_concurrent_children: 1 });
    // 手工放一条 active 子请求，把额度占满
    db.run(
      `INSERT INTO node_create_requests (request_id, daemon_node_id, child_name, network_id, runtime, model,
                                          flags_json, env_keys, status, created_at, created_by_token)
       VALUES ('cr_cn_err_seed', ?1, 'cn-err-occupied', ?2, 'opencode-cli', NULL, '{}', '[]', 'pending', ?3, ?4)`,
      [DAEMON, NET, Date.now(), "tok_seed"],
    );
    const r = await callCreate(OWNER);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("daemon_max_children");
    expect(r.current).toBe(1);
    expect(r.max).toBe(1);
    expectKeys(r, ["ok", "error", "current", "max"]);
  });

  test("三条的载荷都没有 code 字段（现状，不是契约）", async () => {
    const member = await callCreate(MEMBER);
    seed({ runtimes_supported: ["codex"] });
    const runtime = await callCreate(OWNER);
    for (const r of [member, runtime]) {
      expect(r.ok).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(r, "code")).toBe(false);
    }
  });
});

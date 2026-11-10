// #3309 读数覆盖第八批 —— 两个 error 字面量此前在测试里一次都没出现过：
//
//   get_start_request : request_not_startable
//   submit_skill      : node_identity_unbound
//
// 两条都是「身份/状态对了，但这一格不允许」：
//   request_not_startable ⇒ 这份启动请求已经结束（succeeded/failed），不能再拉
//   node_identity_unbound ⇒ 令牌自称是节点，却没有绑定任何别名 ⇒ 身份不可追溯
//
// 后者尤其值得钉住：它是**唯一一条「拒绝写入」的身份校验**，
// 而 SkillHub 的内容是永久快照 —— 让一个无法追溯身份的写入进来，
// 事后没法回答「这份技能是谁提交的」。
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "./db.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";

const NET = "net_8th_err";
const USER = "u_8th_owner";
const DAEMON_NODE = "node_8th_daemon";
const DAEMON_ALIAS = "8th-daemon";
const DAEMON_TOKEN = "tok_8th_daemon";

type ToolHandler = (args: any) => Promise<{ content: Array<{ type: "text"; text: string }> }>;

/** callerAlias 传 null 才能走到 node_identity_unbound：那是「自称节点却没绑定别名」。 */
function handlers(opts: { alias?: string | null } = {}): Record<string, ToolHandler> {
  const server = new McpServer({ name: "t", version: "0" }) as any;
  const out: Record<string, ToolHandler> = {};
  const orig = server.tool.bind(server);
  server.tool = (n: string, d: string, s: any, h: ToolHandler) => { out[n] = h; return orig(n, d, s, h); };
  registerTools(server, undefined, NET, USER, opts.alias === undefined ? DAEMON_ALIAS : opts.alias, true, DAEMON_TOKEN);
  return out;
}

async function call(name: string, args: Record<string, unknown>, opts: { alias?: string | null } = {}) {
  const r = await handlers(opts)[name](args);
  return JSON.parse(r.content[0].text) as { ok?: boolean; error?: string; [k: string]: unknown };
}

function cleanup() {
  for (const t of ["skillhub_skills", "node_start_requests", "nodes", "api_tokens", "network_members"]) {
    try { db.run(`DELETE FROM ${t} WHERE network_id = ?1`, [NET]); } catch {}
  }
  try { db.run("DELETE FROM networks WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM users WHERE user_id = ?1", [USER]); } catch {}
}

function seed() {
  cleanup();
  db.run("INSERT INTO users (user_id, username, password_hash, role, created_at) VALUES (?1, ?1, 'x', 'user', datetime('now'))", [USER]);
  db.run("INSERT INTO networks (network_id, network_name, owner_id, created_at) VALUES (?1, ?1, ?2, datetime('now'))", [NET, USER]);
  db.run("INSERT INTO network_members (user_id, network_id, role, joined_at) VALUES (?1, ?2, 'owner', datetime('now'))", [USER, NET]);
  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, network_id, created_at, updated_at)
     VALUES (?1, ?2, ?2, ?3, datetime('now'), datetime('now'))`,
    [DAEMON_NODE, DAEMON_ALIAS, NET],
  );
  db.run(
    `INSERT INTO api_tokens (token_id, user_id, network_id, scope, name, token_hash, expires_at, revoked_at)
     VALUES (?1, ?2, ?3, 'network', ?4, ?5, NULL, NULL)`,
    [DAEMON_TOKEN, USER, NET, `node:${DAEMON_ALIAS}`, `hash_${DAEMON_TOKEN}`],
  );
}

function seedStart(request_id: string, status: string) {
  db.run(
    `INSERT INTO node_start_requests (request_id, network_id, daemon_node_id, child_node_id, child_alias,
                                      created_by_token, status, created_at)
     VALUES (?1, ?2, ?3, ?4, 'child-8th', ?5, ?6, ?7)`,
    [request_id, NET, DAEMON_NODE, `n_8th_child_${request_id}`, DAEMON_TOKEN, status, Date.now()],
  );
}

const skill = {
  slug: "eighth-skill", name: "Eighth", version: "1.0.0", content: "# body",
};

beforeEach(seed);
afterAll(cleanup);

describe("#3309 get_start_request / submit_skill 的错误值域", () => {
  test("拉一份已结束的启动请求 ⇒ request_not_startable（带当前 status）", async () => {
    seedStart("sr_8th_done", "succeeded");
    const r = await call("get_start_request", { request_id: "sr_8th_done" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("request_not_startable");
    expect(r.status).toBe("succeeded");
    // 与 request_not_found 的区别：它确实存在、也确实发给这台机器，只是已经结束了。
    expect(r.error).not.toBe("request_not_found");
  });

  test("反向：pending 的启动请求可以拉（证明上一条是「状态」而不是「总被拒」）", async () => {
    seedStart("sr_8th_pending", "pending");
    const r = await call("get_start_request", { request_id: "sr_8th_pending" });
    // 会不会成功取决于后续 hydration，但**不该**再是 request_not_startable。
    expect(r.error).not.toBe("request_not_startable");
  });

  test("节点令牌却没有绑定别名 ⇒ node_identity_unbound", async () => {
    const r = await call("submit_skill", skill, { alias: null });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("node_identity_unbound");
  });

  test("反向：绑定了别名的节点可以提交（证明上一条是「身份」而不是「节点不能写」）", async () => {
    const r = await call("submit_skill", skill);
    expect(r.error).not.toBe("node_identity_unbound");
  });

  test("两条载荷都没有 code 字段（现状，不是契约）", async () => {
    seedStart("sr_8th_done2", "succeeded");
    const replies = [
      await call("get_start_request", { request_id: "sr_8th_done2" }),
      await call("submit_skill", skill, { alias: null }),
    ];
    for (const r of replies) {
      expect(r.ok).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(r, "code")).toBe(false);
    }
  });
});

// #3309 读数覆盖第三批 —— `update_node_config` 的 3 个 error 字面量此前在测试里一次都没出现过：
//
//   channels_all_invalid / insufficient_role_for_security_flag / invalid_patch
//
// 现有测试覆盖的是**成功改配置**与**响应键集**，所以这三条拒绝分支从来没被走过。
//
// 三条的处置完全不同，这也是它们必须各有断言的理由：
//   channels_all_invalid ⇒ 调用方发来的渠道**全不认识**（可能是拼错，也可能是客户端版本旧）
//                          —— 绝不能静默当成「停用全部」，那会灭掉用户已有的 worker
//   insufficient_role_for_security_flag ⇒ 权限不足；换个人来做或升级角色
//   invalid_patch        ⇒ 载荷本身不合法；改载荷
//
// 特别注意三条里 **两条的 error 都是 invalid_patch 家族之外的东西** ——
// 只按 ok===false 断言时，它们与「网络不通」「节点不存在」完全同形。
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "./db.js";
import { registerTools } from "./tools.js";

const NET = "net_unc";
const ADMIN = "u_unc_admin";
const MEMBER = "u_unc_member";
const NODE = "n_unc_node";

type ToolHandler = (args: any) => Promise<any>;

function handlers(userId: string): Record<string, ToolHandler> {
  const server = new McpServer({ name: "t", version: "0" }) as any;
  const tools: Record<string, ToolHandler> = {};
  const orig = server.tool.bind(server);
  server.tool = (name: string, desc: string, schema: any, handler: ToolHandler) => {
    tools[name] = handler;
    return orig(name, desc, schema, handler);
  };
  registerTools(server, undefined, NET, userId, "unc-node", false, null);
  return tools;
}

async function patch(userId: string, p: Record<string, unknown>, baseRevision = 0) {
  const r = await handlers(userId).update_node_config({
    node_id: NODE, base_revision: baseRevision, patch: p,
  });
  return JSON.parse(r.content[0].text);
}

function cleanup() {
  db.run("DELETE FROM network_members WHERE network_id = ?1", [NET]);
  db.run("DELETE FROM nodes WHERE network_id = ?1", [NET]);
  db.run("DELETE FROM networks WHERE network_id = ?1", [NET]);
  db.run("DELETE FROM users WHERE user_id IN (?1, ?2)", [ADMIN, MEMBER]);
}

function seed() {
  cleanup();
  db.run("INSERT INTO users (user_id, username, password_hash, role, created_at) VALUES (?1, ?1, 'x', 'user', datetime('now'))", [ADMIN]);
  db.run("INSERT INTO users (user_id, username, password_hash, role, created_at) VALUES (?1, ?1, 'x', 'user', datetime('now'))", [MEMBER]);
  db.run("INSERT INTO networks (network_id, network_name, owner_id, created_at) VALUES (?1, ?1, ?2, datetime('now'))", [NET, ADMIN]);
  db.run("INSERT INTO network_members (user_id, network_id, role, joined_at) VALUES (?1, ?2, 'owner', datetime('now'))", [ADMIN, NET]);
  db.run("INSERT INTO network_members (user_id, network_id, role, joined_at) VALUES (?1, ?2, 'member', datetime('now'))", [MEMBER, NET]);
  db.run(`INSERT INTO nodes (node_id, node_name, alias, network_id, runtime, model, channels, config_snapshot,
                             hostname, created_at, updated_at, lifecycle_state)
          VALUES (?1, 'unc-node', 'unc-node', ?2, 'claude-agent-sdk', 'm', '["commhub"]', '{}', 'host-u',
                  datetime('now'), datetime('now'), 'active')`, [NODE, NET]);
}

beforeEach(seed);
afterAll(cleanup);

describe("#3309 update_node_config 错误值域：三条拒绝各有一条会红的断言", () => {
  test("渠道全不认识 ⇒ channels_all_invalid（且回显 requested，**不是** invalid_patch）", async () => {
    const r = await patch(ADMIN, { channels: ["telegarm"] });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("channels_all_invalid");
    // 回显调用方发来的原值：只说「全不合法」时，读的人还得自己猜发了什么。
    expect(r.requested).toEqual(["telegarm"]);
    // 与 invalid_patch 的区别是本条的重点：一个要改渠道名，一个要改载荷结构。
    expect(r.error).not.toBe("invalid_patch");
  });

  test("成员改安全敏感 flag ⇒ insufficient_role_for_security_flag（带 field 与 required_role）", async () => {
    const r = await patch(MEMBER, { flags: { permissionMode: "restricted" } });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("insufficient_role_for_security_flag");
    expect(r.field).toBe("flags.permissionMode");
    expect(r.required_role).toBe("admin");
  });

  test("模型名非法 ⇒ invalid_patch（带 field=model 与 reason）", async () => {
    // zod 只限 max(200)，空串能过 zod、被 validatePatch 拦下 ⇒ 正好走到这条分支。
    const r = await patch(ADMIN, { model: "" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("invalid_patch");
    expect(r.field).toBe("model");
    expect(typeof r.reason).toBe("string");
  });

  test("三条的载荷都**没有** code 字段（现状，不是契约）", async () => {
    for (const r of [
      await patch(ADMIN, { channels: ["telegarm"] }),
      await patch(MEMBER, { flags: { permissionMode: "restricted" } }),
      await patch(ADMIN, { model: "" }),
    ]) {
      expect(r.ok).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(r, "code")).toBe(false);
    }
  });
});

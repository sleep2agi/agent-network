// #3309 第四条口径 —— `departments` 的 4 个 error 字面量此前在测试里**一次都没出现过**：
//
//   network_required / department_required / agent_required / agent_not_found
//
// 它们不是「没被测到」，而是「违反了也不会有任何读数」：四条都是入口处的参数/上下文校验，
// 而现有 departments 测试全部从**合法调用**出发（有网络、有 department_id、有 agent），
// 所以这四条分支从来没被走过。
//
// 这里逐个把它们**真的触发一次**，并断言 `error` 的**确切值** —— 不是 `ok === false`
// （那只证明「被拒了」，不证明「拒的理由是这一个」；两个不同的理由在 ok===false 下同形）。
//
// 同时钉住一件事：这四条的错误形状是 `{ ok: false, error }` 而**没有** `code` 字段。
// 客户端若按 code 分支，这四条会全部落进 unknown —— 记在这里，不假装它们已经是契约。

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "./db.js";
import { registerTools } from "./tools.js";

const NET = "net_dept_err";
// 第二个网络：`getNetworkId()` 在「上下文没有网络」时会退到「这个人只有一个网络就用它」。
// 所以要让 `network_required` 真的可达，OWNER 必须**属于多个**网络 —— 否则它会被自动补上，
// 而「补上」与「本来就该拒」在结果上同形（都是 ok:true）。
const NET2 = "net_dept_err_2";
const OWNER = "u_dept_err_owner";
const AGENT = "n_dept_err_a";

function cleanup() {
  for (const [table, col] of [
    ["audit_log", "network_id"], ["nodes", "network_id"], ["network_departments", "network_id"],
    ["network_members", "network_id"], ["networks", "network_id"],
  ] as const) {
    try { db.run(`DELETE FROM ${table} WHERE ${col} IN (?1, ?2)`, [NET, NET2]); } catch {}
  }
  try { db.run("DELETE FROM users WHERE user_id = ?1", [OWNER]); } catch {}
}

function seed() {
  cleanup();
  db.run("INSERT INTO users (user_id, username, password_hash, role, created_at) VALUES (?1, ?1, 'x', 'user', datetime('now'))", [OWNER]);
  db.run("INSERT INTO networks (network_id, network_name, owner_id, created_at) VALUES (?1, ?1, ?2, datetime('now'))", [NET, OWNER]);
  db.run("INSERT INTO network_members (user_id, network_id, role, joined_at) VALUES (?1, ?2, 'owner', datetime('now'))", [OWNER, NET]);
  db.run("INSERT INTO networks (network_id, network_name, owner_id, created_at) VALUES (?1, ?1, ?2, datetime('now'))", [NET2, OWNER]);
  db.run("INSERT INTO network_members (user_id, network_id, role, joined_at) VALUES (?1, ?2, 'owner', datetime('now'))", [OWNER, NET2]);
  db.run("INSERT INTO nodes (node_id, node_name, alias, network_id, created_at, updated_at) VALUES (?1, 'dept-err-a', 'dept-err-a', ?2, datetime('now'), datetime('now'))", [AGENT, NET]);
}

/** networkId 传 null 才能走到 `network_required`：工具从上下文取网络，取不到就拒。 */
async function connect(callerUserId: string, networkId: string | null) {
  const server = new McpServer({ name: "dept-err-test", version: "1" });
  registerTools(server, undefined, networkId, callerUserId, "dept-err-a", true, null);
  const client = new Client({ name: "dept-err-client", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  return { client, server };
}

type Result = { content: Array<{ type: string; text?: string }>; isError?: boolean };
const json = (r: Result) => JSON.parse(String(r.content[0]?.text ?? "{}"));

beforeEach(seed);
afterAll(cleanup);

describe("#3309 departments 错误值域：四个入口校验各有一条会红的断言", () => {
  test("没有网络上下文 ⇒ error === network_required", async () => {
    const { client, server } = await connect(OWNER, null);
    try {
      const r = json(await client.callTool({ name: "departments", arguments: { action: "list" } }) as Result);
      expect(r.ok).toBe(false);
      expect(r.error).toBe("network_required");
    } finally { await server.close(); }
  });

  test("update 不带 department_id ⇒ error === department_required", async () => {
    const { client, server } = await connect(OWNER, NET);
    try {
      const r = json(await client.callTool({ name: "departments", arguments: { action: "update", name: "x" } }) as Result);
      expect(r.ok).toBe(false);
      expect(r.error).toBe("department_required");
    } finally { await server.close(); }
  });

  test("delete 不带 department_id ⇒ error === department_required", async () => {
    const { client, server } = await connect(OWNER, NET);
    try {
      const r = json(await client.callTool({ name: "departments", arguments: { action: "delete" } }) as Result);
      expect(r.ok).toBe(false);
      expect(r.error).toBe("department_required");
    } finally { await server.close(); }
  });

  test("assign_agent 既不给 node_id 也不给 alias ⇒ error === agent_required", async () => {
    const { client, server } = await connect(OWNER, NET);
    try {
      const r = json(await client.callTool({ name: "departments", arguments: { action: "assign_agent" } }) as Result);
      expect(r.ok).toBe(false);
      expect(r.error).toBe("agent_required");
    } finally { await server.close(); }
  });

  test("assign_agent 给的 alias 不存在 ⇒ error === agent_not_found（不是 agent_required）", async () => {
    const { client, server } = await connect(OWNER, NET);
    try {
      const r = json(await client.callTool({
        name: "departments", arguments: { action: "assign_agent", alias: "no-such-alias-xyz" },
      }) as Result);
      expect(r.ok).toBe(false);
      // 这两个值的区别就是这张测试存在的理由：alias 给了但查不到 ≠ 什么也没给。
      // 只断言 ok===false 时，两者同形，而调用方要做的补救完全不同。
      expect(r.error).toBe("agent_not_found");
      expect(r.error).not.toBe("agent_required");
    } finally { await server.close(); }
  });

  test("这四个错误形状都**没有** code 字段（记下来，不假装是契约）", async () => {
    const { client, server } = await connect(OWNER, NET);
    try {
      const cases = [
        { action: "update", name: "x" },
        { action: "delete" },
        { action: "assign_agent" },
        { action: "assign_agent", alias: "no-such-alias-xyz" },
      ];
      for (const args of cases) {
        const r = json(await client.callTool({ name: "departments", arguments: args }) as Result);
        expect(r.ok).toBe(false);
        // 现状：只有 error 字符串。按 code 分支的客户端会把这四条全落进 unknown。
        expect(Object.prototype.hasOwnProperty.call(r, "code")).toBe(false);
      }
    } finally { await server.close(); }
  });
});

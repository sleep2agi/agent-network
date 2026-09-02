// #1756 — 标准 MCP 客户端的 tools/list 必须能成功。
//
// 2026-09-02 量到:main 上 client.listTools() 直接抛
//   McpError -32603: undefined is not an object (evaluating 'schema._zod')
// 逐字段二分,肇事者是四处 `z.record(z.unknown())`(report_status.config_snapshot /
// send_desktop_message.meta / update_node_config.patch.flags / create_node.node_spec.*):
// zod v4 的 z.record 要两个参数(key, value),单参数时 value schema 是 undefined,
// SDK 生成 JSON Schema 时对它取 `_zod` 就炸。修法:z.record(z.string(), z.unknown())。
//
// 这条测试守两件事:① listTools 整体成功且条数 == 登记表条数;② 每个工具单独都能
// toJSONSchema —— 第 ② 条让下一次谁再写单参 record 时,红的是「哪个工具哪个字段」。
// 跑法:cd server && COMMHUB_DB=/tmp/lt.db bun test src/tools-list-json-schema.test.ts
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { registerTools } from "./tools.js";

async function connect() {
  const server = new McpServer({ name: "list-tools-test", version: "1" });
  registerTools(server, undefined, "net_list_tools", "u_list_tools", "u_list_tools", false, "tok_list_tools");
  const client = new Client({ name: "list-tools-client", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  return { server, client, close: async () => { await client.close(); await server.close(); } };
}

describe("#1756 tools/list", () => {
  test("every registered tool converts to JSON Schema on its own (names the offender)", async () => {
    const { server, close } = await connect();
    try {
      const reg: Record<string, any> = (server as any)._registeredTools;
      const names = Object.keys(reg);
      expect(names.length).toBeGreaterThan(40);
      const bad: string[] = [];
      for (const n of names) {
        const schema = reg[n]?.inputSchema;
        const shape = schema?.shape ?? schema ?? {};
        for (const [k, v] of Object.entries(shape)) {
          try { z.toJSONSchema(z.object({ [k]: v as any })); } catch (e: any) { bad.push(`${n}.${k}: ${String(e?.message).slice(0, 60)}`); }
        }
      }
      expect(bad).toEqual([]);
    } finally { await close(); }
  }, 20_000);

  test("client.listTools() succeeds and returns every registered tool", async () => {
    const { server, client, close } = await connect();
    try {
      const reg: Record<string, any> = (server as any)._registeredTools;
      const listed = (await client.listTools()).tools;
      expect(listed.length).toBe(Object.keys(reg).length);
      const byName = new Set(listed.map(t => t.name));
      for (const n of ["report_status", "send_desktop_message", "update_node_config", "create_node", "read_node_rules_file"]) {
        expect(byName.has(n), n).toBe(true);
      }
      // 修过的四个字段在 JSON Schema 里必须是 object(不是 undefined / 空)
      const schemaOf = (n: string) => listed.find(t => t.name === n)!.inputSchema as any;
      expect(schemaOf("report_status").properties.config_snapshot).toBeDefined();
      expect(schemaOf("send_desktop_message").properties.meta.type).toBe("object");
      expect(schemaOf("update_node_config").properties.patch.properties.flags.type).toBe("object");
    } finally { await close(); }
  }, 20_000);
});

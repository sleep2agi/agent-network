// #476(#469 MCP 审计的最后一项)—— Hub MCP 面的上下文成本。
//
// 钉住:
//   1. tools/list 的总字节有上限(TOOLS_LIST_MAX_BYTES):描述 / 参数说明不能悄悄长回去。每个工具也有上限,
//      单条工具描述有上限。要加新工具 / 新说明,改这里的数字 —— 改的时候就会被看见。
//   2. requirements_events 不带 requirement_id(全网动态)默认 50 条、从新到旧、next_cursor 翻更早的;
//      带 requirement_id 的单卡调用不变(默认 200);REST /api/requirements/events 不变(默认 200,App 用它)。
//   3. requirements_events 参数严格:不认识的参数 → -32602,列出能用的参数。
//
// 跑法:cd server && COMMHUB_DB=/tmp/x.db bun test src/mcp-context-cost-http.test.ts
//       PG:COMMHUB_TEST_PG_URL=… COMMHUB_PG_EXPERIMENTAL=1(tests/test2123-hub-postgres-ladder 里注册)
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { register } from "./auth.js";
import { registerTools } from "./tools.js";

const activeDbPath = process.env.COMMHUB_DB ?? (process.env.COMMHUB_TEST_PG_URL ? "postgres" : undefined);
if (!activeDbPath) throw new Error("mcp-context-cost requires COMMHUB_DB (or COMMHUB_TEST_PG_URL) before module import");

/**
 * tools/list 整份 JSON 的字节上限。#476 之前(main,含 #475)74 个工具 76,824 B;修剪后 71,399 B。
 * 上限留 ~1.1 KB 余量;加工具或加说明超过它,就在这里改数字并在 PR 里说为什么。
 */
const TOOLS_LIST_MAX_BYTES = 72_500;
/** 单个工具(名字 + 描述 + 输入 schema)的上限;最大的是 report_status(节点心跳,~8.4 KB 的遥测结构)。 */
const TOOL_MAX_BYTES = 9_000;
/** 单条工具描述的上限(说明写进参数的 describe,或者拆短)。 */
const DESCRIPTION_MAX_BYTES = 1_000;
const NETWORK_EVENTS = 80;

let server: any;
let base = "";
let token = "", netId = "";
let close: () => Promise<void>;
let client: Client;
const call = async (name: string, args: Record<string, unknown>) => {
  const r: any = await client.callTool({ name, arguments: args });
  const text = String(r.content?.[0]?.text ?? "");
  return r.isError ? { mcpError: true, text } : { ...JSON.parse(text), _bytes: Buffer.byteLength(text, "utf8") };
};
let busyId = "";

beforeAll(async () => {
  const u = register(`ctx_${Date.now()}`, "CtxCost123!", undefined, "seed");
  token = u.token!; netId = u.network_id!;
  const s = new McpServer({ name: "ctx", version: "1" });
  registerTools(s, undefined, null, u.user!.user_id, u.user!.username, false, "tok_user");
  client = new Client({ name: "ctx-client", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await s.connect(st);
  await client.connect(ct);
  close = async () => { await client.close(); await s.close(); };
  const mod: any = await import("./server.js");
  server = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${server.port}`;
  // 一张卡上 60 条评论(单卡调用要能拿到 > 50 条),再加 20 张卡各一条
  const busy = await call("requirements_create", { network_id: netId, name: "busy task" });
  busyId = busy.requirement.id;
  for (let i = 0; i < 60; i++) expect((await call("requirements_comment", { network_id: netId, id: busyId, text: `进展 ${i}:这一步完成了` })).ok).toBe(true);
  for (let i = 0; i < NETWORK_EVENTS - 60; i++) {
    const r = await call("requirements_create", { network_id: netId, name: `task ${i}` });
    await call("requirements_comment", { network_id: netId, id: r.requirement.id, text: "已开始" });
  }
}, 120_000);
afterAll(async () => { await close?.(); server?.stop?.(true); });

describe("#476 tools/list size", () => {
  test("total, per tool and per description stay under their ceilings", async () => {
    const { tools } = await client.listTools();
    const total = Buffer.byteLength(JSON.stringify({ tools }), "utf8");
    const sizes = tools.map((t: any) => ({ name: t.name, all: Buffer.byteLength(JSON.stringify(t)), desc: Buffer.byteLength(t.description ?? "") }));
    sizes.sort((a, b) => b.all - a.all);
    console.log(`tools/list: ${tools.length} tools, ${total} B; largest ${sizes.slice(0, 3).map(x => `${x.name}=${x.all}`).join(", ")}`);
    expect(total).toBeLessThanOrEqual(TOOLS_LIST_MAX_BYTES);
    for (const x of sizes) {
      expect(x.all, x.name).toBeLessThanOrEqual(TOOL_MAX_BYTES);
      expect(x.desc, x.name).toBeLessThanOrEqual(DESCRIPTION_MAX_BYTES);
    }
  });
});

describe("#476 requirements_events defaults", () => {
  test("network-wide: 50 newest by default, next_cursor pages older events", async () => {
    const p1 = await call("requirements_events", { network_id: netId });
    expect(p1.events.length).toBe(50);
    expect(typeof p1.next_cursor).toBe("string");
    const times = p1.events.map((e: any) => e.at ?? e.created_at);
    expect([...times].sort().reverse()).toEqual(times);
    const p2 = await call("requirements_events", { network_id: netId, cursor: p1.next_cursor });
    const ids = new Set([...p1.events, ...p2.events].map((e: any) => e.id));
    expect(ids.size).toBe(p1.events.length + p2.events.length);
    console.log(`network events page of 50: ${p1._bytes} B`);
    expect(p1._bytes).toBeLessThan(25_000);
  });

  test("an explicit limit still wins; one task's timeline keeps its old default (200)", async () => {
    expect((await call("requirements_events", { network_id: netId, limit: 70 })).events.length).toBe(70);
    const one = await call("requirements_events", { network_id: netId, requirement_id: busyId });
    expect(one.events.filter((e: any) => e.kind === "comment").length).toBe(60);
  });

  test("REST GET /api/requirements/events is unchanged (default 200)", async () => {
    const res = await fetch(`${base}/api/requirements/events?network_id=${netId}`, { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json() as any;
    expect(res.status).toBe(200);
    expect(body.events.length).toBeGreaterThan(50);
  });

  test("unknown parameters → -32602 listing the valid ones", async () => {
    const r = await call("requirements_events", { network_id: netId, task_id: busyId });
    expect(r.mcpError).toBe(true);
    expect(r.text).toContain("-32602");
    expect(r.text).toContain("unknown parameter(s): task_id; valid parameters: network_id, requirement_id, since, limit, cursor");
  });
});

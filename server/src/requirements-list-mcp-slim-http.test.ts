// #471(#469 问题 3)—— MCP requirements_list 默认省流 + 严格参数。
//
// 钉住:
//   1. MCP 默认 = summary 视图 + 50 张一页:120 张有正文 / 检查项 / 标签 / 参与人的卡,第一页 50 张、has_more、
//      next_cursor 接着翻,两页不重叠;一页的线上字节有上限(见 SUMMARY_PAGE_MAX_BYTES)。
//   2. view='full' 照旧给全文(description / checklist);limit 可显式放大。
//   3. 不认识的参数(以前的 tag 写错成 tags / 任何拼错)→ -32602,错误里列出能用的参数;不会回整张表。
//   4. tag= 精确筛(区分大小写),和 limit / cursor 一起翻页。
//   5. REST GET /api/requirements 不变:不带参数仍是 full + 最多 500 张(App 靠它)。
//
// 跑法:cd server && COMMHUB_DB=/tmp/x.db bun test src/requirements-list-mcp-slim-http.test.ts
//       PG:COMMHUB_TEST_PG_URL=… COMMHUB_PG_EXPERIMENTAL=1(tests/test2123-hub-postgres-ladder 里注册)
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { register } from "./auth.js";
import { registerTools } from "./tools.js";

const activeDbPath = process.env.COMMHUB_DB ?? (process.env.COMMHUB_TEST_PG_URL ? "postgres" : undefined);
if (!activeDbPath) throw new Error("requirements-list-mcp-slim requires COMMHUB_DB (or COMMHUB_TEST_PG_URL) before module import");

const TASKS = 120;
/**
 * 一页 summary(50 张;每张中文标题、3 个标签、负责人 + 参与人、8 条检查项、1.5 KB 正文)的字节上限。
 * 这批数据实测 39.7 KB(≈ 795 B / 张,中文 3 字节 / 字);生产 122 张 summary 81 KB ≈ 670 B / 张 → 50 张约 33 KB。
 * 上限 45 KB。同一批数据走旧默认(full、500 张)是整张表 120 张全文。
 */
const SUMMARY_PAGE_MAX_BYTES = 45_000;

let server: any;
let base = "";
let token = "", userId = "", netId = "";
let call: (args: Record<string, unknown>) => Promise<{ isError: boolean; text: string }>;
let closeMcp: () => Promise<void>;

const DESCRIPTION = "背景:".padEnd(1500, "这是一段很长的任务描述,用来模拟真实看板上的正文。");
const checklist = Array.from({ length: 8 }, (_, i) => ({ text: `检查项 ${i + 1}:确认这一步已经完成并且有记录` }));

beforeAll(async () => {
  const stamp = Date.now();
  const u = register(`slim_${stamp}`, "SlimList123!", undefined, "seed");
  expect(u.ok).toBe(true);
  token = u.token!; userId = u.user!.user_id; netId = u.network_id!;
  const mod: any = await import("./server.js");
  server = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${server.port}`;

  const s = new McpServer({ name: "slim", version: "1" });
  registerTools(s, undefined, null, userId, u.user!.username, false, "tok_user");
  const client = new Client({ name: "slim-client", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await s.connect(st);
  await client.connect(ct);
  const raw = async (name: string, args: Record<string, unknown>) => {
    const r: any = await client.callTool({ name, arguments: args });
    return { isError: r.isError === true, text: String(r.content?.[0]?.text ?? "") };
  };
  call = (args) => raw("requirements_list", { network_id: netId, ...args });
  closeMcp = async () => { await client.close(); await s.close(); };

  for (let i = 0; i < TASKS; i++) {
    const tags = ["bug", "后端", `批次${i % 4}`];
    if (i % 3 === 0) tags[0] = "Bug"; // 大小写不同的另一个标签
    const r = await raw("requirements_create", {
      network_id: netId, name: `任务 ${i}:修复列表接口返回过大的问题`, description: DESCRIPTION, checklist, tags,
      owner: { kind: "user", id: userId }, participants: [{ kind: "user", id: userId }],
      priority: "normal", column: i % 2 ? "doing" : "pool",
    });
    expect(r.isError).toBe(false);
  }
}, 120_000);

afterAll(async () => { await closeMcp?.(); server?.stop?.(true); });

describe("#471 MCP requirements_list defaults", () => {
  test("default = summary, 50 per page, under the byte bound; cursor pages without overlap", async () => {
    const first = await call({});
    expect(first.isError).toBe(false);
    const bytes = Buffer.byteLength(first.text, "utf8");
    const body = JSON.parse(first.text);
    expect(body.view).toBe("summary");
    expect(body.requirements.length).toBe(50);
    expect(body.has_more).toBe(true);
    expect(typeof body.next_cursor).toBe("string");
    for (const r of body.requirements) {
      expect(r.description).toBeUndefined();
      expect(r.checklist).toBeUndefined();
      expect(r.has_description).toBe(true);
      expect(r.checklist_count).toEqual({ total: 8, done: 0 });
    }
    console.log(`summary page of 50: ${bytes} B`);
    expect(bytes).toBeLessThan(SUMMARY_PAGE_MAX_BYTES);

    const second = JSON.parse((await call({ cursor: body.next_cursor })).text);
    expect(second.requirements.length).toBe(50);
    const third = JSON.parse((await call({ cursor: second.next_cursor })).text);
    expect(third.requirements.length).toBe(TASKS - 100);
    expect(third.has_more).toBe(false);
    const ids = [...body.requirements, ...second.requirements, ...third.requirements].map((r: any) => r.id);
    expect(new Set(ids).size).toBe(TASKS);
  });

  test("view='full' still returns description and checklist; limit is honoured", async () => {
    const r = JSON.parse((await call({ view: "full", limit: 3 })).text);
    expect(r.view).toBeUndefined();
    expect(r.requirements.length).toBe(3);
    expect(r.requirements[0].description).toBe(DESCRIPTION);
    expect(r.requirements[0].checklist.length).toBe(8);
  });

  test("unknown parameters → -32602 listing the valid ones; never the whole table", async () => {
    for (const bad of [{ tags: "bug" }, { lable: "x" }, { status: "doing", foo: 1 }]) {
      const r = await call(bad);
      expect(r.isError).toBe(true);
      expect(r.text).toContain("-32602");
      expect(r.text).toContain(`unknown parameter(s): ${Object.keys(bad).filter(k => k !== "status").join(", ")}`);
      expect(r.text).toContain("valid parameters: network_id, seq, status, project_id, owner, agent_owner, tag,");
      expect(r.text).not.toContain('"requirements":[');
    }
  });

  test("tag = exact label match (case-sensitive), pages with limit/cursor", async () => {
    const lower = JSON.parse((await call({ tag: "bug", limit: 100 })).text);
    expect(lower.requirements.length).toBe(TASKS - TASKS / 3);
    expect(lower.requirements.every((r: any) => r.tags.includes("bug"))).toBe(true);
    const upper = JSON.parse((await call({ tag: "Bug", limit: 100 })).text);
    expect(upper.requirements.length).toBe(TASKS / 3);
    expect(upper.requirements.every((r: any) => r.tags.includes("Bug") && !r.tags.includes("bug"))).toBe(true);
    const p1 = JSON.parse((await call({ tag: "批次1", limit: 20 })).text);
    expect(p1.requirements.length).toBe(20);
    expect(p1.has_more).toBe(true);
    const p2 = JSON.parse((await call({ tag: "批次1", limit: 20, cursor: p1.next_cursor })).text);
    expect(p2.requirements.length).toBe(TASKS / 4 - 20);
    expect(p2.has_more).toBe(false);
    expect((await call({ tag: "nope" })).text).toContain('"requirements":[]');
    // tag + q 组合:两个条件都要满足
    const both = JSON.parse((await call({ tag: "批次2", q: "任务 10", limit: 100 })).text);
    expect(both.requirements.map((r: any) => r.name)).toContain("任务 10:修复列表接口返回过大的问题");
    expect(both.requirements.every((r: any) => r.tags.includes("批次2") && /任务 \d*10/.test(r.name))).toBe(true);
  });

  test("REST GET /api/requirements is unchanged: no params = full view, up to 500", async () => {
    const res = await fetch(`${base}/api/requirements?network_id=${netId}`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.view).toBeUndefined();
    expect(body.requirements.length).toBe(TASKS);
    expect(body.requirements[0].description).toBe(DESCRIPTION);
    // REST 的 tag= 是新增的可选参数:不合法 → 400,与其它筛选参数同一形状
    const bad = await fetch(`${base}/api/requirements?network_id=${netId}&tag=${"x".repeat(21)}`, { headers: { Authorization: `Bearer ${token}` } });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error).toBe("invalid_tag");
  });
});

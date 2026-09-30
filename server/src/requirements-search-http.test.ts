// GET /api/requirements 的 q= 服务端搜索与 limit / cursor 分页(requirements-search.ts)。一次性 hub:临时 DB、端口 0。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "anet-req-search-"));
process.env.COMMHUB_DB = join(dir, "hub.db");

let server: { port: number; stop?: (force?: boolean) => void };
let base = "";
let token = "";
let otherToken = "";
let net = "";
let db: any;

async function api(tok: string, path: string, init?: RequestInit) {
  const res = await fetch(`${base}${path}`, { ...init, headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json", ...(init?.headers || {}) } });
  return { status: res.status, body: await res.json() as any };
}
const list = (query: string, tok = token) => api(tok, `/api/requirements?network_id=${net}${query ? `&${query}` : ""}`);
const ids = async (query: string, tok = token) => {
  const r = await list(query, tok);
  expect(r.status).toBe(200);
  return (r.body.requirements as any[]).map(x => x.name);
};

beforeAll(async () => {
  ({ db } = await import("./db.js"));
  const { register } = await import("./auth.js");
  const owner = register(`search_owner_${Date.now()}`, "SearchOwner123!", undefined, "seed");
  token = owner.token!;
  net = owner.network_id!;
  const other = register(`search_other_${Date.now()}`, "SearchOther123!", undefined, "seed");
  otherToken = other.token!;
  const mod: any = await import("./server.js");
  server = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${server.port}`;
  db.run("INSERT INTO nodes(node_id,node_name,alias,display_name,network_id) VALUES (?1,?2,?2,?3,?4)", ["n_search_a", "portal-cow", "示例-门户牛", net]);
  const project = await api(token, "/api/requirements/projects", { method: "POST", body: JSON.stringify({ name: "示例门户项目", network_id: net }) });
  const pid = project.body.project.id;
  const mk = (name: string, extra: Record<string, unknown> = {}) => api(token, "/api/requirements", { method: "POST", body: JSON.stringify({ name, network_id: net, ...extra }) });
  await mk("企业组织树权限设置");
  await mk("Portal Token 管理 | 估算成本卡布局", { agent_owner: { kind: "node", id: "n_search_a" }, tags: ["前端"] });
  await mk("Space 网络策略 | 历史 receipt 误报", { description: "看 ![截图](/api/files/abc123) 和 [链接文字](https://example.com/x),重启导致 binding 丢失" });
  await mk("子项目的卡", { project_id: pid });
  const arch = await mk("已归档的组织树旧方案");
  await api(token, `/api/requirements/${arch.body.requirement.id}`, { method: "PATCH", body: JSON.stringify({ archived: true }) });
  await api(otherToken, "/api/requirements", { method: "POST", body: JSON.stringify({ name: "别的网络的组织树" }) });
}, 30_000);

afterAll(() => {
  try { server?.stop?.(true); } catch {}
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

describe("q= server-side search (same semantics as the app's task search)", () => {
  test("title substring, CJK, case-insensitive, full-width input", async () => {
    expect(await ids("q=" + encodeURIComponent("组织树"))).toEqual(["企业组织树权限设置"]);
    expect(await ids("q=portal")).toEqual(["Portal Token 管理 | 估算成本卡布局"]);
    expect(await ids("q=" + encodeURIComponent("ＰＯＲＴＡＬ"))).toEqual(["Portal Token 管理 | 估算成本卡布局"]);
  });
  test("agent owner display name, tags, project name, description text (not URLs)", async () => {
    expect(await ids("q=" + encodeURIComponent("门户牛"))).toEqual(["Portal Token 管理 | 估算成本卡布局"]);
    expect(await ids("q=" + encodeURIComponent("前端"))).toEqual(["Portal Token 管理 | 估算成本卡布局"]);
    expect(await ids("q=" + encodeURIComponent("示例门户项目"))).toEqual(["子项目的卡"]);
    expect(await ids("q=binding")).toEqual(["Space 网络策略 | 历史 receipt 误报"]);
    expect(await ids("q=" + encodeURIComponent("链接文字"))).toEqual(["Space 网络策略 | 历史 receipt 误报"]);
    expect(await ids("q=abc123")).toEqual([]);
    expect(await ids("q=example.com")).toEqual([]);
  });
  test("space-separated terms are ANDed across fields", async () => {
    expect(await ids("q=" + encodeURIComponent("成本 门户牛"))).toEqual(["Portal Token 管理 | 估算成本卡布局"]);
    expect(await ids("q=" + encodeURIComponent("成本 receipt"))).toEqual([]);
  });
  test("archived only with archived=true / include_archived=1; other networks never", async () => {
    expect(await ids("q=" + encodeURIComponent("组织树"))).toEqual(["企业组织树权限设置"]);
    expect(await ids("archived=true&q=" + encodeURIComponent("组织树"))).toEqual(["已归档的组织树旧方案"]);
    expect((await ids("include_archived=1&q=" + encodeURIComponent("组织树"))).sort()).toEqual(["企业组织树权限设置", "已归档的组织树旧方案"].sort());
  });
  test("combines with the other filters", async () => {
    expect(await ids("status=done&q=portal")).toEqual([]);
    expect(await ids("agent_owner=node:n_search_a&q=" + encodeURIComponent("成本"))).toEqual(["Portal Token 管理 | 估算成本卡布局"]);
  });
  test("empty / whitespace q = no search; too long q = 400", async () => {
    expect((await ids("q=")).length).toBe(4);
    expect((await ids("q=%20%20")).length).toBe(4);
    const r = await list("q=" + "x".repeat(201));
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid_q");
  });
});

describe("paging: limit / cursor / has_more / next_cursor", () => {
  test("no params: legacy shape plus has_more=false, next_cursor=null, capabilities advertise search + paging", async () => {
    const r = await list("");
    expect(r.body.requirements.length).toBe(4);
    expect(r.body.has_more).toBe(false);
    expect(r.body.next_cursor).toBeNull();
    expect(r.body.capabilities).toContain("search");
    expect(r.body.capabilities).toContain("paging");
  });
  test("walking pages returns every row exactly once, newest first, including same-timestamp ties", async () => {
    // 25 张,其中 10 张同一个 created_at(翻页边界落在并列上也不能漏 / 重)
    const same = new Date(Date.now() + 60_000).toISOString();
    for (let i = 0; i < 25; i++) {
      const c = await api(token, "/api/requirements", { method: "POST", body: JSON.stringify({ name: `页-${String(i).padStart(2, "0")}`, network_id: net }) });
      if (i >= 10 && i < 20) db.run("UPDATE requirements SET created_at = ?1 WHERE requirement_id = ?2", [same, c.body.requirement.id]);
    }
    const full = await ids("limit=1000");
    expect(full.length).toBe(29);
    const seen: string[] = [];
    let cursor = "";
    let pages = 0;
    for (;;) {
      const r = await list(`limit=7${cursor ? `&cursor=${cursor}` : ""}`);
      expect(r.status).toBe(200);
      seen.push(...r.body.requirements.map((x: any) => x.name));
      pages++;
      if (!r.body.has_more) { expect(r.body.next_cursor).toBeNull(); break; }
      expect(typeof r.body.next_cursor).toBe("string");
      cursor = r.body.next_cursor;
      expect(pages).toBeLessThan(10);
    }
    expect(pages).toBe(5);
    expect(seen).toEqual(full);
    expect(new Set(seen).size).toBe(29);
  });
  test("q= pages too", async () => {
    const first = await list("limit=4&q=" + encodeURIComponent("页-"));
    expect(first.body.requirements.length).toBe(4);
    expect(first.body.has_more).toBe(true);
    const rest = await list(`limit=100&q=${encodeURIComponent("页-")}&cursor=${first.body.next_cursor}`);
    expect(rest.body.requirements.length).toBe(21);
    expect(rest.body.has_more).toBe(false);
  });
  test("default limit stays 500 (legacy clients see the same cap)", async () => {
    const { DEFAULT_LIST_LIMIT } = await import("./requirements-search.js");
    expect(DEFAULT_LIST_LIMIT).toBe(500);
  });
  test("bad limit / cursor → 400", async () => {
    for (const q of ["limit=0", "limit=1001", "limit=abc", "limit=-1", "cursor=%%%", "cursor=bm9wZQ"]) {
      const r = await list(q);
      expect(r.status).toBe(400);
      expect(["invalid_limit", "invalid_cursor"]).toContain(r.body.error);
    }
  });
  test("ETag still works with the new fields", async () => {
    const first = await fetch(`${base}/api/requirements?network_id=${net}&limit=5`, { headers: { Authorization: `Bearer ${token}` } });
    const etag = first.headers.get("etag")!;
    await first.text();
    const again = await fetch(`${base}/api/requirements?network_id=${net}&limit=5`, { headers: { Authorization: `Bearer ${token}`, "If-None-Match": etag } });
    expect(again.status).toBe(304);
  });
});

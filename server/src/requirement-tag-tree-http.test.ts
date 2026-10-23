// 标签树(POST /api/requirements/tags/create + GET /api/requirements/tags 的 nodes + ops 维护层级)
// —— HTTP 集成测试(真实 Bun.serve,私有端口,临时库)。
//
// 场景:Hub 管理员 admin 的网络 NET,另一个不相干的网络 NET2。成员:
//   carol —— task_access='all' 的老成员(能管标签);
//   alice —— scoped 成员(不能管);
//   vic   —— viewer;
//   nodeToken —— 节点令牌。
//
// 正向:建根标签、建子标签并回读 parent_id/depth;0 任务的子标签能在 nodes 里读到;父只在卡片上出现过时
//       补登记成顶层(parent_registered=true)且子标签仍挂在它下面;改名 / 合并 / 删除让层级跟着动。
// 反向:重名 409、父不存在 404(不 root fallback)、超过 4 层 400、scoped / viewer / 节点令牌 403 且一行都不写、
//       同名标签在别的网络互不相干、坏参数 400、原子性(重名失败后不留半条节点)。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "anet-tag-tree-"));
let BASE = "";
let hub: any = null;
let db: any = null;
const PW = "TagTreePassw0rd!x";
let NET = "";
let NET2 = "";
let admin = { token: "", id: "" };
let other = { token: "", id: "" };
let alice = { token: "", id: "" };
let carol = { token: "", id: "" };
let vic = { token: "", id: "" };
let nodeToken = "";

type R = { status: number; body: any };
async function send(token: string, method: string, path: string, payload?: unknown): Promise<R> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch {}
  return { status: res.status, body };
}

const create = (token: string, payload: unknown, net = NET) => send(token, "POST", `/api/requirements/tags/create?network_id=${net}`, payload);
const tagsOf = (token: string, net = NET) => send(token, "GET", `/api/requirements/tags?network_id=${net}`);
const op = (token: string, payload: unknown, net = NET) => send(token, "POST", `/api/requirements/tags/ops?network_id=${net}`, payload);
const nodesOf = async (token = admin.token, net = NET): Promise<Record<string, { parent: string | null; depth: number; count: number; registered: boolean }>> => {
  const r = await tagsOf(token, net);
  expect(r.status).toBe(200);
  return Object.fromEntries((r.body.nodes ?? []).map((n: any) => [n.name, { parent: n.parent_id, depth: n.depth, count: n.count, registered: n.registered }]));
};
const nodeRows = (net = NET) => db.all("SELECT name, parent_name FROM network_tag_nodes WHERE network_id = ?1 ORDER BY name", [net]);

beforeAll(async () => {
  process.env.COMMHUB_DB ||= join(DIR, "hub.db");
  process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
  process.env.HOST = "127.0.0.1";
  ({ db } = await import("./db.js"));
  const { createNetworkTokenForNode, register } = await import("./auth.js");
  const stamp = Date.now();
  const a = register(`tt_admin_${stamp}`, PW, undefined, "Admin");
  expect(a.ok).toBe(true);
  admin = { token: a.token!, id: a.user!.user_id };
  NET = a.network_id!;
  db.run("UPDATE users SET role = 'admin' WHERE user_id = ?1", [admin.id]);
  const b = register(`tt_other_${stamp}`, PW, undefined, "Other");
  expect(b.ok).toBe(true);
  other = { token: b.token!, id: b.user!.user_id };
  NET2 = b.network_id!;
  const ntok = createNetworkTokenForNode(admin.id, NET, "tag-node");
  expect(ntok.ok).toBe(true);
  nodeToken = ntok.token!;

  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;

  const mk = async (username: string, role: string) => {
    const r = await send(admin.token, "POST", "/api/admin/users", { username, password: PW, network_id: NET, role });
    expect(r.status).toBe(200);
    const login = await send("", "POST", "/api/auth/login", { username, password: PW });
    expect(login.status).toBe(200);
    return { token: login.body.token as string, id: login.body.user.user_id as string };
  };
  alice = await mk(`tt_alice_${stamp}`, "member");
  carol = await mk(`tt_carol_${stamp}`, "member");
  vic = await mk(`tt_vic_${stamp}`, "viewer");
  db.run("UPDATE network_members SET task_access = 'scoped' WHERE network_id = ?1 AND user_id = ?2", [NET, alice.id]);
  db.run("UPDATE network_members SET task_access = 'all' WHERE network_id = ?1 AND user_id = ?2", [NET, carol.id]);

  // 一张只有 legacy 标签的卡:它的标签没有节点行 —— 用来验证「拿在用标签当父」时补登记。
  const card = await send(admin.token, "POST", "/api/requirements", { network_id: NET, name: "legacy", tags: ["legacy"] });
  expect(card.status).toBe(201);
}, 30_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("capability 与权限", () => {
  test("列表 capabilities 带 tag_tree(旧客户端忽略)", async () => {
    const r = await send(admin.token, "GET", `/api/requirements?network_id=${NET}`);
    expect(r.body.capabilities).toContain("tag_tree");
  });

  test("scoped / viewer / 节点令牌 403,且一行节点都不写", async () => {
    for (const token of [alice.token, vic.token, nodeToken]) {
      const r = await create(token, { name: "被拒" });
      expect(r.status).toBe(403);
    }
    expect(nodeRows()).toEqual([]);
  });

  test("网络管理员与 task_access='all' 的老成员能建", async () => {
    const r = await create(carol.token, { name: "carol建的" });
    expect(r.status).toBe(201);
    expect(r.body.tag).toEqual({ name: "carol建的", parent_id: null, depth: 1 });
    const del = await op(admin.token, { op: "delete", tag: "carol建的" });
    expect(del.status).toBe(200);
  });
});

describe("建根标签与子标签", () => {
  test("建根标签:201,parent_id=null,depth=1", async () => {
    const r = await create(admin.token, { name: "需求" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ ok: true, tag: { name: "需求", parent_id: null, depth: 1 }, parent_registered: false });
  });

  test("0 任务的标签也能在 nodes 里读到(count=0,registered=true)", async () => {
    const nodes = await nodesOf();
    expect(nodes["需求"]).toEqual({ parent: null, depth: 1, count: 0, registered: true });
    // tags(卡片上出现过的)保持旧语义:0 任务的标签不在里面
    const t = await tagsOf(admin.token);
    expect(t.body.tags).not.toContain("需求");
  });

  test("建子标签:回读 parent_id / depth / count=0", async () => {
    const r = await create(admin.token, { name: "前端", parent_id: "需求" });
    expect(r.status).toBe(201);
    expect(r.body.tag).toEqual({ name: "前端", parent_id: "需求", depth: 2 });
    const nodes = await nodesOf();
    expect(nodes["前端"]).toEqual({ parent: "需求", depth: 2, count: 0, registered: true });
  });

  test("三代:第 3 层 depth=3;超过 MAX_TAG_DEPTH 的第 4 层子标签 400", async () => {
    const l3 = await create(admin.token, { name: "按钮", parent_id: "前端" });
    expect(l3.status).toBe(201);
    expect(l3.body.tag.depth).toBe(3);
    const l4 = await create(admin.token, { name: "主按钮", parent_id: "按钮" });
    expect(l4.status).toBe(201);
    expect(l4.body.tag.depth).toBe(4);
    const l5 = await create(admin.token, { name: "太深了", parent_id: "主按钮" });
    expect(l5.status).toBe(400);
    expect(l5.body.error).toBe("tag_depth_exceeded");
    expect(nodeRows().some((r: any) => r.name === "太深了")).toBe(false);
  });

  test("重名 409:已登记的、卡片上在用的、有颜色行的都算重名;失败不留半条", async () => {
    expect((await create(admin.token, { name: "需求" })).body.error).toBe("tag_exists");
    expect((await create(admin.token, { name: "legacy" })).body.error).toBe("tag_exists");
    // 只有颜色行、没有卡片也没有节点的名字也算存在(直接写库构造这种历史状态)
    db.run("INSERT INTO network_tags (network_id, name, color, updated_at) VALUES (?1, ?2, ?3, ?4)", [NET, "有颜色的", "#112233", new Date().toISOString()]);
    const colored = await create(admin.token, { name: "有颜色的" });
    expect(colored.body.error).toBe("tag_exists");
    const before = nodeRows();
    expect(before.map((r: any) => r.name)).not.toContain("有颜色的");
  });

  test("父不存在 404 parent_not_found —— 不会静默建到根上", async () => {
    const r = await create(admin.token, { name: "孤儿", parent_id: "不存在的父" });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("parent_not_found");
    expect(nodeRows().some((row: any) => row.name === "孤儿")).toBe(false);
  });

  test("父只在卡片上出现过:补登记成顶层节点(parent_registered=true),子标签仍挂在它下面", async () => {
    const r = await create(admin.token, { name: "legacy子", parent_id: "legacy" });
    expect(r.status).toBe(201);
    expect(r.body.parent_registered).toBe(true);
    expect(r.body.tag).toEqual({ name: "legacy子", parent_id: "legacy", depth: 2 });
    const nodes = await nodesOf();
    expect(nodes["legacy"]).toMatchObject({ parent: null, depth: 1 });
    expect(nodes["legacy子"]).toMatchObject({ parent: "legacy", depth: 2 });
  });

  test("坏参数 400:空名 / 太长 / 控制字符 / parent_id 不是字符串", async () => {
    expect((await create(admin.token, { name: "" })).body.error).toBe("invalid_tag");
    expect((await create(admin.token, { name: "一二三四五六七八九十一二三四五六七八九十多" })).body.error).toBe("invalid_tag");
    expect((await create(admin.token, { name: "换\n行" })).body.error).toBe("invalid_tag");
    const bad = await create(admin.token, { name: "正常", parent_id: 42 });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid_parent_id");
    expect((await create(admin.token, {})).body.error).toBe("invalid_tag");
  });

  test("别的网络同名互不相干:NET2 里能再建「需求」,NET 的树不受影响", async () => {
    const r = await create(other.token, { name: "需求" }, NET2);
    expect(r.status).toBe(201);
    expect(r.body.tag.depth).toBe(1);
    expect((await nodesOf(admin.token, NET2))["需求"]).toMatchObject({ parent: null, depth: 1 });
    expect((await nodesOf(admin.token, NET))["前端"]).toMatchObject({ parent: "需求", depth: 2 });
  });

  test("受限成员的 nodes 只含他看得见的标签(登记过但没有可见卡的名字不外泄)", async () => {
    const r = await tagsOf(alice.token);
    expect(r.status).toBe(200);
    expect(r.body.nodes).toEqual([]);
    expect(r.body.can_manage).toBe(false);
  });
});

describe("改名 / 合并 / 删除让层级跟着动", () => {
  test("rename:节点与子节点的 parent 一起改,深度不变", async () => {
    const r = await op(admin.token, { op: "rename", from: "需求", to: "需求池" });
    expect(r.status).toBe(200);
    const nodes = await nodesOf();
    expect(nodes["需求池"]).toMatchObject({ parent: null, depth: 1 });
    expect(nodes["前端"]).toMatchObject({ parent: "需求池", depth: 2 });
    expect(nodes["按钮"]).toMatchObject({ parent: "前端", depth: 3 });
    expect(nodes["需求"]).toBeUndefined();
  });

  test("rename 到已存在的节点 = 合并:来源的子节点挂到目标,且不会自环", async () => {
    await create(admin.token, { name: "临时" });
    await create(admin.token, { name: "临时子", parent_id: "临时" });
    const r = await op(admin.token, { op: "rename", from: "临时", to: "需求池" });
    expect(r.status).toBe(200);
    const nodes = await nodesOf();
    expect(nodes["临时子"]).toMatchObject({ parent: "需求池", depth: 2 });
    // 目标是来源的子孙时不能自环:把「前端」并到它的子节点「按钮」上
    await op(admin.token, { op: "rename", from: "前端", to: "按钮" });
    const after = await nodesOf();
    expect(after["按钮"].parent).not.toBe("按钮");
    expect(nodeRows().every((row: any) => row.name !== row.parent_name)).toBe(true);
  });

  test("merge:来源节点的子节点挂到目标,来源节点删掉", async () => {
    await create(admin.token, { name: "源A" });
    await create(admin.token, { name: "源A子", parent_id: "源A" });
    await create(admin.token, { name: "目标B" });
    const r = await op(admin.token, { op: "merge", from: ["源A"], to: "目标B" });
    expect(r.status).toBe(200);
    expect(r.body.reparented).toBe(1);
    const nodes = await nodesOf();
    expect(nodes["源A"]).toBeUndefined();
    expect(nodes["源A子"]).toMatchObject({ parent: "目标B", depth: 2 });
  });

  test("delete:子节点挂到被删节点的父(没有父就成根),不丢层级", async () => {
    const before = await nodesOf();
    const r = await op(admin.token, { op: "delete", tag: "按钮" });
    expect(r.status).toBe(200);
    const nodes = await nodesOf();
    // 「按钮」的父是「需求池」(rename 之后),所以「主按钮」挂到「需求池」
    expect(nodes["主按钮"].parent).toBe(before["按钮"].parent);
    expect(nodes["按钮"]).toBeUndefined();
  });

  test("0 任务的节点也能上色,改名时颜色跟着走(#tag/ops 不再只认卡片)", async () => {
    await create(admin.token, { name: "上色前" });
    const c = await op(admin.token, { op: "color", tag: "上色前", color: "#ABCDEF" });
    expect(c.status).toBe(200);
    expect((await tagsOf(admin.token)).body.colors["上色前"]).toBe("#abcdef");
    const r = await op(admin.token, { op: "rename", from: "上色前", to: "上色后" });
    expect(r.status).toBe(200);
    const after = await tagsOf(admin.token);
    expect(after.body.colors["上色后"]).toBe("#abcdef");
    expect(after.body.colors["上色前"]).toBeUndefined();
  });
});

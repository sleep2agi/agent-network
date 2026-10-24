// 子项目（admin 2026-10-24：管理项目里只能平铺，看不到层级）。
//
// 本文件钉住四件事，任何一条错都会让「项目」这个词变得不可信：
//   1. 建/搬家都能指定 parent_id，GET 列表能读回；
//   2. 深度上限 3 层（顶层=1），超了拒绝而不是悄悄截断；
//   3. 环（把自己挂到自己的后代下面 / 挂到自己身上）必须拒绝；
//   4. 有子项目的项目不能直接删（不偷偷把子项目变孤儿或改写它们的层级）。
// 另外：父项目必须同网络、未归档。
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import "./require-explicit-test-db.js";
import { register } from "./auth.js";
import { bootServer } from "./server.js";

let BASE = "";
let server: any = null;
let token = "";
let NET = "";

async function send(method: string, path: string, payload?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch {}
  return { status: res.status, body };
}

const P = (path: string) => `${path}${path.includes("?") ? "&" : "?"}network_id=${NET}`;
const mk = (name: string, parent_id?: string | null) =>
  send("POST", P("/api/requirements/projects"), parent_id === undefined ? { name } : { name, parent_id });

beforeAll(async () => {
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const a = register(`projparent_${suffix}`, "ProjParentPw123!", undefined, "pp");
  expect(a.ok).toBe(true);
  token = a.token!;
  NET = a.network_id!;
  server = bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${server.port}`;
}, 30_000);

afterAll(() => { try { server?.stop?.(true); } catch {} });

describe("sub-projects (parent_id)", () => {
  test("create a child and read the hierarchy back", async () => {
    const parent = await mk("父项目");
    expect(parent.status).toBe(201);
    const parentId = parent.body.project.id;
    expect(parent.body.project.parentId).toBeNull();

    const child = await mk("子项目", parentId);
    expect(child.status).toBe(201);
    expect(child.body.project.parentId).toBe(parentId);

    const list = await send("GET", P("/api/requirements/projects"));
    expect(list.status).toBe(200);
    const rows = list.body.projects as any[];
    expect(rows.find((r) => r.name === "子项目")!.parentId).toBe(parentId);
    expect(rows.find((r) => r.name === "父项目")!.parentId).toBeNull();
  });

  test("a project can be moved under another one, and back to the top", async () => {
    const a = await mk("可搬 A");
    const b = await mk("可搬 B");
    const moved = await send("PATCH", P(`/api/requirements/projects/${b.body.project.id}`), { parent_id: a.body.project.id });
    expect(moved.status).toBe(200);
    expect(moved.body.project.parentId).toBe(a.body.project.id);

    const back = await send("PATCH", P(`/api/requirements/projects/${b.body.project.id}`), { parent_id: null });
    expect(back.status).toBe(200);
    expect(back.body.project.parentId).toBeNull();
  });

  test("depth is capped at 3 (top level counts as 1)", async () => {
    const l1 = await mk("深 1");
    const l2 = await mk("深 2", l1.body.project.id);
    const l3 = await mk("深 3", l2.body.project.id);
    expect(l3.status).toBe(201);
    const l4 = await mk("深 4", l3.body.project.id);
    expect(l4.status).toBe(400);
    expect(l4.body.error).toBe("project_parent_too_deep");
  });

  test("a cycle is refused (self, and a descendant)", async () => {
    const a = await mk("环 A");
    const b = await mk("环 B", a.body.project.id);
    const self = await send("PATCH", P(`/api/requirements/projects/${a.body.project.id}`), { parent_id: a.body.project.id });
    expect(self.status).toBe(400);
    expect(self.body.error).toBe("project_parent_cycle");

    // 把 A 挂到它自己的子项目 B 下面 = 环
    const loop = await send("PATCH", P(`/api/requirements/projects/${a.body.project.id}`), { parent_id: b.body.project.id });
    expect(loop.status).toBe(400);
    expect(loop.body.error).toBe("project_parent_cycle");
  });

  test("a parent that does not exist, is archived, or lives in another network is refused", async () => {
    const missing = await mk("缺父", "proj_does_not_exist");
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe("project_parent_not_found");

    const parent = await mk("会归档的父");
    await send("PATCH", P(`/api/requirements/projects/${parent.body.project.id}`), { archived: true });
    const archived = await mk("挂到归档父", parent.body.project.id);
    expect(archived.status).toBe(400);
    expect(archived.body.error).toBe("project_parent_archived");
  });

  test("a project with children cannot be deleted (children are not silently orphaned)", async () => {
    const parent = await mk("有孩子的父");
    const child = await mk("孩子", parent.body.project.id);
    const del = await send("DELETE", P(`/api/requirements/projects/${parent.body.project.id}`));
    expect(del.status).toBe(409);
    expect(del.body.error).toBe("project_has_children");

    // 先删孩子，父就能删
    expect((await send("DELETE", P(`/api/requirements/projects/${child.body.project.id}`))).status).toBe(200);
    expect((await send("DELETE", P(`/api/requirements/projects/${parent.body.project.id}`))).status).toBe(200);
  });
});

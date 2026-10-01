// GET /api/requirements/projects 的每行 viewer_can.edit(app 任务页审计 L13)—— HTTP 集成测试(真实 Bun.serve,私有端口,临时库)。
//
// 客户端据此只在新建 / 挪卡的项目下拉里列「能编辑」的项目。判据必须与真写卡时一致,所以这里对每个项目
// 都真建一张卡,断言「viewer_can.edit === 建卡成功」,而不是另抄一份规则来比。
//   admin —— Hub 管理员 + 网络 owner:未归档项目全 true,归档的 false(projectRef 拒归档)
//   alice —— scoped 成员:P1 只看 → false,P2 可改 → true(只列得到这两个)
//   carol —— task_access='all' 的成员:未归档全 true
//   vic   —— scoped viewer,P3 只看:false(viewer 本来就不能写卡)

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { register } from "./auth.js";
import { db } from "./db.js";

const DIR = mkdtempSync(join(tmpdir(), "anet-project-viewer-can-"));
let BASE = "";
let hub: any = null;
const PW = "ProjViewerCanPassw0rd!x";
let NET = "";
const U: Record<string, { token: string; id: string }> = {};
const P: Record<string, string> = {};

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
const projects = async (who: string) => {
  const r = await send(U[who].token, "GET", `/api/requirements/projects?network_id=${NET}`);
  expect(r.status).toBe(200);
  return Object.fromEntries((r.body.projects as any[]).map((p) => [p.name, p]));
};

beforeAll(async () => {
  process.env.COMMHUB_DB ||= join(DIR, "hub.db");
  process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
  process.env.HOST = "127.0.0.1";
  const a = register(`pvc_admin_${Date.now()}`, PW, undefined, "Admin");
  expect(a.ok).toBe(true);
  U.admin = { token: a.token!, id: a.user!.user_id };
  NET = a.network_id!;
  db.run("UPDATE users SET role = 'admin' WHERE user_id = ?1", [U.admin.id]);
  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;

  const mk = async (username: string, role: string) => {
    expect((await send(U.admin.token, "POST", "/api/admin/users", { username, password: PW, network_id: NET, role })).status).toBe(200);
    const login = await send("", "POST", "/api/auth/login", { username, password: PW });
    expect(login.status).toBe(200);
    return { token: login.body.token as string, id: login.body.user.user_id as string };
  };
  const stamp = Date.now();
  U.alice = await mk(`pvc_alice_${stamp}`, "member");
  U.carol = await mk(`pvc_carol_${stamp}`, "member");
  U.vic = await mk(`pvc_vic_${stamp}`, "viewer");
  db.run("UPDATE network_members SET task_access = 'all' WHERE network_id = ?1 AND user_id = ?2", [NET, U.carol.id]);

  for (const name of ["pvc-P1", "pvc-P2", "pvc-P3", "pvc-P4"]) {
    const r = await send(U.admin.token, "POST", "/api/requirements/projects", { network_id: NET, name });
    expect(r.status).toBe(201);
    P[name] = r.body.project.id;
  }
  expect((await send(U.admin.token, "PATCH", `/api/requirements/projects/${P["pvc-P4"]}?network_id=${NET}`, { archived: true })).status).toBe(200);
  expect((await send(U.admin.token, "PUT", `/api/networks/${NET}/members/${U.alice.id}/task-grants`, { task_access: "scoped", project_grants: [{ project_id: P["pvc-P1"] }, { project_id: P["pvc-P2"], can_edit: true }] })).status).toBe(200);
  expect((await send(U.admin.token, "PUT", `/api/networks/${NET}/members/${U.vic.id}/task-grants`, { task_access: "scoped", project_grants: [P["pvc-P3"]] })).status).toBe(200);
}, 30_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("GET /api/requirements/projects 的 viewer_can.edit", () => {
  test("每个调用者的取值", async () => {
    const edit = (rows: Record<string, any>) => Object.fromEntries(Object.entries(rows).map(([n, p]) => [n, p.viewer_can?.edit]));
    expect(edit(await projects("admin"))).toEqual({ "pvc-P1": true, "pvc-P2": true, "pvc-P3": true, "pvc-P4": false });
    expect(edit(await projects("carol"))).toEqual({ "pvc-P1": true, "pvc-P2": true, "pvc-P3": true, "pvc-P4": false });
    expect(edit(await projects("alice"))).toEqual({ "pvc-P1": false, "pvc-P2": true });
    expect(edit(await projects("vic"))).toEqual({ "pvc-P3": false });
  });

  test("只加字段:其余键与之前逐字相同", async () => {
    const row = (await projects("alice"))["pvc-P2"];
    expect(Object.keys(row).sort()).toEqual(["archived", "color", "createdAt", "id", "name", "sort", "viewer_can"]);
    expect(Object.keys(row.viewer_can)).toEqual(["edit"]);
  });

  test("与真写卡一致:edit === 往这个项目建卡成功", async () => {
    let checked = 0;
    for (const who of ["admin", "carol", "alice", "vic"]) {
      for (const [name, p] of Object.entries(await projects(who))) {
        const r = await send(U[who].token, "POST", "/api/requirements", { network_id: NET, name: `pvc-card-${who}-${name}`, project_id: p.id });
        expect({ who, name, created: r.status === 201 }).toEqual({ who, name, created: p.viewer_can.edit });
        checked++;
      }
    }
    expect(checked).toBe(11);
  });

  test("授权改成可编辑后立即反映", async () => {
    expect((await send(U.admin.token, "PUT", `/api/networks/${NET}/members/${U.alice.id}/task-grants`, { project_grants: [{ project_id: P["pvc-P1"], can_edit: true }, { project_id: P["pvc-P2"], can_edit: true }] })).status).toBe(200);
    expect((await projects("alice"))["pvc-P1"].viewer_can.edit).toBe(true);
  });
});

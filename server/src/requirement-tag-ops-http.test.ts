// 标签管理(POST /api/requirements/tags/ops + GET /api/requirements/tags 的 counts / colors / can_manage)
// —— HTTP 集成测试(真实 Bun.serve,私有端口,临时库)。
//
// 场景:Hub 管理员 admin 的网络 NET,另有一个不相干的网络 NET2(同名标签,不能被波及)。成员:
//   alice —— scoped 成员(RFC-038 §9),只授权项目 P1;
//   carol —— task_access='all' 的老成员;
//   vic   —— viewer。
// 正向:改名 / 合并 / 删除改写网络里每张带这个标签的卡(含归档的)、颜色跟着挪、写审计、updated_at 前移;
//       carol 与 owner 能管;GET 带用量与颜色。
// 反向:scoped / viewer / 节点令牌被挡且一张卡都不改;scoped 的 counts / colors 只含看得见的卡;
//       不存在的标签 404、坏参数 400;事务中途失败一张都不改;别的网络不受影响。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "anet-tag-ops-"));
let BASE = "";
let hub: any = null;
let db: any = null;
const PW = "TagOpsPassw0rd!x";
let NET = "";
let NET2 = "";
let admin = { token: "", id: "" };
let other = { token: "", id: "" };
let alice = { token: "", id: "" };
let carol = { token: "", id: "" };
let vic = { token: "", id: "" };
let nodeToken = "";
let P1 = "";
const C: Record<string, string> = {};

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
const op = (token: string, payload: unknown, net = NET) => send(token, "POST", `/api/requirements/tags/ops?network_id=${net}`, payload);
const tagsOf = (token: string, net = NET) => send(token, "GET", `/api/requirements/tags?network_id=${net}`);
const cardTags = (name: string): string[] => JSON.parse(db.get("SELECT tags_json FROM requirements WHERE requirement_id = ?1", C[name]).tags_json);
const snapshot = () => Object.fromEntries(Object.keys(C).map(name => [name, cardTags(name)]));

beforeAll(async () => {
  process.env.COMMHUB_DB ||= join(DIR, "hub.db");
  process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
  process.env.HOST = "127.0.0.1";
  ({ db } = await import("./db.js"));
  const { createNetworkTokenForNode, register } = await import("./auth.js");
  const stamp = Date.now();
  const a = register(`to_admin_${stamp}`, PW, undefined, "Admin");
  expect(a.ok).toBe(true);
  admin = { token: a.token!, id: a.user!.user_id };
  NET = a.network_id!;
  db.run("UPDATE users SET role = 'admin' WHERE user_id = ?1", [admin.id]);
  const b = register(`to_other_${stamp}`, PW, undefined, "Other");
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
  alice = await mk(`to_alice_${stamp}`, "member");
  carol = await mk(`to_carol_${stamp}`, "member");
  vic = await mk(`to_vic_${stamp}`, "viewer");
  db.run("UPDATE network_members SET task_access = 'scoped' WHERE network_id = ?1 AND user_id = ?2", [NET, alice.id]);
  db.run("UPDATE network_members SET task_access = 'all' WHERE network_id = ?1 AND user_id = ?2", [NET, carol.id]);

  const p = await send(admin.token, "POST", "/api/requirements/projects", { network_id: NET, name: "to-P1" });
  expect(p.status).toBe(201);
  P1 = p.body.project.id;
  const g = await send(admin.token, "PUT", `/api/networks/${NET}/members/${alice.id}/task-grants`, { project_grants: [{ project_id: P1, can_edit: true }] });
  expect(g.status).toBe(200);

  const card = async (name: string, tags: string[], extra: Record<string, unknown> = {}, token = admin.token, net = NET) => {
    const r = await send(token, "POST", "/api/requirements", { network_id: net, name, tags, ...extra });
    expect(r.status).toBe(201);
    C[name] = r.body.requirement.id;
  };
  await card("visible", ["UI", "交互", "bug"], { project_id: P1 });
  await card("hidden", ["UI", "secret"]);
  await card("archived", ["UI", "旧"], { archived: true });
  await card("both", ["交互", "TMWork", "UI"]);
  await card("plain", []);
  await card("net2", ["UI", "交互"], {}, other.token, NET2);
}, 30_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("GET /api/requirements/tags", () => {
  test("owner:tags 仍是排序后的字符串数组(旧 App 形状不变),多出 counts / colors / can_manage", async () => {
    const r = await tagsOf(admin.token);
    expect(r.status).toBe(200);
    expect(r.body.tags).toEqual(["TMWork", "UI", "bug", "secret", "交互", "旧"]);
    expect(r.body.counts).toEqual({ UI: 4, 交互: 2, bug: 1, secret: 1, 旧: 1, TMWork: 1 });
    expect(r.body.colors).toEqual({});
    expect(r.body.can_manage).toBe(true);
  });

  test("scoped 成员:counts 只数看得见的卡,不能管;viewer 与节点令牌也不能管;老成员能管", async () => {
    const a = await tagsOf(alice.token);
    expect(a.body.tags).toEqual(["UI", "bug", "交互"]);
    expect(a.body.counts).toEqual({ UI: 1, bug: 1, 交互: 1 });
    expect(a.body.can_manage).toBe(false);
    expect((await tagsOf(vic.token)).body.can_manage).toBe(false);
    expect((await send(nodeToken, "GET", "/api/requirements/tags")).body.can_manage).toBe(false);
    expect((await tagsOf(carol.token)).body.can_manage).toBe(true);
  });

  test("列表响应的 capabilities 带 tag_ops", async () => {
    const r = await send(admin.token, "GET", `/api/requirements?network_id=${NET}`);
    expect(r.body.capabilities).toContain("tag_ops");
  });
});

describe("被拒的调用一张卡都不改", () => {
  test("scoped 成员 403(连他看得见的那张也不改,不做半套改名)", async () => {
    const before = snapshot();
    for (const payload of [{ op: "rename", from: "UI", to: "界面" }, { op: "delete", tag: "bug" }, { op: "merge", from: ["UI", "交互"], to: "x" }, { op: "color", tag: "UI", color: "#123456" }]) {
      const r = await op(alice.token, payload);
      expect(r.status).toBe(403);
      expect(r.body.error).toBe("permission_denied");
    }
    expect(snapshot()).toEqual(before);
    expect(db.get("SELECT COUNT(*) AS n FROM network_tags WHERE network_id = ?1", NET).n).toBe(0);
  });

  test("viewer 403;节点令牌 403 user_token_required;别的网络的 owner 碰不到这个网络", async () => {
    const before = snapshot();
    expect((await op(vic.token, { op: "delete", tag: "UI" })).status).toBe(403);
    const n = await send(nodeToken, "POST", "/api/requirements/tags/ops", { op: "delete", tag: "UI" });
    expect(n.status).toBe(403);
    expect(n.body.error).toBe("user_token_required");
    expect((await op(other.token, { op: "delete", tag: "UI" })).status).toBe(403);
    expect(snapshot()).toEqual(before);
  });

  test("坏参数 400、不存在的标签 404、GET 到 ops 404", async () => {
    expect((await op(admin.token, { op: "explode" })).body.error).toBe("invalid_tag_op");
    expect((await op(admin.token, { op: "rename", from: "UI", to: "" })).body.error).toBe("invalid_tag");
    expect((await op(admin.token, { op: "rename", from: "UI", to: "x".repeat(21) })).body.error).toBe("invalid_tag");
    expect((await op(admin.token, { op: "rename", from: "UI", to: " UI " })).body.error).toBe("same_tag");
    expect((await op(admin.token, { op: "merge", from: [], to: "UI" })).body.error).toBe("invalid_tag");
    expect((await op(admin.token, { op: "merge", from: ["UI"], to: "UI" })).body.error).toBe("same_tag");
    expect((await op(admin.token, { op: "color", tag: "UI", color: "red" })).body.error).toBe("invalid_tag_color");
    const missing = await op(admin.token, { op: "delete", tag: "没有这个" });
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe("tag_not_found");
    expect((await send(admin.token, "GET", `/api/requirements/tags/ops?network_id=${NET}`)).status).toBe(404);
  });

  test("事务:改到一半失败 → 一张都不改,颜色也不挪", async () => {
    expect((await op(admin.token, { op: "color", tag: "UI", color: "#2563EB" })).status).toBe(200);
    // 让其中一张卡的 UPDATE 抛错(SQLite 用 RAISE,PostgreSQL 用 plpgsql 触发器;PG 阶梯会跑这个文件)。
    const pg = db.dialect === "postgres";
    if (pg) {
      db.exec(`CREATE OR REPLACE FUNCTION tag_ops_fail() RETURNS trigger AS $$ BEGIN IF NEW.requirement_id = '${C["both"]}' THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
      db.exec("CREATE TRIGGER tag_ops_fail BEFORE UPDATE OF tags_json ON requirements FOR EACH ROW EXECUTE FUNCTION tag_ops_fail()");
    } else {
      db.exec(`CREATE TRIGGER tag_ops_fail BEFORE UPDATE OF tags_json ON requirements WHEN NEW.requirement_id = '${C["both"]}' BEGIN SELECT RAISE(ABORT, 'boom'); END;`);
    }
    const before = snapshot();
    try {
      const r = await op(admin.token, { op: "rename", from: "UI", to: "界面" });
      expect(r.status).toBeGreaterThanOrEqual(500);
    } finally {
      db.exec(pg ? "DROP TRIGGER tag_ops_fail ON requirements" : "DROP TRIGGER tag_ops_fail");
      if (pg) db.exec("DROP FUNCTION tag_ops_fail()");
    }
    expect(snapshot()).toEqual(before);
    expect(db.get("SELECT color FROM network_tags WHERE network_id = ?1 AND name = 'UI'", NET).color).toBe("#2563eb");
  });
});

describe("改名 / 合并 / 删除 / 颜色", () => {
  test("颜色:设置(存小写)、GET 带出来;scoped 成员看不到他看不见的标签的颜色", async () => {
    expect((await op(admin.token, { op: "color", tag: "secret", color: "#DC2626" })).status).toBe(200);
    const r = await tagsOf(admin.token);
    expect(r.body.colors).toEqual({ UI: "#2563eb", secret: "#dc2626" });
    expect((await tagsOf(alice.token)).body.colors).toEqual({ UI: "#2563eb" });
    expect((await op(admin.token, { op: "color", tag: "secret", color: null })).status).toBe(200);
    expect((await tagsOf(admin.token)).body.colors).toEqual({ UI: "#2563eb" });
  });

  test("改名:每张卡(含看不见的、归档的)都改,位置不变;颜色跟着走;updated_at 前移;审计;别的网络不动", async () => {
    const t0 = new Date().toISOString();
    const r = await op(admin.token, { op: "rename", from: "UI", to: "界面" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, op: "rename", affected: 4 });
    expect(cardTags("visible")).toEqual(["界面", "交互", "bug"]);
    expect(cardTags("hidden")).toEqual(["界面", "secret"]);
    expect(cardTags("archived")).toEqual(["界面", "旧"]);
    expect(cardTags("both")).toEqual(["交互", "TMWork", "界面"]);
    expect(cardTags("net2")).toEqual(["UI", "交互"]);
    expect((await tagsOf(admin.token)).body.colors).toEqual({ 界面: "#2563eb" });
    const row = db.get("SELECT updated_at, updated_by_json FROM requirements WHERE requirement_id = ?1", C["hidden"]);
    expect(row.updated_at >= t0).toBe(true);
    expect(JSON.parse(row.updated_by_json)).toEqual({ kind: "user", id: admin.id });
    const audit = db.get("SELECT detail, target_id, network_id FROM audit_log WHERE action = 'requirement_tag_rename' ORDER BY id DESC LIMIT 1");
    expect(audit.target_id).toBe("界面");
    expect(audit.network_id).toBe(NET);
    expect(JSON.parse(audit.detail)).toEqual({ op: "rename", from: "UI", to: "界面", affected: 4 });
    // 这次改动 updated_since 同步得到(包括 GET 列表)。
    const since = await send(admin.token, "GET", `/api/requirements?network_id=${NET}&include_archived=1&updated_since=${encodeURIComponent(t0)}`);
    expect(since.body.requirements.map((x: any) => x.name).sort()).toEqual(["archived", "both", "hidden", "visible"]);
  });

  test("改名成已存在的标签 = 合并,同一张卡上不出现两次", async () => {
    const r = await op(carol.token, { op: "rename", from: "交互", to: "界面" });
    expect(r.body.affected).toBe(2);
    expect(cardTags("visible")).toEqual(["界面", "bug"]);
    expect(cardTags("both")).toEqual(["界面", "TMWork"]);
  });

  test("合并:多个来源进一个新标签;目标没颜色就继承来源的;来源颜色行删掉", async () => {
    expect((await op(admin.token, { op: "color", tag: "旧", color: "#16a34a" })).status).toBe(200);
    const r = await op(admin.token, { op: "merge", from: ["bug", "旧", "secret", "不存在"], to: "杂项" });
    expect(r.body).toEqual({ ok: true, op: "merge", affected: 3 });
    expect(cardTags("visible")).toEqual(["界面", "杂项"]);
    expect(cardTags("hidden")).toEqual(["界面", "杂项"]);
    expect(cardTags("archived")).toEqual(["界面", "杂项"]);
    expect((await tagsOf(admin.token)).body.colors).toEqual({ 界面: "#2563eb", 杂项: "#16a34a" });
    expect(db.get("SELECT COUNT(*) AS n FROM network_tags WHERE network_id = ?1 AND name = '旧'", NET).n).toBe(0);
  });

  test("合并进已有颜色的目标:目标颜色不变", async () => {
    const r = await op(admin.token, { op: "merge", from: ["杂项"], to: "界面" });
    expect(r.body.affected).toBe(3);
    expect((await tagsOf(admin.token)).body.colors).toEqual({ 界面: "#2563eb" });
  });

  test("删除:从每张卡上拿掉(卡保留),颜色行删掉,审计带 affected", async () => {
    const r = await op(admin.token, { op: "delete", tag: "界面" });
    expect(r.body).toEqual({ ok: true, op: "delete", affected: 4 });
    expect(cardTags("visible")).toEqual([]);
    expect(cardTags("both")).toEqual(["TMWork"]);
    expect(db.get("SELECT COUNT(*) AS n FROM requirements WHERE network_id = ?1", NET).n).toBe(5);
    expect(db.get("SELECT COUNT(*) AS n FROM network_tags WHERE network_id = ?1", NET).n).toBe(0);
    const audit = db.get("SELECT detail FROM audit_log WHERE action = 'requirement_tag_delete' ORDER BY id DESC LIMIT 1");
    expect(JSON.parse(audit.detail)).toEqual({ op: "delete", tag: "界面", affected: 4 });
    expect((await tagsOf(admin.token)).body.tags).toEqual(["TMWork"]);
    expect(cardTags("net2")).toEqual(["UI", "交互"]);
  });
});

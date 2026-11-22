// #5125 HTTP 级：三个身份各一条（admin / 部门负责人 / 普通成员），外加「未上报 = not_reported」
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "anet-wd-http-"));
process.env.COMMHUB_DB ||= join(DIR, "hub.db");
let hub: ReturnType<typeof Bun.serve>;
let base = "", net = "", ownerToken = "", headToken = "", memberToken = "";

const list = async (token: string) => {
  const r = await fetch(`${base}/api/nodes?network_id=${net}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, body: await r.json() as any };
};
const rowFor = (body: any, alias: string) => (body.nodes as any[]).find(n => n.alias === alias);

beforeAll(async () => {
  process.env.COMMHUB_AUTH_TOKEN ||= "legacy-master-token-for-test";
  const { db } = await import("./db.js");
  const { register, addNetworkMember } = await import("./auth.js");
  const stamp = Date.now();
  const owner = register(`wd_owner_${stamp}`, "Wd-Owner-1!");
  net = owner.network_id!; ownerToken = owner.token!;
  const head = register(`wd_head_${stamp}`, "Wd-Head-1!");
  const headId = db.get<{ user_id: string }>("SELECT user_id FROM users WHERE username = ?1", [`wd_head_${stamp}`])!.user_id;
  addNetworkMember(net, headId, "member");
  db.run("UPDATE network_members SET agent_access='all' WHERE network_id=?1 AND user_id=?2", [net, headId]);
  headToken = head.token!;
  const member = register(`wd_member_${stamp}`, "Wd-Member-1!");
  const memberId = db.get<{ user_id: string }>("SELECT user_id FROM users WHERE username = ?1", [`wd_member_${stamp}`])!.user_id;
  addNetworkMember(net, memberId, "member");
  db.run("UPDATE network_members SET agent_access='all' WHERE network_id=?1 AND user_id=?2", [net, memberId]);
  memberToken = member.token!;
  db.run("INSERT INTO network_departments (network_id, department_id, name, sort) VALUES (?1,'d-a','A',0)", [net]);
  db.run("INSERT INTO network_departments (network_id, department_id, name, sort) VALUES (?1,'d-b','B',1)", [net]);
  db.run("UPDATE network_departments SET leader_user_id=?1 WHERE network_id=?2 AND department_id='d-a'", [headId, net]);
  const now = Date.now();
  const snap = (w?: string) => JSON.stringify(w ? { role: "node", flags: { workdir: w } } : { role: "node" });
  db.run(`INSERT OR REPLACE INTO nodes (node_id,node_name,network_id,alias,department_id,config_snapshot,created_at,updated_at)
          VALUES ('n_wd_a','wd-a',?1,'wd-a','d-a',?2,?3,?3)`, [net, snap("/proj/a"), now]);
  db.run(`INSERT OR REPLACE INTO nodes (node_id,node_name,network_id,alias,department_id,config_snapshot,created_at,updated_at)
          VALUES ('n_wd_b','wd-b',?1,'wd-b','d-b',?2,?3,?3)`, [net, snap("/proj/b"), now]);
  db.run(`INSERT OR REPLACE INTO nodes (node_id,node_name,network_id,alias,department_id,config_snapshot,created_at,updated_at)
          VALUES ('n_wd_old','wd-old',?1,'wd-old','d-a',?2,?3,?3)`, [net, snap(), now]);
  const mod = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${hub.port}`;
}, 60_000);

afterAll(() => { try { hub?.stop(true); } catch {}; try { rmSync(DIR, { recursive: true, force: true }); } catch {} });

describe("#5125 /api/nodes 的 workdir / workdir_state", () => {
  test("owner：上报了就是 reported（带真实路径），没上报是 not_reported（不是 forbidden）", async () => {
    const { body } = await list(ownerToken);
    expect(rowFor(body, "wd-a")).toMatchObject({ workdir: "/proj/a", workdir_state: "reported" });
    expect(rowFor(body, "wd-old")).toMatchObject({ workdir: null, workdir_state: "not_reported" });
  });

  test("🔴 部门负责人：本部门 reported，别部门 forbidden 且不带路径", async () => {
    const { body } = await list(headToken);
    expect(rowFor(body, "wd-a")).toMatchObject({ workdir: "/proj/a", workdir_state: "reported" });
    expect(rowFor(body, "wd-b")).toMatchObject({ workdir: null, workdir_state: "forbidden" });
    expect(JSON.stringify(rowFor(body, "wd-b"))).not.toContain("/proj/b");
  });

  test("🔴 普通成员：一律 forbidden（不是 not_reported）", async () => {
    const { body } = await list(memberToken);
    for (const alias of ["wd-a", "wd-b", "wd-old"]) {
      expect(rowFor(body, alias)).toMatchObject({ workdir: null, workdir_state: "forbidden" });
    }
  });
});

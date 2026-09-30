// GET /api/requirements/people 的 display_name 字段 —— HTTP 集成测试(真实 Bun.serve,私有端口,临时库)。
// test2123 在真实 PostgreSQL 上原样再跑一遍(COMMHUB_TEST_PG_URL)。
//
// name 保持原样:成员 = display_name,没设回落到用户名;节点 = display_name → alias → node_name(旧 app 只读它)。
// display_name 另给一份,没设就是 "" —— 分享图等对外场景据此不把 admin 之类的账号名印出去。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "anet-req-people-"));
process.env.COMMHUB_DB ||= join(DIR, "hub.db");
process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
process.env.HOST = "127.0.0.1";
const PW = "ReqPeoplePassw0rd!x";

let BASE = "";
let hub: any = null;
let NET = "";
let owner = { token: "", id: "", username: "" };
let named = { id: "" };

async function people(token: string) {
  const res = await fetch(`${BASE}/api/requirements/people?network_id=${NET}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, body: await res.json() as any };
}

beforeAll(async () => {
  const { db } = await import("./db.js");
  const { addNetworkMember, register } = await import("./auth.js");
  const stamp = Date.now();
  const o = register(`rp_owner_${stamp}`, PW, undefined, "");
  expect(o.ok).toBe(true);
  owner = { token: o.token!, id: o.user!.user_id, username: o.user!.username };
  NET = o.network_id!;
  const m = register(`rp_member_${stamp}`, PW, undefined, "");
  expect(m.ok).toBe(true);
  named = { id: m.user!.user_id };
  addNetworkMember(NET, named.id, "member", owner.id, { taskAccess: "all" });
  // owner:没有显示名(= 只有用户名);member:有显示名。
  db.run("UPDATE users SET display_name = NULL WHERE user_id = ?1", [owner.id]);
  db.run("UPDATE users SET display_name = ?1 WHERE user_id = ?2", ["Placeholder Person", named.id]);
  db.run("INSERT INTO nodes(node_id,node_name,alias,display_name,network_id) VALUES (?1,?2,?3,?4,?5)", ["rp-node-alias", "rp-node-name", "placeholder-alias", "", NET]);
  db.run("INSERT INTO nodes(node_id,node_name,alias,display_name,network_id) VALUES (?1,?2,?3,?4,?5)", ["rp-node-named", "rp-node-name-2", "placeholder-alias-2", "Placeholder Agent", NET]);
  db.run("INSERT INTO nodes(node_id,node_name,network_id) VALUES (?1,?2,?3)", ["rp-node-bare", "rp-node-bare-name", NET]);
  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;
}, 30_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("GET /api/requirements/people display_name", () => {
  test("display_name is its own field, empty when unset; name keeps the username / alias fallback", async () => {
    const r = await people(owner.token);
    expect(r.status).toBe(200);
    const find = (kind: string, id: string) => r.body.people.find((p: any) => p.kind === kind && p.id === id);
    expect(find("user", owner.id)).toMatchObject({ name: owner.username, display_name: "", networkId: NET });
    expect(find("user", named.id)).toMatchObject({ name: "Placeholder Person", display_name: "Placeholder Person" });
    expect(find("node", "rp-node-alias")).toMatchObject({ name: "placeholder-alias", display_name: "" });
    expect(find("node", "rp-node-named")).toMatchObject({ name: "Placeholder Agent", display_name: "Placeholder Agent" });
    expect(find("node", "rp-node-bare")).toMatchObject({ name: "rp-node-bare-name", display_name: "" });
    expect(r.body.people.every((p: any) => typeof p.display_name === "string")).toBe(true);
  });

  test("the existing fields keep their shape for old apps", async () => {
    const r = await people(owner.token);
    for (const p of r.body.people) {
      expect(Object.keys(p).sort()).toEqual(["display_name", "id", "kind", "name", "networkId"]);
      expect(typeof p.name).toBe("string");
      expect(p.name.length).toBeGreaterThan(0);
    }
  });
});

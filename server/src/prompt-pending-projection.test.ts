// 「CLI 在等选项」的投影：没上报是 null，形状不对也是 null（不用空对象装）
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "anet-pp-"));
process.env.COMMHUB_DB ||= join(DIR, "hub.db");
let hub: ReturnType<typeof Bun.serve>;
let base = "", net = "", token = "";

beforeAll(async () => {
  process.env.COMMHUB_AUTH_TOKEN ||= "legacy-master-token-for-test";
  const { db } = await import("./db.js");
  const { register } = await import("./auth.js");
  const stamp = Date.now();
  const owner = register(`pp_owner_${stamp}`, "Pp-Owner-1!");
  net = owner.network_id!; token = owner.token!;
  const now = Date.now();
  const insert = (id: string, alias: string, snap: any) => db.run(
    `INSERT OR REPLACE INTO nodes (node_id,node_name,network_id,alias,config_snapshot,created_at,updated_at)
     VALUES (?1,?2,?3,?2,?4,?5,?5)`, [id, alias, net, JSON.stringify(snap), now]);
  insert("n_pp_1", "pp-waiting", { role: "node", interactive_prompt: { kind: "codex_update", excerpt: "Update available", detected_at: "2026-11-22T00:00:00Z" } });
  insert("n_pp_2", "pp-quiet", { role: "node" });
  insert("n_pp_3", "pp-broken", { role: "node", interactive_prompt: { kind: "codex_update" } }); // 缺 detected_at
  const mod = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${hub.port}`;
}, 60_000);

afterAll(() => { try { hub?.stop(true); } catch {}; try { rmSync(DIR, { recursive: true, force: true }); } catch {} });

describe("/api/nodes prompt_pending", () => {
  test("🔴 越权看不见：普通成员拿不到 prompt_pending（与 workdir 同权限）", async () => {
    const { db } = await import("./db.js");
    const { register, addNetworkMember } = await import("./auth.js");
    const stamp = Date.now();
    const member = register(`pp_member_${stamp}`, "Pp-Member-1!");
    const memberId = db.get<{ user_id: string }>("SELECT user_id FROM users WHERE username = ?1", [`pp_member_${stamp}`])!.user_id;
    addNetworkMember(net, memberId, "member");
    db.run("UPDATE network_members SET agent_access='all' WHERE network_id=?1 AND user_id=?2", [net, memberId]);
    const r = await fetch(`${base}/api/nodes?alias=pp-waiting`, { headers: { Authorization: `Bearer ${member.token!}` } });
    const body: any = await r.json();
    expect(body.nodes[0].prompt_pending).toBeNull();
  });

  test("上报了就投影；没上报/形状不全 ⇒ null", async () => {
    const r = await fetch(`${base}/api/nodes?network_id=${net}`, { headers: { Authorization: `Bearer ${token}` } });
    const body: any = await r.json();
    const byAlias = Object.fromEntries(body.nodes.map((n: any) => [n.alias, n.prompt_pending]));
    expect(byAlias["pp-waiting"]).toMatchObject({ kind: "codex_update", excerpt: "Update available" });
    expect(byAlias["pp-quiet"]).toBeNull();
    expect(byAlias["pp-broken"]).toBeNull();
  });
});

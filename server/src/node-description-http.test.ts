// admin 2026-11-15 —— 节点职责介绍要让「其他节点」也看得到。HTTP 集成(真实 Bun.serve,私有端口,临时库)。
//
// 钉住:
//   1. 网络 owner 经 PUT /api/nodes/:id/attrs 写 description(和 display_name 同一把 attrs_revision 锁);
//   2. 另一个节点用自己的节点令牌调 MCP get_all_status:目标那一行带 description(一行摘要,≤ 120 字);
//      没写的节点行里没有这个键(不给全网每行加一个 null);
//   3. MCP get_session_status:profile.description 是整段(含换行),另带 display_name / team / tags。
//
// 跑法:cd server && bun test src/node-description-http.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "anet-node-desc-"));
process.env.COMMHUB_DB ||= join(DIR, "hub.db");
process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
process.env.HOST = "127.0.0.1";
const stamp = Date.now();

let db: any;
let hub: any = null;
let BASE = "";
let NET = "";
let bossToken = "";
type Node = { alias: string; nodeId: string; token: string };
const nodes: Record<"reader" | "target" | "blank", Node> = {} as any;

async function tool(token: string, name: string, args: Record<string, unknown>) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const raw = await res.text();
  const data = raw.split("\n").filter((x) => x.startsWith("data:"));
  const payload = data.length ? JSON.parse(data.at(-1)!.slice(5).trim()) : JSON.parse(raw);
  return JSON.parse(payload.result.content[0].text);
}

beforeAll(async () => {
  ({ db } = await import("./db.js"));
  const { createNetworkTokenForNode, register } = await import("./auth.js");
  const boss = register(`desc_boss_${stamp}`, "NodeDesc123!x");
  expect(boss.ok).toBe(true);
  bossToken = boss.token!; NET = boss.network_id!;
  for (const key of ["reader", "target", "blank"] as const) {
    const alias = `desc-${key}-${stamp}`;
    const nodeId = `n_desc_${key}_${stamp}`;
    const minted = createNetworkTokenForNode(boss.user!.user_id, NET, alias, nodeId);
    expect(minted.ok).toBe(true);
    nodes[key] = { alias, nodeId, token: minted.token! };
    db.run(`INSERT OR IGNORE INTO nodes (node_id, node_name, alias, runtime, network_id) VALUES (?1, ?2, ?2, 'claude-agent-sdk', ?3)`, [nodeId, alias, NET]);
  }
  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;
  for (const n of Object.values(nodes)) {
    expect((await tool(n.token, "report_status", { resume_id: `sdk-${n.nodeId}`, alias: n.alias, status: "idle", node_id: n.nodeId, network_id: NET })).ok).toBe(true);
  }
}, 30_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

const DESC = `负责 App 发版：派发 release-desktop / ios-build，跑 finish-release 与 verify。${"细节".repeat(80)}\n\n找我：发版、签名、TestFlight。\n不做：Hub 改动。`;

describe("node description is visible to other nodes", () => {
  test("owner writes it through PUT /api/nodes/:id/attrs", async () => {
    const res = await fetch(`${BASE}/api/nodes/${encodeURIComponent(nodes.target.nodeId)}/attrs?network_id=${NET}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${bossToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ base_attrs_revision: 0, description: DESC, team: "发版" }),
    });
    const body = await res.json() as any;
    expect(res.status).toBe(200);
    expect(body.description).toBe(DESC);
  });

  test("get_all_status (another node's token): target row carries a one-line summary; unwritten nodes carry no key", async () => {
    const r = await tool(nodes.reader.token, "get_all_status", {});
    expect(r.ok).toBe(true);
    const target = r.sessions.find((s: any) => s.alias === nodes.target.alias);
    const blank = r.sessions.find((s: any) => s.alias === nodes.blank.alias);
    expect(target).toBeDefined();
    expect(typeof target.description).toBe("string");
    expect(target.description.startsWith("负责 App 发版")).toBe(true);
    expect([...target.description].length).toBeLessThanOrEqual(120);
    expect(target.description.endsWith("…")).toBe(true);
    expect(target.description).not.toContain("\n");
    expect(blank).toBeDefined();
    expect("description" in blank).toBe(false);
  });

  test("get_session_status: profile carries the full text plus team", async () => {
    const r = await tool(nodes.reader.token, "get_session_status", { alias: nodes.target.alias });
    expect(r.ok).toBe(true);
    expect(r.profile.description).toBe(DESC);
    expect(r.profile.team).toBe("发版");
    expect(Array.isArray(r.profile.tags)).toBe(true);
    const blank = await tool(nodes.reader.token, "get_session_status", { alias: nodes.blank.alias });
    expect(blank.profile.description).toBeNull();
  });
});

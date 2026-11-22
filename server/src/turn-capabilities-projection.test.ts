// #5332 回合控制能力位：schema 保留 + /api/nodes 投影（未上报 = null，不是 false）
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";

const DIR = mkdtempSync(join(tmpdir(), "anet-cap-"));
process.env.COMMHUB_DB ||= join(DIR, "hub.db");
let hub: ReturnType<typeof Bun.serve>;
let base = "", net = "", token = "";

function snapshotSchema(): any {
  let captured: any = null;
  const server = new McpServer({ name: "t", version: "0" });
  const orig = (server as any).tool.bind(server);
  (server as any).tool = (name: string, ...rest: any[]) => {
    if (name === "report_status") captured = (typeof rest[0] === "string" ? rest[1] : rest[0]).config_snapshot;
    return orig(name, ...rest);
  };
  registerTools(server as any);
  return captured;
}

beforeAll(async () => {
  process.env.COMMHUB_AUTH_TOKEN ||= "legacy-master-token-for-test";
  const { db } = await import("./db.js");
  const { register } = await import("./auth.js");
  const stamp = Date.now();
  const owner = register(`cap_owner_${stamp}`, "Cap-Owner-1!");
  net = owner.network_id!; token = owner.token!;
  const now = Date.now();
  const ins = (id: string, alias: string, snap: any) => db.run(
    `INSERT OR REPLACE INTO nodes (node_id,node_name,network_id,alias,config_snapshot,created_at,updated_at)
     VALUES (?1,?2,?3,?2,?4,?5,?5)`, [id, alias, net, JSON.stringify(snap), now]);
  ins("n_cap_1", "cap-yes", { role: "node", turn_interrupt_capable: true, turn_steer_capable: true });
  ins("n_cap_2", "cap-no", { role: "node", turn_interrupt_capable: false, turn_steer_capable: false });
  ins("n_cap_3", "cap-old", { role: "node" });
  const mod = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${hub.port}`;
}, 60_000);

afterAll(() => { try { hub?.stop(true); } catch {}; try { rmSync(DIR, { recursive: true, force: true }); } catch {} });

describe("#5332 turn capabilities", () => {
  test("schema 保留两个能力位", () => {
    const parsed = snapshotSchema().parse({ turn_interrupt_capable: true, turn_steer_capable: false });
    expect(parsed.turn_interrupt_capable).toBe(true);
    expect(parsed.turn_steer_capable).toBe(false);
  });

  test("/api/nodes：true/false 原样，老节点为 null（不等于 false）", async () => {
    const r = await fetch(`${base}/api/nodes?network_id=${net}`, { headers: { Authorization: `Bearer ${token}` } });
    const body: any = await r.json();
    const by = Object.fromEntries(body.nodes.map((n: any) => [n.alias, n]));
    expect(by["cap-yes"].turn_interrupt_capable).toBe(true);
    expect(by["cap-yes"].turn_steer_capable).toBe(true);
    expect(by["cap-no"].turn_interrupt_capable).toBe(false);
    expect(by["cap-old"].turn_interrupt_capable).toBeNull();
    expect(by["cap-old"].turn_steer_capable).toBeNull();
  });
});

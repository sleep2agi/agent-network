// #5321 第二步：agy_models / agy_login_state 的 schema 保留 + /api/nodes 投影
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";

const DIR = mkdtempSync(join(tmpdir(), "anet-agy-"));
process.env.COMMHUB_DB ||= join(DIR, "hub.db");
let hub: ReturnType<typeof Bun.serve>;
let base = "", net = "", token = "";

function snapshotSchema(): any {
  let captured: any = null;
  const server = new McpServer({ name: "t", version: "0" });
  const orig = (server as any).tool.bind(server);
  (server as any).tool = (name: string, ...rest: any[]) => {
    if (name === "report_status") {
      const shape = typeof rest[0] === "string" ? rest[1] : rest[0];
      captured = shape.config_snapshot;
    }
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
  const owner = register(`agy_owner_${stamp}`, "Agy-Owner-1!");
  net = owner.network_id!; token = owner.token!;
  const now = Date.now();
  const ins = (id: string, alias: string, runtime: string, snap: any) => db.run(
    `INSERT OR REPLACE INTO nodes (node_id,node_name,network_id,alias,runtime,config_snapshot,created_at,updated_at)
     VALUES (?1,?2,?3,?2,?4,?5,?6,?6)`, [id, alias, net, runtime, JSON.stringify(snap), now]);
  ins("n_agy_1", "agy-ok", "antigravity", { role: "node", model: "gemini-4-neon-high", agy_models: ["claude-opus-5-5-high", "gemini-4-neon-high"], agy_login_state: "logged_in", agy_hot_model_capable: true });
  ins("n_agy_2", "agy-needs-login", "antigravity", { role: "node", agy_login_state: "needs_login" });
  ins("n_agy_3", "oc-node", "opencode-cli", { role: "node", flags: { opencodeGeneration: "v2" } });
  const mod = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${hub.port}`;
}, 60_000);

afterAll(() => { try { hub?.stop(true); } catch {}; try { rmSync(DIR, { recursive: true, force: true }); } catch {} });

describe("#5321 agy 投影", () => {
  test("schema 保留 agy_models / agy_login_state / agy_hot_model_capable（不被 zod 丢键）", () => {
    const parsed = snapshotSchema().parse({ agy_models: ["a/b"], agy_login_state: "logged_in", agy_hot_model_capable: true });
    expect(parsed.agy_models).toEqual(["a/b"]);
    expect(parsed.agy_login_state).toBe("logged_in");
    expect(parsed.agy_hot_model_capable).toBe(true);
  });

  test("枚举外的值只丢该格（不拒整份心跳）", () => {
    const parsed = snapshotSchema().parse({ agy_login_state: "maybe", agy_hot_model_capable: "yes", model: "m" });
    expect(parsed.agy_login_state).toBeUndefined();
    expect(parsed.agy_hot_model_capable).toBeUndefined();
    expect(parsed.model).toBe("m");
  });

  test("/api/nodes 与 /api/nodes/:id/config 投影 + update_node_config 热切分流", async () => {
    const r = await fetch(`${base}/api/nodes?network_id=${net}`, { headers: { Authorization: `Bearer ${token}` } });
    const body: any = await r.json();
    const byAlias = Object.fromEntries(body.nodes.map((n: any) => [n.alias, n]));
    expect(byAlias["agy-ok"].agy_models).toEqual(["claude-opus-5-5-high", "gemini-4-neon-high"]);
    expect(byAlias["agy-ok"].agy_login_state).toBe("logged_in");
    expect(byAlias["agy-ok"].agy_hot_model_capable).toBe(true);
    expect(byAlias["agy-needs-login"].agy_models).toBeNull();
    expect(byAlias["agy-needs-login"].agy_login_state).toBe("needs_login");
    expect(byAlias["agy-needs-login"].agy_hot_model_capable).toBeNull();
    expect(byAlias["oc-node"].agy_models).toBeNull();
    expect(byAlias["oc-node"].agy_login_state).toBeNull();
    expect(byAlias["oc-node"].agy_hot_model_capable).toBeNull();

    const cfgHot = await (await fetch(`${base}/api/nodes/n_agy_1/config`, { headers: { Authorization: `Bearer ${token}` } })).json() as any;
    expect(cfgHot.agy_hot_model_capable).toBe(true);
    const cfgLegacy = await (await fetch(`${base}/api/nodes/n_agy_2/config`, { headers: { Authorization: `Bearer ${token}` } })).json() as any;
    expect(cfgLegacy.agy_hot_model_capable).toBeUndefined();

    const callUpdate = async (node_id: string, model: string) => {
      const res = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2025-03-26",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "update_node_config", arguments: { network_id: net, node_id, base_revision: 0, patch: { model } } } }),
      });
      const raw = await res.text();
      const line = raw.split("\n").filter(x => x.startsWith("data:")).at(-1);
      const envelope = line ? JSON.parse(line.slice(5)) : JSON.parse(raw);
      return JSON.parse(envelope.result.content[0].text);
    };
    expect((await callUpdate("n_agy_1", "claude-opus-5-5-high")).apply_mode).toBe("hot");
    expect((await callUpdate("n_agy_2", "claude-opus-5-5-high")).apply_mode).toBe("restart");
  });
});

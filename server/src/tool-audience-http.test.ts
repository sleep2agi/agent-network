// #478 —— tools/list 按调用者给(tool-audience.ts)。钉住:
//   1. 每个注册的工具都在 TOOL_AUDIENCE 里归了类(新工具忘了归类 → 红),表里也没有已经不存在的工具;
//   2. 兼容回放:对每种调用者(节点:正常 / 只读 / 受限 / enforce 开关;人:owner / member / viewer),把每个工具都真调一次 ——
//      今天调得通的(不是那几种「不看参数就拒」的错误),一定还在它的列表里(协议工具在 opt-in 的列表里);
//      列表里藏起来的,调用一定回那几种拒绝之一。tools/call 不受影响(只滤列表)。
//   3. 每种角色的 tools/list 字节数(打印 before / after),各有上限(#476 的总上限仍管「全部工具」)。
// 跑法:cd server && COMMHUB_DB=/tmp/x.db bun test src/tool-audience-http.test.ts(PG 在 tests/test2123-hub-postgres-ladder 里注册)
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { register, createNetworkTokenForNode } from "./auth.js";
import { db } from "./db.js";
import { TOOL_AUDIENCE } from "./tool-audience.js";

const DIR = mkdtempSync(join(tmpdir(), "anet-tool-audience-"));
let BASE = "";
let hub: any = null;
const PW = "ToolAudiencePassw0rd!x";
let NET = "";
const T: Record<string, string> = {};

/** 处理函数里「不看参数就拒」的错误码(用户令牌调节点工具 / 节点令牌调人的工具 / #487 的拒绝)。 */
const REFUSALS = new Set(["network_token_required", "node_token_required", "caller_not_a_daemon", "user_token_required", "node_token_cannot_browse_files", "node_token_cannot_read_logs", "node_permission_denied"]);

async function rpc(token: string, method: string, params: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${BASE}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const raw = await res.text();
  const line = raw.split("\n").filter(x => x.startsWith("data:")).at(-1);
  return { json: line ? JSON.parse(line.slice(5)) : JSON.parse(raw), bytes: 0 };
}
async function listTools(token: string, all = false): Promise<{ names: string[]; bytes: number; tools: any[] }> {
  const { json } = await rpc(token, "tools/list", {}, all ? { "X-Anet-Tools": "all" } : {});
  const tools = json.result.tools as any[];
  return { names: tools.map(t => t.name), bytes: Buffer.byteLength(JSON.stringify({ tools }), "utf8"), tools };
}

// 参数:按 inputSchema 生成;名字认得的用真值;schema 有格式要求的给合法值(不给 → -32602,测试会让你补)。
const OVERRIDES: Record<string, Record<string, unknown>> = {
  get_skill: { skill_id: "skill_probe" },
  review_skill: { skill_id: "skill_probe" },
  mark_tasks_runtime_submitted: { task_ids: ["task_probe"] },
  mark_tasks_consumed: { task_ids: ["task_probe"] },
  upsert_network_secret: { key: "PROBE_KEY" },
  update_provider: { provider_id: "prov_probe" },
  schedule_batch_interval: { schedule_ids: ["sched_probe"], every_seconds: 60 },
};
function fill(schema: any, key: string, ctx: Record<string, unknown>): unknown {
  if (!schema) return "probe";
  if (ctx[key] !== undefined) return ctx[key];
  if (schema.enum) return schema.enum[0];
  if (schema.anyOf) return fill(schema.anyOf.find((s: any) => s.type !== "null") ?? schema.anyOf[0], key, ctx);
  const t = Array.isArray(schema.type) ? schema.type.find((x: string) => x !== "null") : schema.type;
  if (t === "string") return schema.minLength && schema.minLength > 5 ? "p".repeat(schema.minLength) : "probe";
  if (t === "integer" || t === "number") return schema.minimum ?? 1;
  if (t === "boolean") return false;
  if (t === "array") return [];
  if (t === "object") { const o: Record<string, unknown> = {}; for (const k of schema.required ?? []) o[k] = fill(schema.properties?.[k], k, ctx); return o; }
  return "probe";
}
let ALL_TOOLS: any[] = [];
const argsFor = (tool: any) => ({ ...(fill(tool.inputSchema, "", { network_id: NET, alias: "probe-victim", new_alias: "probe-victim", node_id: "node_ta_victim" }) as object), ...(OVERRIDES[tool.name] ?? {}) });
async function callOutcome(token: string, tool: any): Promise<{ refused: boolean; schema: boolean; code: string }> {
  const { json } = await rpc(token, "tools/call", { name: tool.name, arguments: argsFor(tool) });
  if (json.error) return { refused: false, schema: json.error.code === -32602, code: `rpc:${json.error.code}` };
  const text = String(json.result?.content?.[0]?.text ?? "");
  if (/^MCP error -32602/.test(text)) return { refused: false, schema: true, code: "schema" };
  let body: any = null;
  try { body = JSON.parse(text); } catch {}
  const code = body && body.ok === false ? String(body.error) : "ok";
  // 受限成员的闸(agent_access_restricted)跑在处理函数前面,看传的 network_id;对节点 / 协议工具,处理函数后面还有一道
  // 不看参数的 network_token_required(用户令牌换哪个网络都过不去),所以这时它也算拒。对「两边都能用」的工具不算。
  const masked = code === "agent_access_restricted" && (TOOL_AUDIENCE[tool.name] === "node" || TOOL_AUDIENCE[tool.name] === "protocol");
  return { refused: REFUSALS.has(code) || masked, schema: false, code };
}

beforeAll(async () => {
  process.env.COMMHUB_DB ||= join(DIR, "hub.db");
  process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
  process.env.HOST = "127.0.0.1";
  delete process.env.COMMHUB_NODE_PERMISSIONS;
  const owner = register(`ta_owner_${Date.now()}`, PW, undefined, "Owner");
  NET = owner.network_id!;
  T.owner = owner.token!;
  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;
  const mk = async (k: string, role: string) => {
    const username = `ta_${k}_${Date.now()}`;
    await fetch(`${BASE}/api/admin/users`, { method: "POST", headers: { Authorization: `Bearer ${T.owner}`, "Content-Type": "application/json" }, body: JSON.stringify({ username, password: PW, network_id: NET, role }) });
    T[k] = (await (await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password: PW }) })).json()).token;
  };
  await mk("member", "member");
  await mk("viewer", "viewer");
  for (const mode of ["normal", "readonly", "restricted"]) {
    T[`node_${mode}`] = createNetworkTokenForNode(owner.user!.user_id, NET, `ta-${mode}`, `node_ta_${mode}`).token!;
    db.run("UPDATE nodes SET permission_mode = ?1 WHERE node_id = ?2", [mode, `node_ta_${mode}`]);
  }
  createNetworkTokenForNode(owner.user!.user_id, NET, "probe-victim", "node_ta_victim");
  // 没有身份的调用者 = 不过滤:用 owner 的「全部」作为全集(owner 是用户令牌,协议工具对它不列;全集取并集)。
  const a = await listTools(T.node_normal, true);
  const b = await listTools(T.owner);
  const byName = new Map([...a.tools, ...b.tools].map(t => [t.name, t]));
  ALL_TOOLS = [...byName.values()];
}, 60_000);

afterAll(() => {
  delete process.env.COMMHUB_NODE_PERMISSIONS;
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("every tool is classified", () => {
  test("registry == TOOL_AUDIENCE (no unclassified tool, no stale entry)", async () => {
    const registered = ALL_TOOLS.map(t => t.name).sort();
    expect(registered.length).toBeGreaterThan(70);
    expect(registered.filter(n => !TOOL_AUDIENCE[n])).toEqual([]);
    expect(Object.keys(TOOL_AUDIENCE).filter(n => !registered.includes(n))).toEqual([]);
  });
});

describe("compat replay: nothing callable today disappears from the list", () => {
  const cases: Array<[string, string, string | null]> = [
    ["node (normal, log)", "node_normal", null], ["node (readonly)", "node_readonly", null], ["node (restricted)", "node_restricted", null],
    ["node (normal, enforce)", "node_normal", "enforce"], ["owner", "owner", null], ["member", "member", null], ["viewer", "viewer", null],
  ];
  for (const [label, key, flag] of cases) {
    test(label, async () => {
      if (flag) process.env.COMMHUB_NODE_PERMISSIONS = flag; else delete process.env.COMMHUB_NODE_PERMISSIONS;
      try {
        const isNode = key.startsWith("node_");
        const listed = new Set((await listTools(T[key], isNode)).names);
        // 「调得通 ⇒ 列着」,等价于「藏起来的 ⇒ 一定是那几种拒绝」。
        const lost: string[] = [], schema: string[] = [];
        for (const tool of ALL_TOOLS) {
          const out = await callOutcome(T[key], tool);
          if (out.schema) schema.push(tool.name);
          if (!out.refused && !listed.has(tool.name)) lost.push(`${tool.name}(${out.code})`);
        }
        expect(schema).toEqual([]); // 每个工具都真跑到了处理函数(否则判不出能不能用)
        expect(lost).toEqual([]);
      } finally { delete process.env.COMMHUB_NODE_PERMISSIONS; }
    }, 120_000);
  }
});

describe("what each caller sees", () => {
  test("node: no human-only tools; protocol tools only with X-Anet-Tools: all; user: no node / protocol tools", async () => {
    const node = new Set((await listTools(T.node_normal)).names);
    const nodeAll = new Set((await listTools(T.node_normal, true)).names);
    const user = new Set((await listTools(T.owner)).names);
    for (const [name, a] of Object.entries(TOOL_AUDIENCE)) {
      expect([name, node.has(name)]).toEqual([name, a === "both" || a === "node"]);
      expect([name, nodeAll.has(name)]).toEqual([name, a !== "user"]);
      expect([name, user.has(name)]).toEqual([name, a === "both" || a === "user"]);
    }
    // ?tools=all is the same switch for clients that cannot set headers
    const viaQuery = await fetch(`${BASE}/mcp?tools=all`, { method: "POST", headers: { Authorization: `Bearer ${T.node_normal}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
    const raw = await viaQuery.text();
    const parsed = JSON.parse(raw.split("\n").filter(x => x.startsWith("data:")).at(-1)!.slice(5));
    expect(parsed.result.tools.length).toBe(nodeAll.size);
  });

  test("node modes: readonly / restricted drop broadcast + node writes + human-only; enforce drops human-only for normal nodes", async () => {
    const ro = new Set((await listTools(T.node_readonly)).names);
    for (const n of ["broadcast", "update_node_config", "create_node", "upsert_provider"]) expect([n, ro.has(n)]).toEqual([n, false]);
    for (const n of ["send_task", "requirements_update", "report_status", "get_all_status"]) expect([n, ro.has(n)]).toEqual([n, true]); // 看参数才拒的照列
    expect(new Set((await listTools(T.node_normal)).names).has("upsert_provider")).toBe(true); // log 模式:调得通,照列
    process.env.COMMHUB_NODE_PERMISSIONS = "enforce";
    try { expect(new Set((await listTools(T.node_normal)).names).has("upsert_provider")).toBe(false); } finally { delete process.env.COMMHUB_NODE_PERMISSIONS; }
  });

  test("a hidden tool still answers tools/call exactly as before (only the list changes)", async () => {
    const p = await rpc(T.node_normal, "tools/call", { name: "projects_create", arguments: { network_id: NET, name: "示例项目" } });
    expect(JSON.parse(p.json.result.content[0].text).error).toBe("user_token_required");
    const r = await rpc(T.owner, "tools/call", { name: "report_status", arguments: argsFor(ALL_TOOLS.find(t => t.name === "report_status")) });
    expect(JSON.parse(r.json.result.content[0].text).error).toBe("network_token_required");
    const g = await rpc(T.node_normal, "tools/call", { name: "get_config_update", arguments: {} });
    expect(JSON.parse(g.json.result.content[0].text).ok).toBe(true); // 协议工具默认不列,但照常能调
  });
});

describe("bytes per role (#476 ceilings stay meaningful per role)", () => {
  // 全部工具(= 改动前每个调用者拿到的)71–72 KB;改动后按角色。改数字时在 PR 里写为什么。
  // 量出来(#478 合入时):全部 74 个工具 71,559 B;节点 52 个 57,632 B(−19%);人 56 个 54,780 B(−23%)。留 ~1.5 KB 余量。
  // Board #625 adds 2 human tools + 2 hidden daemon protocol tools. Measured:
  // all 78 / 73,969 B; user 58 / 56,615 B; node remains 52 / 58,320 B.
  // Board #733 adds 7 node-only schedule_* tools (user list unchanged). Measured before → after on the same run:
  // node 52 / 58,836 B → 59 / 61,607 B (+2,771 B, ~396 B per tool of which ~180 B is SDK per-tool overhead —
  // $schema + execution — after trimming schemas to bare field names; values are validated server-side);
  // all 78 / 74,485 B → 85 / 77,256 B; user 58 / 56,834 B → 58 / 56,834 B. main had 164 B node headroom left,
  // so any new node tool needs this; ceilings keep the same ~400–750 B margin.
  // Review follow-up: descriptions / schemas cut further → node 59 / 61,100 B, all 85 / 76,749 B (−507 B each),
  // leaving ≥ 700 B node margin even with #2488 (+116 B) merged.
  // Board #822 adds confirmed fork fields, not tools. Same-image main 102dd0f2 → candidate:
  // all 87 / 77,646 B → 78,976 B (+1,330); node 61 / 61,986 B → 62,368 B (+382);
  // user 58 / 56,950 B → 57,163 B (+213). start_node adds 213 B, report_status 169 B;
  // hidden pull/ack schemas account for the remaining 948 B. Keep strict receipt validation
  // and unchanged audiences; budget only this measured addition (~130/520 B node/all margin).
  const CEILINGS = { node: 62_500, user: 57_500, all: 79_500 } as const;
  test("node / user / all", async () => {
    const node = await listTools(T.node_normal);
    const user = await listTools(T.owner);
    const all = { bytes: Buffer.byteLength(JSON.stringify({ tools: ALL_TOOLS }), "utf8"), names: ALL_TOOLS.map(t => t.name) };
    console.log(`tools/list bytes — all ${all.names.length} tools ${all.bytes} B; node ${node.names.length} tools ${node.bytes} B (−${Math.round(100 - node.bytes / all.bytes * 100)}%); user ${user.names.length} tools ${user.bytes} B (−${Math.round(100 - user.bytes / all.bytes * 100)}%)`);
    expect(node.bytes).toBeLessThanOrEqual(CEILINGS.node);
    expect(user.bytes).toBeLessThanOrEqual(CEILINGS.user);
    expect(all.bytes).toBeLessThanOrEqual(CEILINGS.all);
  });
});

// #3275 —— provider 三件工具的形状：upsert_provider / probe_provider_model / get_probe_results。
//
// 为什么单独一个文件：这三件是**唯一三个在 server/src/*.test.ts 里没有任何调用点**的 MCP 工具
// （覆盖率报告里长期挂在 uncovered）。它们都要「先有 provider + model + daemon」才有东西可返回，
// 借用别人的夹具会把两个结论绑在一起 —— 所以自建最小种子。
//
// 判据：形状一律来自**真实调用**；跑不通的分支不写断言，而不是按名字猜一个（今天已经三次栽在这上面）。
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "./db.js";
import { registerTools } from "./tools.js";
import { stopBackgroundProbeTimersForTest } from "./probe.js";

// 金库根密钥必须存在，否则 upsert_network_secret 直接失败（实测：第一次跑就是栽在这里）。
// 用固定测试值，且只在本进程内 —— 与 daemon-provider-snapshots.test.ts 同一做法。
process.env.ANET_HUB_SECRET_VAULT_KEY ||= "42".repeat(32);

const USER = "u_probe_shape";
const NET = "net_probe_shape";
const PROVIDER = "prov_shape";
const DAEMON = "node_probe_daemon";
const SECRET_KEY = "PROBE_SHAPE_KEY";

type ToolHandler = (args: any) => Promise<any>;
const REPLY = (body: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(body) }] });

function handlers(): Record<string, ToolHandler> {
  const server = new McpServer({ name: "test", version: "0" }) as any;
  const tools: Record<string, ToolHandler> = {};
  const orig = server.tool.bind(server);
  server.tool = (name: string, desc: string, schema: any, handler: ToolHandler) => {
    tools[name] = handler;
    return orig(name, desc, schema, handler);
  };
  registerTools(server, undefined, NET, USER, null, false, null);
  return tools;
}

async function call(handler: ToolHandler, args: any): Promise<any> {
  const r = await handler(args);
  return JSON.parse(r.content[0].text);
}

function seed(opts: { withProvider?: boolean } = {}) {
  db.run(`INSERT INTO users (user_id, username, password_hash, role, created_at)
          VALUES (?1, ?1, 'x', 'user', datetime('now'))`, [USER]);
  db.run(`INSERT INTO networks (network_id, network_name, owner_id, created_at)
          VALUES (?1, ?1, ?2, datetime('now'))`, [NET, USER]);
  // 角色必须是 **owner**：`upsert_network_secret` 的拒绝体实测是
  //   { ok:false, error:"secret_owner_only", required_role:"owner", caller_role:"admin" }
  // ⇒ admin 不够。这条也是真实调用给出的，不是从权限表读来的。
  db.run(`INSERT INTO network_members (user_id, network_id, role, joined_at)
          VALUES (?1, ?2, 'owner', datetime('now'))`, [USER, NET]);
  db.run(`INSERT INTO nodes (node_id, node_name, alias, network_id, runtime, model, channels, config_snapshot,
                             hostname, created_at, updated_at, lifecycle_state)
          VALUES (?1, 'probe-daemon', 'probe-daemon', ?2, 'claude-agent-sdk', 'm', '[]', '{}', 'host-p',
                  datetime('now'), datetime('now'), 'active')`, [DAEMON, NET]);
  if (opts.withProvider !== false) {
    db.run(`INSERT INTO providers (provider_id, network_id, name, vendor, base_url, secret_key_ref, created_at, created_by, enabled)
            VALUES (?1, ?2, 'shape-provider', 'anthropic', 'https://api.anthropic.com', ?3, ?4, ?5, 1)`,
      [PROVIDER, NET, SECRET_KEY, Date.now(), USER]);
    db.run(`INSERT INTO provider_models (model_id, provider_id, model_name, display_name, created_at)
            VALUES ('pm_shape', ?1, 'shape-model', 'Shape Model', ?2)`, [PROVIDER, Date.now()]);
  }
}

function cleanup() {
  for (const t of ["provider_models", "providers", "network_members", "nodes", "networks", "users"]) {
    if (t === "provider_models") db.run("DELETE FROM provider_models WHERE provider_id = ?1", [PROVIDER]);
    else if (t === "providers") db.run("DELETE FROM providers WHERE network_id = ?1", [NET]);
    else if (t === "network_members") db.run("DELETE FROM network_members WHERE network_id = ?1", [NET]);
    else if (t === "nodes") db.run("DELETE FROM nodes WHERE network_id = ?1", [NET]);
    else if (t === "networks") db.run("DELETE FROM networks WHERE network_id = ?1", [NET]);
    else db.run("DELETE FROM users WHERE user_id = ?1", [USER]);
  }
}

beforeEach(() => { cleanup(); });
afterAll(() => { stopBackgroundProbeTimersForTest(); cleanup(); });

describe("provider 三件工具的形状", () => {
  test("upsert_provider 成功体的键集（真实调用给出）", async () => {
    seed({ withProvider: false });
    const tools = handlers();
    // provider 的 secret 必须先在金库里 —— 这是工具自己的前置（实测第一次跑就撞上
    // `secret_not_in_vault`，提示原话是「upsert_network_secret first」）。
    // #3309 否定维度 —— 唯一哨兵值：它出现一次以上就说明有回显。
    // 用随机后缀而不是字面量：字面量可能恰好在别处存在，会让「没回声」的断言因别的原因成立。
    const SENTINEL = `SK-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    const secret = await call(tools.upsert_network_secret, { network_id: NET, key: SECRET_KEY, value: SENTINEL });
    // #3275 批次 4 —— 写密钥的成功体**只回标识**（不回声任何值）：
    // 这条属性比键集本身更重要 —— 回读才回内容，写入路径永远不带值。
    // 实测（首次写入）：["key","ok"] —— 我按族推断多写了一个 `overwrote`，当场红。
    // ⇒ 覆盖写入那条分支可能多一个字段，但**本夹具没走到，所以不声称**。
    expect(Object.keys(secret).sort()).toEqual(["key", "ok"]);
    expect(JSON.stringify(secret)).not.toContain(SENTINEL);
    expect(secret.ok).toBe(true);
    const up = await call(tools.upsert_provider, {
      name: "shape-provider", vendor: "anthropic", base_url: "https://api.anthropic.com",
      secret_key_ref: SECRET_KEY, network_id: NET,
      models: [{ model_name: "shape-model", display_name: "Shape Model" }],
    });
    // 形状来自真实调用 —— 而且**纠了我一次**：我先把成功体写成 { ok, provider:{…}, models:[…] }，
    // 实际是三键 { ok, provider_id, model_ids }（不回声任何配置内容）。
    // 这个形状是对的：写入路径回**标识**，回读才回内容 —— 两件事分开，密钥那条线才不会被顺手带出来。
    expect(Object.keys(up).sort()).toEqual(["model_ids", "ok", "provider_id"]);
    expect(up.provider_id).toMatch(/^prov_/);
    // #3309 否定维度 —— provider 的写回执同样不得携带密钥值（它只该带 secret_key_ref 这个名字）。
    expect(JSON.stringify(up)).not.toContain(SENTINEL);
    expect(Array.isArray(up.model_ids)).toBe(true);
    expect(up.model_ids).toHaveLength(1);

    // #3309 分支：upsert 的「no_changes」出口用同参再调一次**到不了** —— 实测返回
    // {"ok":false,"error":…,"name":…}（重名优先于「无变化」）。要到达它需要一次以 provider_id
    // 定位的更新，而本夹具没有那条路径 ⇒ **这里不声称覆盖**，登记在卡上。
    expect(up.model_ids[0]).toMatch(/^pm_/);
  });

  test("probe_provider_model 缺 model 时的拒绝体（{ok,error,...}）", async () => {
    seed();
    const tools = handlers();
    const r = await call(tools.probe_provider_model, {
      provider_id: PROVIDER, model_name: "no-such-model", daemon_node_id: DAEMON, network_id: NET,
    });
    expect(Object.keys(r).sort()).toEqual(["error", "model_name", "ok"]);
    expect(r).toMatchObject({ ok: false, error: "model_not_found" });
  });

  test("probe_provider_model 缺 daemon 时的拒绝体", async () => {
    seed();
    const tools = handlers();
    const r = await call(tools.probe_provider_model, {
      provider_id: PROVIDER, model_name: "shape-model", daemon_node_id: "node_nope", network_id: NET,
    });
    expect(Object.keys(r).sort()).toEqual(["error", "ok"]);
    expect(r).toMatchObject({ ok: false, error: "daemon_not_found" });
  });

  test("probe_provider_model 派发成功体的键集（真实调用给出）", async () => {
    seed();
    const tools = handlers();
    const vault = await call(tools.upsert_network_secret, { network_id: NET, key: SECRET_KEY, value: "TEST-ONLY-probe-shape" });
    expect(vault.ok).toBe(true);
    const r = await call(tools.probe_provider_model, {
      provider_id: PROVIDER, model_name: "shape-model", daemon_node_id: DAEMON, network_id: NET,
    });
    // 成功体是**派发凭据**，不是结果 —— 结果要去 get_probe_results 取。
    // 两键：{ ok, probe_id }。与「一次调用直接返回结果」的设计相比，这个形状把
    // 「下发」与「收结果」分成两次读，probe_id 是它们之间唯一的锚。
    expect(Object.keys(r).sort()).toEqual(["ok", "probe_id"]);
    expect(r.ok).toBe(true);
    expect(r.probe_id).toMatch(/^pr_/);
  });

  test("get_probe_results 空历史的键集（真实调用给出）", async () => {
    seed();
    const tools = handlers();
    const r = await call(tools.get_probe_results, { provider_id: PROVIDER, network_id: NET });
    // 两键：{ ok, results }。results 是**数组**（空历史给空数组，不是 null）——
    // 「没有历史」与「查不到」在这一层同形，所以判据是「ok 为真且 results 是数组」。
    expect(Object.keys(r).sort()).toEqual(["ok", "results"]);
    expect(r.ok).toBe(true);
    expect(Array.isArray(r.results)).toBe(true);
  });
});

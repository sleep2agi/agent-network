// #3309 第四条口径 —— `probe_provider_model` 的 4 个 error 字面量此前在测试里**一次都没出现过**：
//
//   insufficient_role_for_probe / provider_not_found / provider_disabled / secret_not_in_vault
//
// 现有的 provider-tools-shape.test.ts 覆盖的是**成功路径**（provider 存在、model 存在、
// daemon 存在、vault 里有 key）—— 于是这四条拒绝分支从来没被走过。
//
// 这里逐个真的触发一次，并断言 `error` 的**确切值**。特别钉住相邻两条不能混：
//
//   provider 不存在        ⇒ provider_not_found
//   provider 存在但停用    ⇒ provider_disabled
//
// 只断言 ok===false 时两者同形，而处置相反（前者要建，后者只要启用）。
// 代码注释里也写了这条意图（"Distinguish not found from disabled so the dashboard
// can render the right error"）—— 注释没有读数，断言才有。
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "./db.js";
import { registerTools } from "./tools.js";
import { stopBackgroundProbeTimersForTest } from "./probe.js";

// vault 根密钥存在时 vaultGet 才会「查而不得」（返回 null），否则它自己抛错走另一个分支。
process.env.ANET_HUB_SECRET_VAULT_KEY ||= "43".repeat(32);

const NET = "net_probe_err";
const ADMIN = "u_probe_err_admin";
const MEMBER = "u_probe_err_member";
const PROVIDER = "prov_err";
const DAEMON = "node_probe_err_daemon";

type ToolHandler = (args: any) => Promise<any>;

function handlers(userId: string): Record<string, ToolHandler> {
  const server = new McpServer({ name: "t", version: "0" }) as any;
  const tools: Record<string, ToolHandler> = {};
  const orig = server.tool.bind(server);
  server.tool = (name: string, desc: string, schema: any, handler: ToolHandler) => {
    tools[name] = handler;
    return orig(name, desc, schema, handler);
  };
  registerTools(server, undefined, NET, userId, null, false, null);
  return tools;
}

async function callProbe(userId: string, args: Record<string, unknown>) {
  const r = await handlers(userId).probe_provider_model(args);
  return JSON.parse(r.content[0].text);
}

const base = { provider_id: PROVIDER, model_name: "probe-model", daemon_node_id: DAEMON };

// 2026-11-01 —— **精确键集，写成集合相等**（不是计数、也不是「有这几个字段」）。
// 计数可以被换名满足；字段级断言放过多给的键。两者都放过「换名 + 少给」这种最常见的结构变动。
// 🔴 basis: impl —— 下面这些键集**取自真实调用的响应**，因此它是**变更探测器**，不是契约读数。
//   红的意思是「实现变了，去看是不是故意的」；而「实现错了」这一类它测不出来
//   （若实现多返回一个字段，断言会红，但那可能是正确的修复）。
//   要不要升级成 spec 列：需要一处**独立于实现**的书面来源；指不出来时，它就只能留在这里。
function expectKeys(obj: Record<string, unknown>, want: string[]) {
  expect(Object.keys(obj).sort(), "键集合必须完全等于期望").toEqual([...want].sort());
}

function cleanup() {
  db.run("DELETE FROM provider_models WHERE provider_id = ?1", [PROVIDER]);
  db.run("DELETE FROM providers WHERE network_id = ?1", [NET]);
  db.run("DELETE FROM network_members WHERE network_id = ?1", [NET]);
  db.run("DELETE FROM nodes WHERE network_id = ?1", [NET]);
  db.run("DELETE FROM networks WHERE network_id = ?1", [NET]);
  db.run("DELETE FROM users WHERE user_id IN (?1, ?2)", [ADMIN, MEMBER]);
}

function seed(opts: { enabled: number; secretKey: string }) {
  cleanup();
  db.run("INSERT INTO users (user_id, username, password_hash, role, created_at) VALUES (?1, ?1, 'x', 'user', datetime('now'))", [ADMIN]);
  db.run("INSERT INTO users (user_id, username, password_hash, role, created_at) VALUES (?1, ?1, 'x', 'user', datetime('now'))", [MEMBER]);
  db.run("INSERT INTO networks (network_id, network_name, owner_id, created_at) VALUES (?1, ?1, ?2, datetime('now'))", [NET, ADMIN]);
  db.run("INSERT INTO network_members (user_id, network_id, role, joined_at) VALUES (?1, ?2, 'owner', datetime('now'))", [ADMIN, NET]);
  db.run("INSERT INTO network_members (user_id, network_id, role, joined_at) VALUES (?1, ?2, 'member', datetime('now'))", [MEMBER, NET]);
  db.run(`INSERT INTO nodes (node_id, node_name, alias, network_id, runtime, model, channels, config_snapshot,
                             hostname, created_at, updated_at, lifecycle_state)
          VALUES (?1, 'probe-err-daemon', 'probe-err-daemon', ?2, 'claude-agent-sdk', 'm', '[]', '{}', 'host-e',
                  datetime('now'), datetime('now'), 'active')`, [DAEMON, NET]);
  db.run(`INSERT INTO providers (provider_id, network_id, name, vendor, base_url, secret_key_ref, created_at, created_by, enabled)
          VALUES (?1, ?2, 'err-provider', 'anthropic', 'https://api.anthropic.com', ?3, ?4, ?5, ?6)`,
    [PROVIDER, NET, opts.secretKey, Date.now(), ADMIN, opts.enabled]);
  db.run(`INSERT INTO provider_models (model_id, provider_id, model_name, display_name, created_at)
          VALUES ('pm_err', ?1, 'probe-model', 'Probe Model', ?2)`, [PROVIDER, Date.now()]);
}

beforeEach(() => seed({ enabled: 1, secretKey: "PROBE_ERR_ABSENT" }));
afterAll(() => { stopBackgroundProbeTimersForTest(); cleanup(); });

describe("#3309 probe_provider_model 错误值域：四条拒绝各有一条会红的断言", () => {
  test("成员（非 owner/admin）⇒ error === insufficient_role_for_probe", async () => {
    const r = await callProbe(MEMBER, base);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("insufficient_role_for_probe");
    // 拒绝体还带着「需要什么角色 / 调用者是什么角色」—— 否则读的人只知道被拒，不知道为什么。
    expect(r.required_role).toBe("admin");
    expect(r.caller_role).toBe("member");
    expectKeys(r, ["ok", "error", "required_role", "caller_role"]);
  });

  test("provider 不存在 ⇒ error === provider_not_found", async () => {
    const r = await callProbe(ADMIN, { ...base, provider_id: "prov_does_not_exist" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("provider_not_found");
    expect(r.provider_id).toBe("prov_does_not_exist");
    expectKeys(r, ["ok", "error", "provider_id"]);
  });

  test("provider 存在但停用 ⇒ error === provider_disabled（**不是** provider_not_found）", async () => {
    seed({ enabled: 0, secretKey: "PROBE_ERR_ABSENT" });
    const r = await callProbe(ADMIN, base);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("provider_disabled");
    // 这两条的区别就是这张测试存在的理由：一个要建、一个只要启用。
    expect(r.error).not.toBe("provider_not_found");
    expect(r.hint).toContain("enabled:true");
    expectKeys(r, ["ok", "error", "provider_id", "hint"]);
  });

  test("provider 引用的密钥不在 vault ⇒ error === secret_not_in_vault，且带上键名", async () => {
    const r = await callProbe(ADMIN, base);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("secret_not_in_vault");
    expect(r.key).toBe("PROBE_ERR_ABSENT");
    expectKeys(r, ["ok", "error", "key"]);
    // 键名是标识不是凭据：报出来才能让人去补哪一把。
  });

  test("四条的形状都**没有** code 字段（现状，不是契约）", async () => {
    const cases = [
      await callProbe(MEMBER, base),
      await callProbe(ADMIN, { ...base, provider_id: "prov_does_not_exist" }),
    ];
    seed({ enabled: 0, secretKey: "PROBE_ERR_ABSENT" });
    cases.push(await callProbe(ADMIN, base));
    seed({ enabled: 1, secretKey: "PROBE_ERR_ABSENT" });
    cases.push(await callProbe(ADMIN, base));
    for (const r of cases) {
      expect(r.ok).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(r, "code")).toBe(false);
    }
  });
});

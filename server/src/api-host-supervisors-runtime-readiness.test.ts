// #622 —— daemon 逐 runtime 自检(runtime_readiness)从 report_status 一路走到
// /api/host-supervisors。三件事:
//   1. report_status 的 zod 形状收得宽:坏的 runtime_readiness 只丢它自己,
//      绝不拒掉整份 report(否则一台 daemon 发了个奇怪的诊断字段就在 hub 上失联);
//   2. 新字段会被**保留**(daemon_capabilities 不是 strict,schema 里没声明的键会被
//      静默剥掉 —— 不加 schema 就永远到不了 REST);
//   3. REST 只在 daemon 报了时输出,旧 daemon 的行里**没有**这个键;
//      can_create_nodes 语义不变。

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import "./require-explicit-test-db.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { register, login } from "./auth.js";
import { db } from "./db.js";
import { registerTools } from "./tools.js";
import { sanitizeRuntimeReadiness } from "./runtime-readiness.js";

function captureToolSchemas(): Record<string, any> {
  const mcp = new McpServer({ name: "schema-probe", version: "0" }) as any;
  const schemas: Record<string, any> = {};
  const origTool = mcp.tool.bind(mcp);
  mcp.tool = (name: string, desc: string, schema: any, handler: any) => {
    schemas[name] = schema;
    return origTool(name, desc, schema, handler);
  };
  registerTools(mcp, undefined, null, null, null, false, "tok_schema_probe");
  return schemas;
}
const schemas = captureToolSchemas();
const snapSchema = () => schemas.report_status.config_snapshot;
const base = { flags: {}, config_update_capable: false, peer_reply_inbox_capable: true };

const READY = {
  ok: true, state: "ready", reason: "可以创建", version: "2.1.290",
  checked_at: "2026-10-06T03:00:00.000Z", cli: "found", auth: "present", network: "reachable",
};
const MISSING = {
  ok: false, state: "missing_cli", reason: "新节点的 PATH 上找不到可用的 grok 命令", checked_at: "2026-10-06T03:00:00.000Z",
  cli: "missing", auth: "present", network: "skipped",
};

describe("#622 report_status schema —— runtime_readiness", () => {
  test("合法值透传(没被 daemon_capabilities 的非 strict 剥掉)", () => {
    const parsed = snapSchema().parse({ ...base, daemon_capabilities: {
      can_create_nodes: true,
      runtime_readiness: { "claude-code-cli": READY, "grok-build-acp": MISSING, "codex-sdk": { ...READY, shared_login_count: 27 } },
    } });
    expect(parsed.daemon_capabilities.runtime_readiness["claude-code-cli"].state).toBe("ready");
    expect(parsed.daemon_capabilities.runtime_readiness["grok-build-acp"].state).toBe("missing_cli");
    expect(parsed.daemon_capabilities.runtime_readiness["codex-sdk"].shared_login_count).toBe(27);
    expect(parsed.daemon_capabilities.can_create_nodes).toBe(true);
  });

  test("🔴 坏形状绝不拒整份 report —— 只丢这一格", () => {
    for (const bad of [
      "string", 42, null, [], { x: "notobj" },
      Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`rt${i}`, READY])),
    ]) {
      const parsed = snapSchema().parse({ ...base, daemon_capabilities: { can_create_nodes: true, runtime_readiness: bad } });
      expect(parsed.daemon_capabilities.can_create_nodes).toBe(true);
      expect(parsed.daemon_capabilities.runtime_readiness).toBeUndefined();
    }
  });

  test("单个字段坏:schema 不拒整份;读取侧消毒把它兜成 unknown", () => {
    const parsed = snapSchema().parse({ ...base, daemon_capabilities: {
      can_create_nodes: true,
      runtime_readiness: { a: { ok: "yes", state: 7, reason: "x".repeat(5000), shared_login_count: -3 } },
    } });
    expect(parsed.daemon_capabilities.can_create_nodes).toBe(true);
    const a = sanitizeRuntimeReadiness(parsed.daemon_capabilities.runtime_readiness)!.a;
    expect(a.ok).toBe(false);
    expect(a.state).toBe("unknown");
    expect(a.reason.length).toBe(600);
    expect(a.shared_login_count).toBeUndefined();
  });

  test("总字节超 16 KB:整格丢掉(异常 daemon 不能往库里塞大对象)", () => {
    const big = { a: { ...READY, reason: "x".repeat(20_000) } };
    const parsed = snapSchema().parse({ ...base, daemon_capabilities: { can_create_nodes: true, runtime_readiness: big } });
    expect(parsed.daemon_capabilities.runtime_readiness).toBeUndefined();
    expect(parsed.daemon_capabilities.can_create_nodes).toBe(true);
  });
});

describe("#622 sanitizeRuntimeReadiness(读取侧)", () => {
  test("不认识的 state → unknown;ok 只有 ready 时才可能为真", () => {
    const s = sanitizeRuntimeReadiness({
      a: { ok: true, state: "something_new", reason: "r" },
      b: { ok: true, state: "no_network", reason: "r" },
    })!;
    expect(s.a.state).toBe("unknown");
    expect(s.a.ok).toBe(false);
    expect(s.b.ok).toBe(false);
  });
  test("没报 / 空 → undefined(调用方据此不输出键)", () => {
    expect(sanitizeRuntimeReadiness(undefined)).toBeUndefined();
    expect(sanitizeRuntimeReadiness({})).toBeUndefined();
    expect(sanitizeRuntimeReadiness([])).toBeUndefined();
  });
  test("未知枚举值的 cli/auth/network 被丢掉", () => {
    const s = sanitizeRuntimeReadiness({ a: { ...READY, cli: "/home/x/bin/claude", network: "maybe" } })!;
    expect(s.a.cli).toBeUndefined();
    expect(s.a.network).toBeUndefined();
    expect(s.a.auth).toBe("present");
  });
  test("generation and accepted stay only on opencode-cli", () => {
    const s = sanitizeRuntimeReadiness({
      "opencode-cli": { ...READY, state: "unknown", ok: false, generation: "v2", accepted: false },
      "claude-code-cli": { ...READY, generation: "v2", accepted: true },
    })!;
    expect(s["opencode-cli"].generation).toBe("v2");
    expect(s["opencode-cli"].accepted).toBe(false);
    expect(s["claude-code-cli"].generation).toBeUndefined();
    expect(s["claude-code-cli"].accepted).toBeUndefined();
    const lone = sanitizeRuntimeReadiness({ "opencode-cli": { ...READY, accepted: true, generation: "nope" } })!;
    expect(lone["opencode-cli"].generation).toBeUndefined();
    expect(lone["opencode-cli"].accepted).toBeUndefined();
  });
});

let BASE = "";
let server: any = null;
let userToken = "";
let userNetworkId = "";
let userId = "";

beforeAll(async () => {
  process.env.HOST = "127.0.0.1";
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const password = "BootstrapPw123Aa!";
  const seed = register(`rr_seed_${suffix}`, password, undefined, "seed");
  if (!seed.ok) throw new Error("seed failed");
  db.run("UPDATE users SET role = 'admin' WHERE username = ?1", [`rr_seed_${suffix}`]);
  const u = register(`rr_u_${suffix}`, password, undefined, "seed");
  if (!u.ok || !u.token) throw new Error("user register failed");
  userToken = u.token;
  userNetworkId = u.network_id ?? "";
  userId = login(`rr_u_${suffix}`, password).user!.user_id;
  const { bootServer } = await import("./server.js");
  server = bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${server.port}`;
  await new Promise((r) => setTimeout(r, 100));
});

afterAll(() => {
  try { server?.stop?.(true); } catch {}
});

function seedDaemon(alias: string, snapshot: object): void {
  db.run(
    `INSERT OR REPLACE INTO nodes (
       node_id, node_name, alias, runtime, model, config_path,
       channels, server, hostname, network_id, config_revision, config_snapshot
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
    [`rr_n_${alias}`, alias, alias, "claude-agent-sdk", null, "/tmp/cfg.json", "[]", "test-host", "test-host",
     userNetworkId, 0, JSON.stringify(snapshot)],
  );
  db.run(
    `INSERT OR REPLACE INTO api_tokens (token_id, token_hash, user_id, network_id, name, scope)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    [`rr_t_${alias}`, `hash_rr_${alias}`, userId, userNetworkId, `node:${alias}`, "network"],
  );
}

async function listDaemons(): Promise<any[]> {
  const res = await fetch(`${BASE}/api/host-supervisors`, { headers: { Authorization: `Bearer ${userToken}` } });
  const body = await res.json();
  if (!body.ok) throw new Error("list failed: " + JSON.stringify(body));
  return body.daemons;
}

describe("#622 /api/host-supervisors 输出 runtime_readiness", () => {
  test("新 daemon:逐 runtime 透传;can_create_nodes 不受影响", async () => {
    db.run("DELETE FROM nodes WHERE network_id = ?1", [userNetworkId]);
    seedDaemon("rr-new", { role: "host_supervisor", daemon_capabilities: {
      runtimes_supported: ["claude-code-cli", "grok-build-acp"],
      can_create_nodes: true,
      runtime_readiness: { "claude-code-cli": READY, "grok-build-acp": MISSING },
    } });
    const d = (await listDaemons()).find((x) => x.alias === "rr-new");
    expect(d.can_create_nodes).toBe(true);
    expect(d.runtime_readiness["claude-code-cli"]).toEqual(READY);
    expect(d.runtime_readiness["grok-build-acp"].state).toBe("missing_cli");
    expect(d.runtime_readiness["grok-build-acp"].ok).toBe(false);
  });

  test("🔴 旧 daemon(不报):响应里没有这个键 —— 不是 {}、不是 null", async () => {
    db.run("DELETE FROM nodes WHERE network_id = ?1", [userNetworkId]);
    seedDaemon("rr-old", { role: "host_supervisor", daemon_capabilities: { runtimes_supported: ["claude-agent-sdk"], can_create_nodes: true } });
    const d = (await listDaemons()).find((x) => x.alias === "rr-old");
    expect(d.can_create_nodes).toBe(true);
    expect("runtime_readiness" in d).toBe(false);
  });
});

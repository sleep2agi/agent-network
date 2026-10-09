import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "./require-explicit-test-db.js";
import { db } from "./db.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";
import { daemonDefaultWorkdirRoot, validateWorkdir, ValidationError } from "./create-node-validate.js";
import { addNetworkMember, login, register } from "./auth.js";

// app「新建节点」工作目录 —— hub 这一层管三件事:
//   ① node_spec.workdir 的**形状**(绝对 / ~/… / C:\…),派发前就拒
//   ② daemon 没自报 default_workdir_root(= 老 daemon,会静默忽略 workdir)⇒ 拒,不派
//   ③ 请求行存下 workdir,get_create_request 原样交给 daemon;不带就**不出现**这个键
// 以及 /api/host-supervisors 只给 admin/owner 透出默认根(它是那台机器的家目录路径)。

const NET = "net_workdir_gate";
const USER_ID = "u_workdir_admin";
const DAEMON_ID = "node_workdir_daemon";
const DAEMON_ALIAS = "workdir-daemon";
const DAEMON_TOK = "tok_workdir_daemon";
const ROOT = "/home/user";

interface ToolHandler { (args: any, extra?: any): Promise<{ content: Array<{ type: "text"; text: string }> }>; }
interface Reply { ok?: boolean; error?: string; request_id?: string; node_spec?: any; [k: string]: unknown; }

function cleanup() {
  for (const t of ["node_create_requests", "audit_log", "nodes", "sessions", "api_tokens", "network_members"]) {
    try { db.run(`DELETE FROM ${t} WHERE network_id = ?1`, [NET]); } catch {}
  }
  try { db.run("DELETE FROM networks WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM users WHERE user_id = ?1", [USER_ID]); } catch {}
}
beforeEach(cleanup);
afterAll(cleanup);

function seed(caps: Record<string, unknown>) {
  db.run(`INSERT INTO users (user_id, username, password_hash, role, created_at) VALUES (?1, ?1, 'x', 'user', datetime('now'))`, [USER_ID]);
  db.run(`INSERT OR REPLACE INTO networks (network_id, network_name, owner_id, created_at) VALUES (?1, ?1, ?2, datetime('now'))`, [NET, USER_ID]);
  db.run(`INSERT INTO network_members (user_id, network_id, role, joined_at) VALUES (?1, ?2, 'admin', datetime('now'))`, [USER_ID, NET]);
  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, network_id, config_snapshot, hostname, created_at, updated_at, lifecycle_state)
     VALUES (?1, ?2, ?2, ?3, ?4, 'host-x', datetime('now'), datetime('now'), 'active')`,
    [DAEMON_ID, DAEMON_ALIAS, NET, JSON.stringify({ role: "host_supervisor", daemon_capabilities: { runtimes_supported: ["claude-agent-sdk"], ...caps } })],
  );
  db.run(
    `INSERT INTO api_tokens (token_id, user_id, network_id, scope, name, token_hash, expires_at, revoked_at)
     VALUES (?1, ?2, ?3, 'network', ?4, ?5, NULL, NULL)`,
    [DAEMON_TOK, USER_ID, NET, `node:${DAEMON_ALIAS}`, `hash_${DAEMON_TOK}`],
  );
}

function tools(callerTokenId: string | null = null): Record<string, ToolHandler> {
  const server = new McpServer({ name: "test", version: "0" }) as any;
  const out: Record<string, ToolHandler> = {};
  const origTool = server.tool.bind(server);
  server.tool = (name: string, d: string, schema: any, handler: ToolHandler) => { out[name] = handler; return origTool(name, d, schema, handler); };
  const origRegisterTool = server.registerTool?.bind(server);
  if (origRegisterTool) {
    server.registerTool = (name: string, cfg: any, handler: ToolHandler) => { out[name] = handler; return origRegisterTool(name, cfg, handler); };
  }
  registerTools(server, undefined, NET, USER_ID, null, true, callerTokenId);
  return out;
}

async function call(h: ToolHandler, args: any): Promise<Reply> {
  return JSON.parse((await h(args)).content[0].text) as Reply;
}

const baseSpec = { name: "wd-child", runtime: "claude-agent-sdk", model: "claude-sonnet-4-5", flags: {} };

function rowCount(): number {
  return db.get<{ n: number }>("SELECT COUNT(*) AS n FROM node_create_requests WHERE daemon_node_id = ?1", DAEMON_ID)?.n ?? -1;
}

describe("validateWorkdir — shape only", () => {
  const ok = ["/home/user/proj", "/srv/x", "~", "~/proj", "C:\\Users\\alice\\proj", "D:/work", "  /padded  "];
  for (const v of ok) test(`accepts ${JSON.stringify(v)}`, () => { expect(() => validateWorkdir(v)).not.toThrow(); });
  test("accepts undefined / null (field omitted)", () => {
    expect(() => validateWorkdir(undefined)).not.toThrow();
    expect(() => validateWorkdir(null)).not.toThrow();
  });
  const bad: unknown[] = ["", "   ", "proj", "./proj", "../x", "~alice/x", "C:proj", "/a\nb", "/a\u0000b", "x".repeat(10) + "/", "/" + "a".repeat(1024), 42, {}];
  for (const v of bad) {
    test(`rejects ${JSON.stringify(v)?.slice(0, 40)}`, () => {
      let code = "";
      try { validateWorkdir(v); } catch (e) { code = (e as ValidationError).code; }
      expect(code).toBe("workdir_invalid");
    });
  }
});

describe("daemonDefaultWorkdirRoot — sanitize the self-report", () => {
  const snap = (v: unknown) => JSON.stringify({ daemon_capabilities: { default_workdir_root: v } });
  test("absolute posix root passes through", () => { expect(daemonDefaultWorkdirRoot(snap(ROOT))).toBe(ROOT); });
  test("windows root passes through", () => { expect(daemonDefaultWorkdirRoot(snap("C:\\Users\\alice"))).toBe("C:\\Users\\alice"); });
  test("object snapshot (not string) also accepted", () => {
    expect(daemonDefaultWorkdirRoot({ daemon_capabilities: { default_workdir_root: ROOT } })).toBe(ROOT);
  });
  for (const v of [undefined, null, "", "relative", "~/x", 7, "/a\nb", "/" + "a".repeat(1100)]) {
    test(`not reported / malformed ${JSON.stringify(v)?.slice(0, 30)} → null`, () => {
      expect(daemonDefaultWorkdirRoot(snap(v))).toBeNull();
    });
  }
  test("null / garbage snapshot → null", () => {
    expect(daemonDefaultWorkdirRoot(null)).toBeNull();
    expect(daemonDefaultWorkdirRoot("{not json")).toBeNull();
  });
});

describe("create_node + workdir", () => {
  test("#829 V2 flags survive Hub storage and daemon pull", async () => {
    seed({ runtimes_supported: ["opencode-cli"] });
    const flags = { opencodeGeneration: "v2", opencodeUnsafeTools: true, timeout: 600000 };
    const r = await call(tools().create_node, { daemon_node_id: DAEMON_ID, node_spec: { name: "v2-child", runtime: "opencode-cli", model: "stub/model", flags } });
    expect(r.ok).toBe(true);
    const row = db.get<{ flags_json: string }>("SELECT flags_json FROM node_create_requests WHERE request_id = ?1", r.request_id);
    expect(JSON.parse(row!.flags_json)).toEqual(flags);
    const pulled = await call(tools(DAEMON_TOK).get_create_request, { request_id: r.request_id });
    expect(pulled.ok).toBe(true);
    expect(pulled.node_spec.flags).toEqual(flags);
  });

  test("#829 missing opt-in rejected before request or child token mint", async () => {
    seed({ runtimes_supported: ["opencode-cli"] });
    const tokenCount = () => db.get<{ n: number }>("SELECT COUNT(*) AS n FROM api_tokens WHERE network_id = ?1", NET)!.n;
    const before = tokenCount();
    const r = await call(tools().create_node, { daemon_node_id: DAEMON_ID, node_spec: { name: "v2-child", runtime: "opencode-cli", flags: { opencodeGeneration: "v2" } } });
    expect(r.error).toBe("opencode_v2_requires_unsafe_opt_in");
    expect(rowCount()).toBe(0);
    expect(tokenCount()).toBe(before);
  });
  test("🔴 old daemon (no default_workdir_root) + workdir → workdir_not_supported_by_daemon, NO row", async () => {
    seed({});
    const r = await call(tools().create_node, { daemon_node_id: DAEMON_ID, node_spec: { ...baseSpec, workdir: `${ROOT}/wd-child` } });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("workdir_not_supported_by_daemon");
    expect(rowCount()).toBe(0);
  });

  test("old daemon WITHOUT workdir still dispatches (no regression for existing callers)", async () => {
    seed({});
    const r = await call(tools().create_node, { daemon_node_id: DAEMON_ID, node_spec: baseSpec });
    expect(r.ok).toBe(true);
    const row = db.get<{ workdir: string | null }>("SELECT workdir FROM node_create_requests WHERE request_id = ?1", r.request_id);
    expect(row?.workdir).toBeNull();
  });

  test("bad shape rejected before dispatch → workdir_invalid, NO row", async () => {
    seed({ default_workdir_root: ROOT });
    const r = await call(tools().create_node, { daemon_node_id: DAEMON_ID, node_spec: { ...baseSpec, workdir: "relative/dir" } });
    expect(r.error).toBe("workdir_invalid");
    expect(rowCount()).toBe(0);
  });

  test("new daemon + workdir → row stores it and get_create_request hands it to the daemon", async () => {
    seed({ default_workdir_root: ROOT });
    const wd = `${ROOT}/wd-child`;
    const r = await call(tools().create_node, { daemon_node_id: DAEMON_ID, node_spec: { ...baseSpec, workdir: wd } });
    expect(r.ok).toBe(true);
    const row = db.get<{ workdir: string | null }>("SELECT workdir FROM node_create_requests WHERE request_id = ?1", r.request_id);
    expect(row?.workdir).toBe(wd);
    const g = await call(tools(DAEMON_TOK).get_create_request, { request_id: r.request_id });
    expect(g.ok).toBe(true);
    expect(g.node_spec.workdir).toBe(wd);
    expect(g.node_spec.name).toBe(baseSpec.name);
  });

  test("workdir is trimmed before storage", async () => {
    seed({ default_workdir_root: ROOT });
    const r = await call(tools().create_node, { daemon_node_id: DAEMON_ID, node_spec: { ...baseSpec, workdir: `  ~/wd-child  ` } });
    expect(r.ok).toBe(true);
    const row = db.get<{ workdir: string | null }>("SELECT workdir FROM node_create_requests WHERE request_id = ?1", r.request_id);
    expect(row?.workdir).toBe("~/wd-child");
  });

  test("new daemon WITHOUT workdir → get_create_request node_spec has NO workdir key (daemon keeps legacy layout)", async () => {
    seed({ default_workdir_root: ROOT });
    const r = await call(tools().create_node, { daemon_node_id: DAEMON_ID, node_spec: baseSpec });
    expect(r.ok).toBe(true);
    const g = await call(tools(DAEMON_TOK).get_create_request, { request_id: r.request_id });
    expect(g.ok).toBe(true);
    expect("workdir" in g.node_spec).toBe(false);
  });

  test("audit detail records the requested workdir", async () => {
    seed({ default_workdir_root: ROOT });
    const wd = `${ROOT}/wd-child`;
    const r = await call(tools().create_node, { daemon_node_id: DAEMON_ID, node_spec: { ...baseSpec, workdir: wd } });
    const a = db.get<{ detail: string }>(
      "SELECT detail FROM audit_log WHERE target_id = ?1 AND action = 'create_node_dispatch_attempted'", r.request_id,
    );
    expect(JSON.parse(a?.detail || "{}").workdir).toBe(wd);
  });

  test("list_host_supervisors (MCP) surfaces default_workdir_root for admin", async () => {
    seed({ default_workdir_root: ROOT });
    const r = await call(tools().list_host_supervisors, {});
    const d = (r as any).daemons.find((x: any) => x.daemon_node_id === DAEMON_ID);
    expect(d.default_workdir_root).toBe(ROOT);
  });

  test("list_host_supervisors (MCP) omits the key for an old daemon", async () => {
    seed({});
    const r = await call(tools().list_host_supervisors, {});
    const d = (r as any).daemons.find((x: any) => x.daemon_node_id === DAEMON_ID);
    expect(d).toBeDefined();
    expect("default_workdir_root" in d).toBe(false);
  });
});

// ── REST /api/host-supervisors: admin sees the root, member does not ──────────
let BASE = "";
let server: any = null;
let ownerTok = "", memberTok = "", restNet = "", ownerId = "";
describe("/api/host-supervisors — default_workdir_root visibility", () => {
  beforeAll(async () => {
    process.env.HOST = "127.0.0.1";
    const sfx = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const pw = "BootstrapPw123Aa!";
    const s = register(`wd_seed_${sfx}`, pw, undefined, "seed");
    if (!s.ok) throw new Error("seed failed");
    db.run("UPDATE users SET role = 'admin' WHERE username = ?1", [`wd_seed_${sfx}`]);
    const o = register(`wd_owner_${sfx}`, pw, undefined, "seed");
    if (!o.ok || !o.token) throw new Error("owner register failed");
    ownerTok = o.token; restNet = o.network_id ?? "";
    ownerId = login(`wd_owner_${sfx}`, pw).user!.user_id;
    const m = register(`wd_member_${sfx}`, pw, undefined, "seed");
    if (!m.ok || !m.token) throw new Error("member register failed");
    memberTok = m.token;
    const memberId = login(`wd_member_${sfx}`, pw).user!.user_id;
    // 多用户 Agent 权限:新成员默认只看授权 Agent;本测试测的是「完全信任的成员」旧语义,显式 agent_access=all。
    const add = addNetworkMember(restNet, memberId, "member", undefined, { agentAccess: "all" });
    if (!add.ok) throw new Error("add member failed: " + add.error);
    const { bootServer } = await import("./server.js");
    server = bootServer({ port: 0, hostname: "127.0.0.1" });
    BASE = `http://127.0.0.1:${server.port}`;
    for (const [alias, caps] of [["wd-new", { default_workdir_root: ROOT }], ["wd-old", {}]] as const) {
      db.run(
        `INSERT OR REPLACE INTO nodes (node_id, node_name, alias, runtime, model, config_path, channels, server, hostname, network_id, config_revision, config_snapshot)
         VALUES (?1, ?2, ?2, 'claude-agent-sdk', 'm', '/tmp/cfg.json', '[]', 'h', 'h', ?3, 0, ?4)`,
        [`wd_n_${alias}`, alias, restNet, JSON.stringify({ role: "host_supervisor", daemon_capabilities: caps })],
      );
      db.run(
        `INSERT OR REPLACE INTO api_tokens (token_id, token_hash, user_id, network_id, name, scope) VALUES (?1, ?2, ?3, ?4, ?5, 'network')`,
        [`wd_t_${alias}`, `hash_wd_${alias}`, ownerId, restNet, `node:${alias}`],
      );
    }
  });
  afterAll(() => {
    try { server?.stop?.(true); } catch {}
    try { db.run("DELETE FROM nodes WHERE network_id = ?1", [restNet]); } catch {}
    try { db.run("DELETE FROM api_tokens WHERE network_id = ?1 AND name LIKE 'node:%'", [restNet]); } catch {}
  });

  async function list(tok: string): Promise<any[]> {
    const res = await fetch(`${BASE}/api/host-supervisors?network_id=${encodeURIComponent(restNet)}`, { headers: { Authorization: `Bearer ${tok}` } });
    const b = await res.json();
    if (!b.ok) throw new Error("list failed: " + JSON.stringify(b));
    return b.daemons;
  }

  test("owner sees default_workdir_root on the new daemon", async () => {
    const d = (await list(ownerTok)).find(x => x.alias === "wd-new");
    expect(d?.default_workdir_root).toBe(ROOT);
  });
  test("old daemon row has NO default_workdir_root key (app hides the row)", async () => {
    const d = (await list(ownerTok)).find(x => x.alias === "wd-old");
    expect(d).toBeDefined();
    expect("default_workdir_root" in d).toBe(false);
  });
  test("🔴 member does NOT see the host's home path", async () => {
    const rows = await list(memberTok);
    const d = rows.find(x => x.alias === "wd-new");
    expect(d).toBeDefined();
    expect("default_workdir_root" in d).toBe(false);
  });
});

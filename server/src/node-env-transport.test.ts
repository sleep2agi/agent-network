// Node environment variables — list_node_env / set_node_env / unset_node_env ride
// the rules-file queue + doorbell (ops env_list / env_set / env_unset).
//
// Hub-side contract verified here:
//   1. Key / value rules (envKeyProblem / envValueProblem) — the deny list is one
//      pure function; refused before any row exists; errors never quote the value.
//   2. The transport gate (classifyRequestTransport / envWriteBlock): a secret is
//      accepted and forwarded only when this call AND the node's hub connection
//      are loopback or HTTPS; a pull over plain HTTP never receives it.
//   3. Authz: user logins only (node tokens refused), network-scoped (another
//      network's node is refused), results only for the login that asked.
//   4. The value leaves the hub the moment the node acks (and on every other
//      terminal path); it is never in a reply, an error, the audit log, any other
//      table, or the console.
//   5. The node's ack is rebuilt from a whitelist — a smuggled value is dropped.
//
// 跑法：cd server && COMMHUB_DB=/tmp/env-transport.db bun test src/node-env-transport.test.ts
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "./db.js";
import { registerTools } from "./tools.js";
import {
  classifyRequestTransport, envKeyProblem, envValueProblem, envWriteBlock, isLoopbackHost, isLoopbackIp,
  purgeEnvRequestValues, sanitizeEnvAckContent, withholdIfContainsValue, type TransportKind,
} from "./node-env.js";

const NET = "net_env_transport";
const OTHER_NET = "net_env_transport_other";
const USER = "u_env_transport_owner";
const SESSION_ALIAS = "env-session-cc";
const SESSION_RESUME = "cc-env-session-1";
const NODE_A = "env-node-a";
const NODE_B = "env-node-b";
const NODE_A_ID = "node_env_a";
const NODE_B_ID = "node_env_b";
const T_SESSION = "tok_env_session_cc";
const T_A = "tok_env_node_a";
const T_B = "tok_env_node_b";
// A value that cannot occur anywhere by accident.
const SECRET = "sk-ENVTEST-7f3c9a1e-SECRET-VALUE-do-not-leak";

function cleanup() {
  for (const net of [NET, OTHER_NET]) {
    for (const t of ["node_rules_requests", "sessions", "nodes", "api_tokens", "network_members", "networks", "audit_log"]) {
      try { db.run(`DELETE FROM ${t} WHERE network_id = ?1`, [net]); } catch {}
    }
  }
  try { db.run("DELETE FROM users WHERE user_id = ?1", [USER]); } catch {}
}

function seedWorld() {
  db.run(`INSERT INTO users (user_id, username, password_hash, role, created_at) VALUES (?1, ?2, 'x', 'user', datetime('now'))`, [USER, USER]);
  for (const net of [NET, OTHER_NET]) {
    db.run(`INSERT INTO networks (network_id, network_name, owner_id, created_at) VALUES (?1, ?2, ?3, datetime('now'))`, [net, net, USER]);
    db.run(`INSERT INTO network_members (user_id, network_id, role, joined_at) VALUES (?1, ?2, 'owner', datetime('now'))`, [USER, net]);
  }
  const tok = (id: string, alias: string, bound: string | null) => db.run(
    `INSERT INTO api_tokens (token_id, user_id, network_id, scope, name, token_hash, expires_at, revoked_at, bound_node_id) VALUES (?1, ?2, ?3, 'network', ?4, ?5, NULL, NULL, ?6)`,
    [id, USER, NET, `node:${alias}`, `hash_${id}`, bound],
  );
  for (const [id, alias] of [[NODE_A_ID, NODE_A], [NODE_B_ID, NODE_B]]) {
    db.run(`INSERT INTO nodes (node_id, node_name, alias, network_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, datetime('now'), datetime('now'))`, [id, alias, alias, NET]);
  }
  tok(T_SESSION, SESSION_ALIAS, null);
  tok(T_A, NODE_A, NODE_A_ID);
  tok(T_B, NODE_B, NODE_B_ID);
}

type Identity = { net: string; alias: string; isNetworkToken: boolean; tokenId: string; transport?: TransportKind };
const asUser: Identity = { net: NET, alias: USER, isNetworkToken: false, tokenId: "tok_env_user", transport: "loopback" };
const asUserPlain: Identity = { ...asUser, transport: "plain" };
const asUserHttps: Identity = { ...asUser, transport: "https" };
const asUserOtherLogin: Identity = { net: NET, alias: USER, isNetworkToken: false, tokenId: "tok_env_user_other", transport: "loopback" };
const asUserOtherNet: Identity = { net: OTHER_NET, alias: USER, isNetworkToken: false, tokenId: "tok_env_user_net2", transport: "loopback" };
const asSession: Identity = { net: NET, alias: SESSION_ALIAS, isNetworkToken: true, tokenId: T_SESSION, transport: "loopback" };
const asA: Identity = { net: NET, alias: NODE_A, isNetworkToken: true, tokenId: T_A, transport: "loopback" };
const asB: Identity = { net: NET, alias: NODE_B, isNetworkToken: true, tokenId: T_B, transport: "loopback" };

const consoleSeen: string[] = [];
for (const m of ["log", "warn", "error", "info", "debug"] as const) {
  const orig = console[m].bind(console);
  (console as any)[m] = (...args: unknown[]) => { consoleSeen.push(args.map(String).join(" ")); orig(...args); };
}

async function connect(id: Identity) {
  const server = new McpServer({ name: "env-test", version: "1" });
  registerTools(server, undefined, id.net, USER, id.alias, id.isNetworkToken, id.tokenId, id.transport ?? "plain");
  const client = new Client({ name: "env-test-client", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  const rawTexts: string[] = [];
  const call = async (name: string, args: Record<string, unknown>) => {
    let r: any;
    try { r = await client.callTool({ name, arguments: args }); }
    catch (e: any) { rawTexts.push(String(e?.message || e)); return { thrown: String(e?.message || e) }; }
    const first = r.content?.[0];
    rawTexts.push(JSON.stringify(r));
    if (!first || first.type !== "text") throw new Error(`no text result from ${name}`);
    try { return JSON.parse(first.text); } catch { return { raw: first.text, isError: r.isError === true }; }
  };
  const close = async () => { await client.close(); await server.close(); };
  return { call, close, rawTexts };
}

async function report(id: Identity, alias: string, resume: string, flags: Record<string, true> = { env_capable: true }) {
  const c = await connect(id);
  try { return await c.call("report_status", { resume_id: resume, alias, status: "idle", agent: "agent-node:claude", ...flags }); }
  finally { await c.close(); }
}

const rowCount = () => db.get<{ n: number }>("SELECT COUNT(*) AS n FROM node_rules_requests WHERE network_id = ?1", NET)!.n;

/** Every text cell of every table: the value must not be anywhere in the hub DB. */
function dbContains(needle: string): string[] {
  const hits: string[] = [];
  const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
  for (const { name } of tables) {
    let rows: any[] = [];
    try { rows = db.all<any>(`SELECT * FROM "${name}"`); } catch { continue; }
    for (const r of rows) if (JSON.stringify(r).includes(needle)) hits.push(name);
  }
  return hits;
}

beforeEach(() => { cleanup(); seedWorld(); });
afterAll(cleanup);

// ─── pure rules ───────────────────────────────────────────────────────────

describe("envKeyProblem — the one deny list", () => {
  test("ordinary provider keys are allowed", () => {
    for (const k of ["DEEPSEEK_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "HTTPS_PROXY", "NO_PROXY", "_PRIVATE", "A", "X".repeat(128)]) {
      expect(envKeyProblem(k)).toBeNull();
    }
  });
  test("malformed keys are invalid_env_key", () => {
    for (const k of ["", "lower", "Mixed_Case", "1ABC", "A-B", "A B", "A=B", "A\u0000", "X".repeat(129), 42, null, undefined]) {
      expect(envKeyProblem(k)?.error).toBe("invalid_env_key");
    }
  });
  test("variables the runtime relies on are reserved_env_key", () => {
    for (const k of [
      "PATH", "HOME", "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT",
      "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "ANET_NODE_MARKER", "ANET_CONFIG_UPDATE_CAPABLE", "ANET_OPENCODE_BIN",
      "COMMHUB_TOKEN", "COMMHUB_AUTH_TOKEN", "COMMHUB_URL", "COMMHUB_ALIAS", "COMMHUB_NODE_ID", "COMMHUB_RESUME_ID",
      "GROK_BINARY", "FLOCK_BINARY", "CODEX_HOME", "GROK_HOME", "CLAUDE_CONFIG_DIR", "RUNTIME", "ALIAS", "MODEL",
      "BUN_OPTIONS", "NPM_CONFIG_REGISTRY", "XDG_RUNTIME_DIR", "BASH_ENV", "PYTHONSTARTUP", "SSL_CERT_FILE", "TMPDIR", "SHELL", "USER",
    ]) {
      expect(envKeyProblem(k)).toMatchObject({ error: "reserved_env_key" });
    }
  });
});

describe("envValueProblem", () => {
  test("non-empty, at most 8 KiB of UTF-8, no NUL; messages never quote the value", () => {
    expect(envValueProblem("x")).toBeNull();
    expect(envValueProblem("a".repeat(8192))).toBeNull();
    expect(envValueProblem("line1\nline2")).toBeNull();
    expect(envValueProblem("a".repeat(8193))?.error).toBe("invalid_env_value");
    expect(envValueProblem("é".repeat(4097))?.error).toBe("invalid_env_value"); // 8194 bytes
    expect(envValueProblem("")?.error).toBe("invalid_env_value");
    expect(envValueProblem(`${SECRET}\u0000`)?.error).toBe("invalid_env_value");
    expect(envValueProblem(7)?.error).toBe("invalid_env_value");
    expect(JSON.stringify(envValueProblem(`${SECRET}\u0000`))).not.toContain(SECRET);
  });
});

describe("classifyRequestTransport", () => {
  const c = (peerIp: string | null, host: string | null, forwardedProto: string | null = null, url = "http://x/mcp") =>
    classifyRequestTransport({ peerIp, host, forwardedProto, url });
  test("loopback needs a loopback peer AND a loopback Host", () => {
    expect(c("127.0.0.1", "127.0.0.1:9200")).toBe("loopback");
    expect(c("::1", "[::1]:9200")).toBe("loopback");
    expect(c("::ffff:127.0.0.1", "localhost:9200")).toBe("loopback");
    expect(c("127.0.0.1", "localhost")).toBe("loopback");
  });
  test("a relayed (frp) connection arrives from 127.0.0.1 but dialed the relay: plain", () => {
    expect(c("127.0.0.1", "relay.example.com:9300")).toBe("plain");
    expect(c("127.0.0.1", "203.0.113.7:9300")).toBe("plain");
    expect(c("127.0.0.1", null)).toBe("plain");
  });
  test("a remote peer is plain even if it claims a loopback Host or https", () => {
    expect(c("203.0.113.5", "127.0.0.1:9200")).toBe("plain");
    expect(c("203.0.113.5", "relay.example.com", "https")).toBe("plain");
    expect(c(null, "127.0.0.1:9200")).toBe("plain");
    expect(c("10.0.0.2", "localhost:9200")).toBe("plain");
  });
  test("https: TLS on the hub itself, or X-Forwarded-Proto on a loopback hop", () => {
    expect(c("203.0.113.5", "hub.example.com", null, "https://hub.example.com/mcp")).toBe("https");
    expect(c("127.0.0.1", "relay.example.com:9443", "https")).toBe("https");
    expect(c("127.0.0.1", "relay.example.com:9443", "HTTPS, http")).toBe("https");
    expect(c("127.0.0.1", "relay.example.com:9300", "http")).toBe("plain");
  });
  test("helpers", () => {
    expect(isLoopbackIp("127.8.9.10")).toBe(true);
    expect(isLoopbackIp("128.0.0.1")).toBe(false);
    expect(isLoopbackIp("1127.0.0.1")).toBe(false);
    expect(isLoopbackHost("127.0.0.1.evil.example")).toBe(false);
    expect(isLoopbackHost("localhost.evil.example:9200")).toBe(false);
  });
  test("envWriteBlock: both legs", () => {
    expect(envWriteBlock("loopback", "loopback")).toBeNull();
    expect(envWriteBlock("https", "https")).toBeNull();
    expect(envWriteBlock("plain", "loopback")).toMatchObject({ error: "insecure_transport", leg: "client" });
    expect(envWriteBlock("loopback", "plain")).toMatchObject({ error: "insecure_transport", leg: "node" });
    expect(envWriteBlock("loopback", null)).toMatchObject({ error: "insecure_transport", leg: "node" });
  });
});

describe("sanitizeEnvAckContent / withholdIfContainsValue", () => {
  test("list keeps whitelisted fields only; a smuggled value is dropped", () => {
    const dirty = JSON.stringify({ keys: [{ key: "API_KEY", set: true, length: 44, in_effect: true, kind: "plain", value: SECRET }, { key: "bad key", length: 1 }, { key: "PATH", length: 3 }], restart: "remote", extra: SECRET });
    const clean = sanitizeEnvAckContent("env_list", dirty)!;
    expect(clean).not.toContain(SECRET);
    expect(JSON.parse(clean)).toEqual({ keys: [{ key: "API_KEY", set: true, length: 44, in_effect: true, kind: "plain" }, { key: "PATH", set: true, length: 3, in_effect: false, kind: "plain", reserved: true }], restart: "remote" });
  });
  test("set / unset: key must be the requested one", () => {
    expect(JSON.parse(sanitizeEnvAckContent("env_set", JSON.stringify({ key: "K", length: 3, value: SECRET }), "K")!)).toEqual({ key: "K", set: true, length: 3, requires_restart: true, restart: "manual" });
    expect(sanitizeEnvAckContent("env_set", JSON.stringify({ key: "OTHER", length: 3 }), "K")).toBeNull();
    expect(sanitizeEnvAckContent("env_set", "not json", "K")).toBeNull();
    expect(sanitizeEnvAckContent("env_set", JSON.stringify({ key: "K", length: -1 }), "K")).toBeNull();
    expect(JSON.parse(sanitizeEnvAckContent("env_unset", JSON.stringify({ key: "K", existed: true, requires_restart: true, restart: "remote" }), "K")!)).toEqual({ key: "K", set: false, existed: true, requires_restart: true, restart: "remote" });
  });
  test("an error that quotes the value is withheld", () => {
    expect(withholdIfContainsValue(`boom ${SECRET}`, SECRET)).not.toContain(SECRET);
    expect(withholdIfContainsValue("config write failed (EACCES)", SECRET)).toBe("config write failed (EACCES)");
  });
});

// ─── through the MCP tools ────────────────────────────────────────────────

describe("capability + transport are recorded from the node's own reports", () => {
  test("env_capable is sticky; env_transport is re-measured every report; only the own token sets them", async () => {
    await report(asSession, SESSION_ALIAS, SESSION_RESUME);
    const row = () => db.get<{ env_capable: number; env_transport: string | null }>("SELECT env_capable, env_transport FROM sessions WHERE alias = ?1 AND network_id = ?2", SESSION_ALIAS, NET);
    expect(row()).toEqual({ env_capable: 1, env_transport: "loopback" });
    await report({ ...asSession, transport: "plain" }, SESSION_ALIAS, SESSION_RESUME, {});
    expect(row()).toEqual({ env_capable: 1, env_transport: "plain" });
    // A user login reporting for some alias never marks it capable.
    await report(asUser, "env-user-made-up", "cc-env-user", { env_capable: true });
    expect(db.get<{ c: number }>("SELECT env_capable AS c FROM sessions WHERE alias = 'env-user-made-up'")?.c ?? 0).toBe(0);
  }, 20_000);

  test("a stale process whose report is rewritten to a renamed alias does not grant that alias the flag or a transport", async () => {
    const NEW_ALIAS = "env-session-renamed";
    db.run(
      `INSERT INTO rename_txn (txn_id, network_id, old_alias, new_alias, status, committed_at) VALUES ('txn_env_rename', ?1, ?2, ?3, 'committed', datetime('now'))`,
      [NET, SESSION_ALIAS, NEW_ALIAS],
    );
    try {
      // Token still carries the old alias; the hub rewrites the report to NEW_ALIAS.
      const r = await report(asSession, SESSION_ALIAS, "cc-env-renamed");
      expect(r.ok).toBe(true);
      const row = db.get<{ env_capable: number; env_transport: string | null }>("SELECT env_capable, env_transport FROM sessions WHERE alias = ?1 AND network_id = ?2", NEW_ALIAS, NET);
      expect(row).toEqual({ env_capable: 0, env_transport: null });
    } finally {
      db.run("DELETE FROM rename_txn WHERE txn_id = 'txn_env_rename'");
    }
  }, 20_000);

  test("a target that never reported env_capable is env_not_supported / env_target_not_found (no row)", async () => {
    await report(asA, NODE_A, "sdk-env-a", {});
    const u = await connect(asUser);
    try {
      expect(await u.call("list_node_env", { node_id: NODE_A_ID })).toMatchObject({ ok: false, error: "env_not_supported" });
      expect(await u.call("list_node_env", { alias: "nobody-here" })).toMatchObject({ ok: false, error: "env_target_not_found" });
      expect(rowCount()).toBe(0);
    } finally { await u.close(); }
  }, 20_000);
});

describe("validation happens before any row is written", () => {
  test("bad / reserved keys and bad values are refused; the value is never echoed", async () => {
    await report(asSession, SESSION_ALIAS, SESSION_RESUME);
    const u = await connect(asUser);
    try {
      expect(await u.call("set_node_env", { alias: SESSION_ALIAS, key: "lower_case", value: SECRET })).toMatchObject({ ok: false, error: "invalid_env_key" });
      for (const key of ["PATH", "HOME", "NODE_OPTIONS", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "ANET_NODE_MARKER", "COMMHUB_TOKEN"]) {
        expect(await u.call("set_node_env", { alias: SESSION_ALIAS, key, value: SECRET })).toMatchObject({ ok: false, error: "reserved_env_key" });
        expect(await u.call("unset_node_env", { alias: SESSION_ALIAS, key })).toMatchObject({ ok: false, error: "reserved_env_key" });
      }
      expect(await u.call("set_node_env", { alias: SESSION_ALIAS, key: "API_KEY", value: "" })).toMatchObject({ ok: false, error: "invalid_env_value" });
      expect(await u.call("set_node_env", { alias: SESSION_ALIAS, key: "API_KEY", value: `${SECRET}\u0000x` })).toMatchObject({ ok: false, error: "invalid_env_value" });
      expect(await u.call("set_node_env", { alias: SESSION_ALIAS, key: "API_KEY", value: SECRET + "x".repeat(8200) })).toMatchObject({ ok: false, error: "invalid_env_value" });
      // Past the schema's loose cap: an MCP input error — which must not quote the value either.
      const huge = await u.call("set_node_env", { alias: SESSION_ALIAS, key: "API_KEY", value: SECRET + "y".repeat(40_000) });
      expect(huge.ok).not.toBe(true);
      expect(rowCount()).toBe(0);
      for (const t of u.rawTexts) expect(t).not.toContain(SECRET);
    } finally { await u.close(); }
  }, 20_000);
});

describe("who may call", () => {
  test("node tokens are refused for list / set / unset, on other nodes and on themselves", async () => {
    await report(asSession, SESSION_ALIAS, SESSION_RESUME);
    await report(asB, NODE_B, "sdk-env-b");
    const a = await connect(asA);
    try {
      expect(await a.call("list_node_env", { node_id: NODE_B_ID })).toMatchObject({ ok: false, error: "node_token_cannot_manage_env" });
      expect(await a.call("set_node_env", { node_id: NODE_B_ID, key: "API_KEY", value: SECRET })).toMatchObject({ ok: false, error: "node_token_cannot_manage_env" });
      expect(await a.call("unset_node_env", { alias: SESSION_ALIAS, key: "API_KEY" })).toMatchObject({ ok: false, error: "node_token_cannot_manage_env" });
      expect(await a.call("list_node_env", { node_id: NODE_A_ID })).toMatchObject({ ok: false, error: "node_token_cannot_manage_env" });
      expect(rowCount()).toBe(0);
    } finally { await a.close(); }
  }, 20_000);

  test("a login scoped to another network cannot reach this network's node", async () => {
    await report(asB, NODE_B, "sdk-env-b");
    const x = await connect(asUserOtherNet);
    try {
      expect(await x.call("set_node_env", { node_id: NODE_B_ID, key: "API_KEY", value: SECRET })).toMatchObject({ ok: false, error: "cross_network_node" });
      expect(await x.call("list_node_env", { alias: NODE_B })).toMatchObject({ ok: false, error: "env_target_not_found" });
      expect(rowCount()).toBe(0);
    } finally { await x.close(); }
  }, 20_000);

  test("only the login that asked can read an env result", async () => {
    await report(asSession, SESSION_ALIAS, SESSION_RESUME);
    const u = await connect(asUser);
    const other = await connect(asUserOtherLogin);
    const s = await connect(asSession);
    try {
      const enq = await u.call("list_node_env", { alias: SESSION_ALIAS });
      await s.call("get_rules_file_request", {});
      await s.call("ack_rules_file_request", { request_id: enq.request_id, status: "done", content: JSON.stringify({ keys: [], restart: "manual" }) });
      expect(await u.call("get_rules_file_result", { request_id: enq.request_id })).toMatchObject({ ok: true, status: "done" });
      expect(await other.call("get_rules_file_result", { request_id: enq.request_id })).toMatchObject({ ok: false, error: "request_not_found" });
      expect(await s.call("get_rules_file_result", { request_id: enq.request_id })).toMatchObject({ ok: false, error: "request_not_found" });
    } finally { await u.close(); await other.close(); await s.close(); }
  }, 20_000);
});

describe("insecure_transport", () => {
  test("client leg plain → refused before a row exists; list still works and says why writes are blocked", async () => {
    await report(asSession, SESSION_ALIAS, SESSION_RESUME);
    const u = await connect(asUserPlain);
    try {
      expect(await u.call("set_node_env", { alias: SESSION_ALIAS, key: "API_KEY", value: SECRET })).toMatchObject({ ok: false, error: "insecure_transport", leg: "client" });
      expect(rowCount()).toBe(0);
      const l = await u.call("list_node_env", { alias: SESSION_ALIAS });
      expect(l).toMatchObject({ ok: true, op: "env_list", write_allowed: false, write_blocked: { error: "insecure_transport", leg: "client" } });
      // unset carries no secret: allowed.
      const un = await u.call("unset_node_env", { alias: SESSION_ALIAS, key: "OLD_KEY" });
      expect(un).toMatchObject({ ok: false, error: "request_in_flight" }); // same lane as the list above
    } finally { await u.close(); }
  }, 20_000);

  test("node leg plain (a relayed node) → refused for set; list says write_allowed:false leg node", async () => {
    await report({ ...asSession, transport: "plain" }, SESSION_ALIAS, SESSION_RESUME);
    const u = await connect(asUser);
    try {
      expect(await u.call("set_node_env", { alias: SESSION_ALIAS, key: "API_KEY", value: SECRET })).toMatchObject({ ok: false, error: "insecure_transport", leg: "node" });
      expect(rowCount()).toBe(0);
      expect(await u.call("list_node_env", { alias: SESSION_ALIAS })).toMatchObject({ ok: true, write_allowed: false, write_blocked: { leg: "node" } });
    } finally { await u.close(); }
  }, 20_000);

  test("unset is allowed over plain on both legs", async () => {
    await report({ ...asSession, transport: "plain" }, SESSION_ALIAS, SESSION_RESUME);
    const u = await connect(asUserPlain);
    try {
      expect(await u.call("unset_node_env", { alias: SESSION_ALIAS, key: "OLD_KEY" })).toMatchObject({ ok: true, op: "env_unset", key: "OLD_KEY" });
    } finally { await u.close(); }
  }, 20_000);

  test("both legs https → allowed", async () => {
    await report({ ...asSession, transport: "https" }, SESSION_ALIAS, SESSION_RESUME);
    const u = await connect(asUserHttps);
    try {
      expect(await u.call("set_node_env", { alias: SESSION_ALIAS, key: "API_KEY", value: SECRET })).toMatchObject({ ok: true, op: "env_set", key: "API_KEY", length: SECRET.length });
    } finally { await u.close(); }
  }, 20_000);

  test("the node reported over loopback but pulls over plain: the secret is not handed out and leaves the row", async () => {
    await report(asSession, SESSION_ALIAS, SESSION_RESUME);
    const u = await connect(asUser);
    const sPlain = await connect({ ...asSession, transport: "plain" });
    try {
      const enq = await u.call("set_node_env", { alias: SESSION_ALIAS, key: "API_KEY", value: SECRET });
      expect(enq).toMatchObject({ ok: true });
      const pulled = await sPlain.call("get_rules_file_request", {});
      expect(pulled.request).toBeNull();
      for (const t of sPlain.rawTexts) expect(t).not.toContain(SECRET);
      const res = await u.call("get_rules_file_result", { request_id: enq.request_id });
      expect(res).toMatchObject({ status: "failed" });
      expect(res.error).toContain("insecure_transport");
      expect(dbContains(SECRET)).toEqual([]);
    } finally { await u.close(); await sPlain.close(); }
  }, 20_000);
});

describe("round trip; the value leaves the hub on ack", () => {
  test("set → pull (value) → ack (smuggled value dropped) → result has key+length; value nowhere in DB / replies / console", async () => {
    consoleSeen.length = 0;
    await report(asSession, SESSION_ALIAS, SESSION_RESUME);
    const u = await connect(asUser);
    const s = await connect(asSession);
    try {
      const enq = await u.call("set_node_env", { alias: SESSION_ALIAS, key: "API_KEY", value: SECRET });
      expect(enq).toEqual({ ok: true, request_id: enq.request_id, op: "env_set", key: "API_KEY", length: SECRET.length });
      // While pending, the value is on the row (the node has not pulled yet).
      expect(dbContains(SECRET)).toEqual(["node_rules_requests"]);
      const pulled = await s.call("get_rules_file_request", {});
      expect(pulled.request).toEqual({ request_id: enq.request_id, op: "env_set", content: JSON.stringify({ key: "API_KEY", value: SECRET }) });
      const ack = await s.call("ack_rules_file_request", { request_id: enq.request_id, status: "done", file_name: "env", exists: true, content: JSON.stringify({ key: "API_KEY", set: true, length: SECRET.length, requires_restart: true, restart: "manual", value: SECRET }) });
      expect(ack).toMatchObject({ ok: true, status: "done" });
      // Immediately after the ack — not after a grace window.
      expect(dbContains(SECRET)).toEqual([]);
      const row = db.get<{ content: string | null }>("SELECT content FROM node_rules_requests WHERE request_id = ?1", enq.request_id)!;
      expect(row.content).toBe(JSON.stringify({ key: "API_KEY" }));
      const res = await u.call("get_rules_file_result", { request_id: enq.request_id });
      expect(res).toMatchObject({ ok: true, op: "env_set", status: "done" });
      expect(JSON.parse(res.content)).toEqual({ key: "API_KEY", set: true, length: SECRET.length, requires_restart: true, restart: "manual" });
      // Audit: key + length, never the value.
      const audit = db.all<{ action: string; detail: string }>("SELECT action, detail FROM audit_log WHERE network_id = ?1", NET);
      expect(audit.map(a => a.action)).toContain("node_env_set");
      expect(JSON.parse(audit.find(a => a.action === "node_env_set")!.detail)).toMatchObject({ key: "API_KEY", length: SECRET.length });
      for (const t of [...u.rawTexts]) expect(t).not.toContain(SECRET);
      for (const line of consoleSeen) expect(line).not.toContain(SECRET);
    } finally { await u.close(); await s.close(); }
  }, 20_000);

  test("a failed ack that quotes the value is withheld; the value leaves the row", async () => {
    await report(asSession, SESSION_ALIAS, SESSION_RESUME);
    const u = await connect(asUser);
    const s = await connect(asSession);
    try {
      const enq = await u.call("set_node_env", { alias: SESSION_ALIAS, key: "API_KEY", value: SECRET });
      await s.call("get_rules_file_request", {});
      await s.call("ack_rules_file_request", { request_id: enq.request_id, status: "failed", error: `could not write ${SECRET}` });
      const res = await u.call("get_rules_file_result", { request_id: enq.request_id });
      expect(res.status).toBe("failed");
      expect(res.error).not.toContain(SECRET);
      expect(dbContains(SECRET)).toEqual([]);
    } finally { await u.close(); await s.close(); }
  }, 20_000);

  test("a malformed done-ack becomes failed and stores nothing from it", async () => {
    await report(asSession, SESSION_ALIAS, SESSION_RESUME);
    const u = await connect(asUser);
    const s = await connect(asSession);
    try {
      const enq = await u.call("set_node_env", { alias: SESSION_ALIAS, key: "API_KEY", value: SECRET });
      await s.call("get_rules_file_request", {});
      expect(await s.call("ack_rules_file_request", { request_id: enq.request_id, status: "done", content: SECRET })).toMatchObject({ status: "failed" });
      expect(dbContains(SECRET)).toEqual([]);
    } finally { await u.close(); await s.close(); }
  }, 20_000);

  test("list result: sanitized, and a bound node's own request only", async () => {
    await report(asB, NODE_B, "sdk-env-b");
    const u = await connect(asUser);
    const a = await connect(asA);
    const b = await connect(asB);
    try {
      const enq = await u.call("list_node_env", { node_id: NODE_B_ID });
      expect(enq).toMatchObject({ ok: true, op: "env_list", write_allowed: true });
      expect((await a.call("get_rules_file_request", {})).request).toBeNull();
      expect(await a.call("ack_rules_file_request", { request_id: enq.request_id, status: "done", content: "{}" })).toMatchObject({ ignored: "unknown_or_foreign_request" });
      expect((await b.call("get_rules_file_request", {})).request).toEqual({ request_id: enq.request_id, op: "env_list" });
      await b.call("ack_rules_file_request", { request_id: enq.request_id, status: "done", content: JSON.stringify({ keys: [{ key: "API_KEY", set: true, length: 9, in_effect: false, kind: "plain", value: SECRET }], restart: "remote" }) });
      const res = await u.call("get_rules_file_result", { request_id: enq.request_id });
      expect(JSON.parse(res.content)).toEqual({ keys: [{ key: "API_KEY", set: true, length: 9, in_effect: false, kind: "plain" }], restart: "remote" });
      expect(dbContains(SECRET)).toEqual([]);
    } finally { await u.close(); await a.close(); await b.close(); }
  }, 20_000);
});

describe("nobody acks: the value still leaves the hub", () => {
  test("a never-pulled set is timed out and purged by the backstop after 60 s", async () => {
    await report(asSession, SESSION_ALIAS, SESSION_RESUME);
    const u = await connect(asUser);
    try {
      const enq = await u.call("set_node_env", { alias: SESSION_ALIAS, key: "API_KEY", value: SECRET });
      expect(purgeEnvRequestValues(db, Date.now())).toEqual({ timedOut: 0, purged: 0 });
      expect(dbContains(SECRET)).toEqual(["node_rules_requests"]);
      expect(purgeEnvRequestValues(db, Date.now() + 61_000)).toEqual({ timedOut: 1, purged: 1 });
      expect(dbContains(SECRET)).toEqual([]);
      const res = await u.call("get_rules_file_result", { request_id: enq.request_id });
      expect(res.status).toBe("timeout");
    } finally { await u.close(); }
  }, 20_000);

  test("a stale set is never handed to a node that shows up late", async () => {
    await report(asSession, SESSION_ALIAS, SESSION_RESUME);
    const u = await connect(asUser);
    const s = await connect(asSession);
    try {
      const enq = await u.call("set_node_env", { alias: SESSION_ALIAS, key: "API_KEY", value: SECRET });
      db.run("UPDATE node_rules_requests SET created_at = created_at - 120000 WHERE request_id = ?1", [enq.request_id]);
      expect((await s.call("get_rules_file_request", {})).request).toBeNull();
      for (const t of s.rawTexts) expect(t).not.toContain(SECRET);
      expect(dbContains(SECRET)).toEqual([]);
    } finally { await u.close(); await s.close(); }
  }, 20_000);

  test("a superseded set (next enqueue after 60 s) is purged", async () => {
    await report(asSession, SESSION_ALIAS, SESSION_RESUME);
    const u = await connect(asUser);
    try {
      const enq = await u.call("set_node_env", { alias: SESSION_ALIAS, key: "API_KEY", value: SECRET });
      db.run("UPDATE node_rules_requests SET created_at = created_at - 120000 WHERE request_id = ?1", [enq.request_id]);
      expect(await u.call("list_node_env", { alias: SESSION_ALIAS })).toMatchObject({ ok: true });
      expect(dbContains(SECRET)).toEqual([]);
    } finally { await u.close(); }
  }, 20_000);
});

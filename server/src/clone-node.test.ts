// Hub #938 — clone_node on the same daemon: new token, rename collision,
// cross-daemon refusal. Handler-level, same shape as stop-delete-node.test.ts.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db, hashToken } from "./db.js";
import { peekPendingEnvBlob, stopBackgroundTimersForTest } from "./create-node.js";
import { registerTools } from "./tools.js";
import { sessionContractForRuntime } from "./clone-node.js";

const NET = "net_clone_938";
const USER = "u_clone_938";
const DAEMON = "node_clone_daemon_a";
const DAEMON_B = "node_clone_daemon_b";
const DAEMON_ALIAS = "clone-daemon-a";
const DAEMON_B_ALIAS = "clone-daemon-b";
const DAEMON_TOK = "tok_clone_daemon_a";
const SOURCE = "node_clone_source";
const SOURCE_ALIAS = "src-child";
const SOURCE_TOKEN = "ntok_source_SHOULD_NOT_COPY";
const OTHER = "node_clone_other";
const OTHER_ALIAS = "other-child";

interface ToolHandler { (args: any, extra?: any): Promise<{ content: Array<{ type: "text"; text: string }> }>; }
interface Reply { ok?: boolean; error?: string; [k: string]: unknown; }

function cleanup() {
  for (const n of [NET]) {
    try { db.run("DELETE FROM node_create_requests WHERE network_id = ?1", [n]); } catch {}
    try { db.run("DELETE FROM audit_log WHERE network_id = ?1", [n]); } catch {}
    try { db.run("DELETE FROM nodes WHERE network_id = ?1", [n]); } catch {}
    try { db.run("DELETE FROM api_tokens WHERE network_id = ?1", [n]); } catch {}
    try { db.run("DELETE FROM network_members WHERE network_id = ?1", [n]); } catch {}
    try { db.run("DELETE FROM networks WHERE network_id = ?1", [n]); } catch {}
  }
  try { db.run("DELETE FROM users WHERE user_id = ?1", [USER]); } catch {}
  stopBackgroundTimersForTest();
}

beforeEach(cleanup);
afterAll(cleanup);

function seed() {
  db.run(
    `INSERT INTO users (user_id, username, password_hash, role, created_at) VALUES (?1, ?2, 'x', 'user', datetime('now'))`,
    [USER, USER],
  );
  db.run(
    `INSERT INTO networks (network_id, network_name, owner_id, created_at) VALUES (?1, ?2, ?3, datetime('now'))`,
    [NET, NET, USER],
  );
  db.run(
    `INSERT INTO network_members (user_id, network_id, role, joined_at) VALUES (?1, ?2, 'admin', datetime('now'))`,
    [USER, NET],
  );
  const snap = JSON.stringify({
    role: "member",
    runtime: "claude-agent-sdk",
    model: "claude-sonnet",
    flags: { permissionMode: "acceptEdits", timeout: 60000, apiKey: "sk-do-not-copy" },
    channels: ["server:commhub", "feishu:bot-secret"],
  });
  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, network_id, runtime, model, channels, config_snapshot, hostname, created_at, updated_at, lifecycle_state)
     VALUES (?1, ?2, ?3, ?4, 'claude-agent-sdk', 'claude-sonnet', ?5, ?6, 'host-a', datetime('now'), datetime('now'), 'active')`,
    [SOURCE, SOURCE_ALIAS, SOURCE_ALIAS, NET, JSON.stringify(["server:commhub", "feishu:bot-secret"]), snap],
  );
  db.run(
    `INSERT INTO api_tokens (token_id, user_id, network_id, scope, name, token_hash, role) VALUES (?1, ?2, ?3, 'network', ?4, ?5, 'child')`,
    ["tok_clone_source", USER, NET, `node:${SOURCE_ALIAS}`, hashToken(SOURCE_TOKEN)],
  );
  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, network_id, config_snapshot, hostname, created_at, updated_at, lifecycle_state)
     VALUES (?1, ?2, ?2, ?3, ?4, 'host-a', datetime('now'), datetime('now'), 'active')`,
    [DAEMON, DAEMON_ALIAS, NET, JSON.stringify({ role: "host_supervisor", daemon_capabilities: { can_create_nodes: true, runtimes_supported: ["claude-agent-sdk", "opencode-cli"] } })],
  );
  db.run(
    `INSERT INTO api_tokens (token_id, user_id, network_id, scope, name, token_hash) VALUES (?1, ?2, ?3, 'network', ?4, ?5)`,
    [DAEMON_TOK, USER, NET, `node:${DAEMON_ALIAS}`, `hash_${DAEMON_TOK}`],
  );
  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, network_id, config_snapshot, hostname, created_at, updated_at, lifecycle_state)
     VALUES (?1, ?2, ?2, ?3, ?4, 'host-b', datetime('now'), datetime('now'), 'active')`,
    [DAEMON_B, DAEMON_B_ALIAS, NET, JSON.stringify({ role: "host_supervisor" })],
  );
  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, network_id, config_snapshot, hostname, created_at, updated_at, lifecycle_state)
     VALUES (?1, ?2, ?2, ?3, '{}', 'host-a', datetime('now'), datetime('now'), 'active')`,
    [OTHER, OTHER_ALIAS, NET],
  );
  db.run(
    `INSERT INTO node_create_requests(request_id,daemon_node_id,child_name,network_id,runtime,model,flags_json,env_keys,status,created_at,created_by_token,child_node_id)
     VALUES('cr_clone_source', ?1, ?2, ?3, 'claude-agent-sdk', 'claude-sonnet', ?4, '[]', 'succeeded', 1, 't', ?5)`,
    [DAEMON, SOURCE_ALIAS, NET, JSON.stringify({ permissionMode: "plan" }), SOURCE],
  );
}

function handlers(daemonBound = false): Record<string, ToolHandler> {
  const server = new McpServer({ name: "test", version: "0" }) as any;
  const tools: Record<string, ToolHandler> = {};
  const orig = server.tool.bind(server);
  server.tool = (name: string, desc: string, schema: any, handler: ToolHandler) => {
    tools[name] = handler;
    return orig(name, desc, schema, handler);
  };
  registerTools(server, undefined, daemonBound ? NET : null, USER, null, daemonBound, daemonBound ? DAEMON_TOK : null);
  return tools;
}

async function call(handler: ToolHandler, args: any): Promise<Reply> {
  const r = await handler(args);
  return JSON.parse(r.content[0].text) as Reply;
}

describe("clone_node — happy path (Hub #938)", () => {
  test("mints a new token, keeps the source token, records clone directives", async () => {
    seed();
    const tools = handlers();
    const r = await call(tools.clone_node, {
      source_node_id: SOURCE,
      name: "cloned-child",
      network_id: NET,
    });
    expect(r.ok).toBe(true);
    expect(r.daemon_node_id).toBe(DAEMON);
    expect(r.child_name).toBe("cloned-child");
    expect(r.copy_session).toBe(true);
    expect(r.workdir_policy).toBe("new_empty");
    expect(r.session_contract).toMatchObject({ mode: "transcript_when_present", runtime: "claude-agent-sdk" });
    const contract = r.contract as { token: string; workdir: string; session: string };
    expect(contract.token).toContain("new ntok_");
    expect(contract.workdir).toContain("new empty directory");
    expect(contract.session).toContain("jsonl");

    const requestId = r.request_id as string;
    const row = db.get<{ clone_json: string; runtime: string; flags_json: string; child_token_id: string; status: string }>(
      `SELECT clone_json, runtime, flags_json, child_token_id, status FROM node_create_requests WHERE request_id = ?1`,
      requestId,
    );
    expect(row?.status).toBe("pending");
    expect(row?.runtime).toBe("claude-agent-sdk");
    const flags = JSON.parse(row!.flags_json);
    expect(flags.permissionMode).toBe("acceptEdits");
    expect(flags.timeout).toBe(60000);
    expect(JSON.stringify(flags)).not.toContain("sk-do-not-copy");
    const meta = JSON.parse(row!.clone_json);
    expect(meta).toMatchObject({
      source_node_id: SOURCE,
      source_alias: SOURCE_ALIAS,
      copy_session: true,
      workdir_policy: "new_empty",
      channels: ["server:commhub"],
    });
    expect(JSON.stringify(meta.channels)).not.toContain("feishu");

    const blob = peekPendingEnvBlob(requestId);
    expect(blob?.env_blob).toEqual({});
    expect(blob?.child_token.startsWith("ntok_")).toBe(true);
    expect(blob?.child_token).not.toBe(SOURCE_TOKEN);
    const minted = db.get<{ token_hash: string }>(
      `SELECT token_hash FROM api_tokens WHERE token_id = ?1`, row!.child_token_id,
    );
    expect(minted?.token_hash).toBe(hashToken(blob!.child_token));
    expect(minted?.token_hash).not.toBe(hashToken(SOURCE_TOKEN));
    const sourceTok = db.get<{ revoked_at: string | null }>(
      `SELECT revoked_at FROM api_tokens WHERE token_id = 'tok_clone_source'`,
    );
    expect(sourceTok?.revoked_at ?? null).toBeNull();

    const daemonTools = handlers(true);
    const listed = await call(daemonTools.list_my_pending_create_requests, {});
    expect(listed.ok).toBe(true);
    expect(listed.requests).toEqual([]);
    expect(listed.clone_requests).toEqual([
      expect.objectContaining({ request_id: requestId, child_name: "cloned-child" }),
    ]);
    const refused = await call(daemonTools.get_create_request, { request_id: requestId });
    expect(refused).toMatchObject({ ok: false, error: "clone_request" });
    expect(peekPendingEnvBlob(requestId)?.child_token).toBe(blob?.child_token);
    const pulled = await call(daemonTools.get_create_request, { request_id: requestId, expect_clone: true });
    expect(pulled.ok).toBe(true);
    expect(pulled.child_token).toBe(blob?.child_token);
    expect((pulled.clone as { source_alias: string }).source_alias).toBe(SOURCE_ALIAS);
    expect(peekPendingEnvBlob(requestId)).toBeNull();
  });
});

describe("clone_node — rename collision", () => {
  test("refuses the source name, an existing alias, and an inflight create name", async () => {
    seed();
    db.run(
      `INSERT INTO node_create_requests(request_id,daemon_node_id,child_name,network_id,runtime,model,flags_json,env_keys,status,created_at,created_by_token)
       VALUES('cr_clone_inflight', ?1, 'pending-name', ?2, 'claude-agent-sdk', 'm', '{}', '[]', 'pending', ?3, 't')`,
      [DAEMON, NET, Date.now()],
    );
    const tools = handlers();
    const same = await call(tools.clone_node, { source_node_id: SOURCE, name: SOURCE_ALIAS, network_id: NET });
    expect(same).toMatchObject({ ok: false, error: "node_name_conflict", reason: "same_as_source" });
    const taken = await call(tools.clone_node, { source_node_id: SOURCE, name: OTHER_ALIAS, network_id: NET });
    expect(taken).toMatchObject({ ok: false, error: "node_name_conflict", reason: "alias_taken" });
    const inflight = await call(tools.clone_node, { source_node_id: SOURCE, name: "pending-name", network_id: NET });
    expect(inflight).toMatchObject({ ok: false, error: "node_name_conflict", reason: "inflight_create" });
    const n = db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM node_create_requests WHERE child_name = 'cloned-child'`,
    );
    expect(n?.n).toBe(0);
  });
});

describe("clone_node — cross-daemon refused", () => {
  test("a daemon_node_id other than the source's daemon is refused", async () => {
    seed();
    const tools = handlers();
    const r = await call(tools.clone_node, {
      source_node_id: SOURCE,
      name: "cloned-child",
      daemon_node_id: DAEMON_B,
      network_id: NET,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("cross_daemon_refused");
    expect(r.source_daemon_node_id).toBe(DAEMON);
    expect(r.requested_daemon_node_id).toBe(DAEMON_B);
    const n = db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM api_tokens WHERE name = 'node:cloned-child'`,
    );
    expect(n?.n ?? 0).toBe(0);
  });

  test("omitting daemon_node_id stays on the source daemon", async () => {
    seed();
    const tools = handlers();
    const r = await call(tools.clone_node, { source_node_id: SOURCE, name: "cloned-child", network_id: NET });
    expect(r.ok).toBe(true);
    expect(r.daemon_node_id).toBe(DAEMON);
  });
});

describe("session contract is honest per runtime", () => {
  test("OpenCode is an aliased server session, not a transcript fork", () => {
    const c = sessionContractForRuntime("opencode-cli");
    expect(c.mode).toBe("id_aliased");
    expect(c.detail).toContain("not a private deep copy");
  });

  test("an unknown runtime does not claim a session copy", () => {
    expect(sessionContractForRuntime("not-a-runtime").mode).toBe("unsupported");
  });
});

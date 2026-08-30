import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "./db.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";

// #1353 Fix ① — hub gates create_node dispatch on the daemon's
// self-reported can_create_nodes bit. Before this, daemon reported
// can_create_nodes=false (via #1371 + #1377) → hub stored it → nothing
// read it → dispatch returned {ok:true, request_id} and pushed a
// doorbell to a daemon that had already told hub it couldn't create
// nodes. That's the exact "在线但静默失败" case the issue title reports.
//
// Vincent 2026-08-28 comment on #1353:
//   "daemon 侧确知不可用时,hub 应当**拒绝派发**并返回可操作的错误,
//    而不是发一个注定失败的 doorbell"
//
// 🔴 Pre-#1371 daemons (preview.55 and earlier) don't report the field
// at all. That must NOT fail-closed — the guard is "known-blocked",
// not "unknown-treated-as-blocked". Tested explicitly below.

const NET = "net_1353_gate";
const USER_ID = "u_1353_admin";
const DAEMON_ID = "node_1353_daemon";
const DAEMON_ALIAS = "gate-daemon";
const DAEMON_TOK = "tok_1353_daemon";

interface ToolHandler { (args: any, extra?: any): Promise<{ content: Array<{ type: "text"; text: string }> }>; }
interface Reply { ok?: boolean; error?: string; blocked_reason?: string; request_id?: string; [k: string]: unknown; }

function cleanup() {
  try { db.run("DELETE FROM node_create_requests WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM audit_log WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM nodes WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM api_tokens WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM network_members WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM networks WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM users WHERE user_id = ?1", [USER_ID]); } catch {}
}
beforeEach(cleanup);
afterAll(cleanup);

function seed(snapshot: object | string | null) {
  db.run(
    `INSERT INTO users (user_id, username, password_hash, role, created_at)
     VALUES (?1, ?2, 'x', 'user', datetime('now'))`,
    [USER_ID, USER_ID],
  );
  db.run(
    `INSERT OR REPLACE INTO networks (network_id, network_name, owner_id, created_at)
     VALUES (?1, ?1, ?2, datetime('now'))`,
    [NET, USER_ID],
  );
  db.run(
    `INSERT INTO network_members (user_id, network_id, role, joined_at)
     VALUES (?1, ?2, 'admin', datetime('now'))`,
    [USER_ID, NET],
  );
  const snap = snapshot === null
    ? null
    : (typeof snapshot === "string" ? snapshot : JSON.stringify(snapshot));
  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, network_id, config_snapshot, hostname, created_at, updated_at, lifecycle_state)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'), datetime('now'), 'active')`,
    [DAEMON_ID, DAEMON_ALIAS, DAEMON_ALIAS, NET, snap, `host-${DAEMON_ALIAS}`],
  );
  db.run(
    `INSERT INTO api_tokens (token_id, user_id, network_id, scope, name, token_hash, expires_at, revoked_at)
     VALUES (?1, ?2, ?3, 'network', ?4, ?5, NULL, NULL)`,
    [DAEMON_TOK, USER_ID, NET, `node:${DAEMON_ALIAS}`, `hash_${DAEMON_TOK}`],
  );
}

function tools(): Record<string, ToolHandler> {
  const server = new McpServer({ name: "test", version: "0" }) as any;
  const out: Record<string, ToolHandler> = {};
  const origTool = server.tool.bind(server);
  server.tool = (name: string, _desc: string, _schema: any, handler: ToolHandler) => {
    out[name] = handler;
    return origTool(name, _desc, _schema, handler);
  };
  const origRegisterTool = server.registerTool?.bind(server);
  if (origRegisterTool) {
    server.registerTool = (name: string, _cfg: any, handler: ToolHandler) => {
      out[name] = handler;
      return origRegisterTool(name, _cfg, handler);
    };
  }
  registerTools(
    server, undefined,
    /* enforceNetworkId */ NET,
    /* enforceUserId */ USER_ID,
    /* callerAlias */ null,
    /* callerTokenIsNetwork */ true,
    /* callerTokenId */ null,
  );
  return out;
}

async function call(handler: ToolHandler, args: any): Promise<Reply> {
  const r = await handler(args);
  return JSON.parse(r.content[0].text) as Reply;
}

const spec = {
  name: "child-1353",
  runtime: "claude-agent-sdk",
  model: "claude-sonnet-4-5",
  flags: {},
};

describe("#1353 Fix ① — hub gates create_node on daemon-reported can_create_nodes", () => {
  test("🔴 witnessed-red: blocked daemon (can_create_nodes=false + reason) → refuse with reason, NO dispatch", async () => {
    seed({
      role: "host_supervisor",
      daemon_capabilities: {
        runtimes_supported: ["claude-agent-sdk"],
        can_create_nodes: false,
        create_nodes_blocked_reason: "anet_bin_permission",
      },
    });
    const t = tools();
    const r = await call(t.create_node, { daemon_node_id: DAEMON_ID, node_spec: spec });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("daemon_cannot_create_nodes");
    expect(r.blocked_reason).toBe("anet_bin_permission");
    // No request row inserted — hub must refuse BEFORE dispatch.
    const rows = db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM node_create_requests WHERE daemon_node_id = ?1",
      DAEMON_ID,
    );
    expect(rows?.n).toBe(0);
  });

  test("blocked daemon with each of the 4 reason codes surfaces that specific code", async () => {
    const codes = ["anet_bin_identity", "anet_bin_source", "anet_bin_shape", "anet_bin_permission"];
    for (const code of codes) {
      cleanup();
      seed({
        role: "host_supervisor",
        daemon_capabilities: {
          runtimes_supported: ["claude-agent-sdk"],
          can_create_nodes: false,
          create_nodes_blocked_reason: code,
        },
      });
      const r = await call(tools().create_node, { daemon_node_id: DAEMON_ID, node_spec: spec });
      expect(r.error).toBe("daemon_cannot_create_nodes");
      expect(r.blocked_reason).toBe(code);
    }
  });

  test("blocked with .40-shape 'anet_bin_pin_unresolved' reason surfaces that literal (backcompat)", async () => {
    // The Zod enum in tools.ts still accepts this coarse pre-#1377 code
    // because agent-node@2.5.0-preview.40 daemons in the wild still emit
    // it. If we ever swallow it into "unknown", those daemons' user
    // messages get worse than they already are.
    seed({
      role: "host_supervisor",
      daemon_capabilities: {
        runtimes_supported: ["claude-agent-sdk"],
        can_create_nodes: false,
        create_nodes_blocked_reason: "anet_bin_pin_unresolved",
      },
    });
    const r = await call(tools().create_node, { daemon_node_id: DAEMON_ID, node_spec: spec });
    expect(r.blocked_reason).toBe("anet_bin_pin_unresolved");
  });

  test("blocked with NO reason field → fallback 'anet_bin_unknown' (defensive)", async () => {
    seed({
      role: "host_supervisor",
      daemon_capabilities: {
        runtimes_supported: ["claude-agent-sdk"],
        can_create_nodes: false,
        // no create_nodes_blocked_reason
      },
    });
    const r = await call(tools().create_node, { daemon_node_id: DAEMON_ID, node_spec: spec });
    expect(r.error).toBe("daemon_cannot_create_nodes");
    expect(r.blocked_reason).toBe("anet_bin_unknown");
  });

  test("can_create_nodes=true daemon dispatches normally (gate must not false-positive on healthy daemon)", async () => {
    seed({
      role: "host_supervisor",
      daemon_capabilities: {
        runtimes_supported: ["claude-agent-sdk"],
        can_create_nodes: true,
      },
    });
    const r = await call(tools().create_node, { daemon_node_id: DAEMON_ID, node_spec: spec });
    // Doesn't matter whether downstream dispatch succeeds — the point
    // is that THIS gate did not reject. If reject, r.error would be
    // "daemon_cannot_create_nodes".
    expect(r.error).not.toBe("daemon_cannot_create_nodes");
  });

  test("🔴 pre-#1371 compat: snapshot with NO can_create_nodes field passes through (must NOT fail-closed)", async () => {
    // preview.10 through preview.55 daemons never report this field.
    // If we fail-closed on undefined we silently break every in-flight
    // daemon that hasn't upgraded. Guard is "known-blocked", not
    // "unknown-treated-as-blocked".
    seed({
      role: "host_supervisor",
      daemon_capabilities: {
        runtimes_supported: ["claude-agent-sdk"],
        // no can_create_nodes at all
      },
    });
    const r = await call(tools().create_node, { daemon_node_id: DAEMON_ID, node_spec: spec });
    expect(r.error).not.toBe("daemon_cannot_create_nodes");
  });

  test("pre-#1371 compat: snapshot with no daemon_capabilities at all → passes through", async () => {
    seed({ role: "host_supervisor" });
    const r = await call(tools().create_node, { daemon_node_id: DAEMON_ID, node_spec: spec });
    expect(r.error).not.toBe("daemon_cannot_create_nodes");
  });

  test("pre-#1371 compat: NULL config_snapshot passes through (very old daemon shape)", async () => {
    seed(null);
    const r = await call(tools().create_node, { daemon_node_id: DAEMON_ID, node_spec: spec });
    expect(r.error).not.toBe("daemon_cannot_create_nodes");
  });

  test("malformed config_snapshot: permissive fallthrough (mirrors runtimes_supported catch), no crash", async () => {
    seed("{not json");
    const r = await call(tools().create_node, { daemon_node_id: DAEMON_ID, node_spec: spec });
    expect(r.error).not.toBe("daemon_cannot_create_nodes");
  });
});

// RFC-030 Wave 1B Stage 2 C1 — first RED gate for cross-alias
// principal enforcement on the SAME network (副指挥 ad8b1f53 corrective).
//
// Purpose (READ FIRST):
// This test is an EXPECTED-RED evidence gate. It reproduces the class
// of vulnerability that #440 (Hub principal / typed consumer lease) is
// designed to fix at the SERVER layer:
//
//   Same-network alias A's raw bearer must NOT be able to read, ack,
//   or dead-letter alias B's inbox rows via the existing MCP handlers.
//
// The path exercised here is:
//
//   raw bearer → auth.resolveToken → tools.registerTools → get_inbox
//                                                       → ack_inbox
//                                                       → gateway_dead_letter
//
// throwaway SQLite; a real McpServer registers real handlers; real
// authentication context is derived from ONE api_tokens row per caller
// (副指挥 2306718c pattern — same as rfc030-principal-handler.test.ts).
// The gateway never enters the process. The test proves the vulnerability
// exists at the SERVER MCP entry.
//
// EXPECTED RED under current implementation:
//   - get_inbox({alias:"B"}) with tok_A returns B's rows (leak);
//   - ack_inbox({alias:"B",message_id:"...B row..."}) with tok_A acks;
//   - gateway_dead_letter(canonical_task_id:"...B row...") with tok_A
//     succeeds (network-scoped, not alias-scoped).
//
// EXPECTED GREEN once #440 lands and this suite consumes the thin
// server-resolved principal/typed lease adapter:
//   - All three calls fail-closed with an error keyed to the missing
//     typed principal claim for the target alias (no alias parameters
//     accepted; caller's server-resolved alias is the ONLY source of
//     truth).
//
// The gateway itself is only allowed to fail-closed if the typed claim
// or lease is absent; it MUST NOT accept an alias argument nor
// duplicate the server's SQL alias auth.

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tmpDb = join(mkdtempSync(join(tmpdir(), "rfc030-cross-alias-red-")), "test.db");
process.env.COMMHUB_DB = tmpDb;

// Dynamic imports so the environment variable is honored by ./db.
const { db, hashToken } = await import("./db");
const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { registerTools } = await import("./tools");

const NET = "net_xa_red";
const U_OWNER = "u_xa_owner";
const ALIAS_A = "alias-a";
const ALIAS_B = "alias-b";
const TOK_A = "tok_xa_a";
const TOK_B = "tok_xa_b";

interface ToolHandler {
  (args: Record<string, unknown>, extra?: unknown): Promise<{
    content: Array<{ type: "text"; text: string }>;
  }>;
}

interface HandlerMap {
  [name: string]: ToolHandler;
}

async function collectHandlersUnderBearer(
  bearer: string,
): Promise<HandlerMap> {
  // Mirror index.ts /mcp: resolve token once → single auth context →
  // registerTools binds the closure with that context. Callers below
  // invoke handlers via this closure, so args cannot inject a different
  // alias identity.
  const { resolveToken } = await import("./auth");
  const auth = resolveToken(bearer);
  if (!auth) throw new Error(`bearer did not resolve: ${bearer}`);

  const server = new McpServer({ name: "rfc030-xa-red", version: "0.0.0" });
  const handlers: HandlerMap = {};
  // Wrap server.tool to capture the registered handler by name.
  const origTool = server.tool.bind(server);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).tool = (name: string, ..._rest: unknown[]): unknown => {
    const handler = _rest[_rest.length - 1] as ToolHandler;
    handlers[name] = handler;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (origTool as any)(name, ..._rest);
  };
  registerTools(server, auth);
  return handlers;
}

beforeAll(() => {
  db.run(
    "INSERT INTO users (user_id, username, password_hash, role) VALUES (?1, ?2, 'x', 'user')",
    [U_OWNER, "xa-owner"],
  );
  db.run(
    "INSERT INTO networks (network_id, network_name, owner_id) VALUES (?1, 'xa-net', ?2)",
    [NET, U_OWNER],
  );
  db.run(
    "INSERT INTO network_members (network_id, user_id, role) VALUES (?1, ?2, 'owner')",
    [NET, U_OWNER],
  );
  // Two network-bound tokens, same network, DIFFERENT alias intent.
  // Each corresponds to a distinct anet node identity.
  db.run(
    `INSERT INTO api_tokens (token_id, token_hash, user_id, network_id, scope, name)
     VALUES (?1, ?2, ?3, ?4, 'network', ?5)`,
    [TOK_A, hashToken(TOK_A), U_OWNER, NET, `node:${ALIAS_A}`],
  );
  db.run(
    `INSERT INTO api_tokens (token_id, token_hash, user_id, network_id, scope, name)
     VALUES (?1, ?2, ?3, ?4, 'network', ?5)`,
    [TOK_B, hashToken(TOK_B), U_OWNER, NET, `node:${ALIAS_B}`],
  );

  // Seed one inbox row DESTINED FOR alias-b (session_name=ALIAS_B).
  db.run(
    `INSERT INTO inbox
       (id, session_name, network_id, from_session, type, priority, content, context, created_at, acked)
     VALUES (?1, ?2, ?3, 'someone', 'task', 'normal', 'work for B', '{}', unixepoch(), 0)`,
    ["msg_xa_b1", ALIAS_B, NET],
  );
});

function parseBody(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

describe("RFC-030 Stage 2 C1 — cross-alias IDOR RED (expected fail until #440 lands)", () => {
  test("get_inbox with tok_A must NOT return B's rows (currently RED — leaks B's inbox)", async () => {
    const handlers = await collectHandlersUnderBearer(TOK_A);
    const getInbox = handlers["get_inbox"];
    expect(getInbox).toBeDefined();

    const out = await getInbox({ alias: ALIAS_B, limit: 100 });
    const body = parseBody(out.content[0].text);

    // AFTER #440 fix: body.ok=false with a typed principal error, and
    // body.messages is absent / empty.
    // BEFORE fix (CURRENT STATE): tok_A gets B's rows back.
    //
    // We assert the SAFE post-fix invariant; the test is RED today,
    // which is the point.
    if (body.ok === true) {
      const msgs = (body.messages as Array<{ id: string }>) ?? [];
      const leaked = msgs.some((m) => m.id === "msg_xa_b1");
      expect(leaked).toBe(false); // RED: current impl leaks; must fail-closed.
    } else {
      // Post-fix path (typed principal denies): pass.
      expect(body.ok).toBe(false);
    }
  });

  test("ack_inbox with tok_A must NOT ack B's message (currently RED — sets acked=1)", async () => {
    const handlers = await collectHandlersUnderBearer(TOK_A);
    const ack = handlers["ack_inbox"];
    expect(ack).toBeDefined();

    // Reseed the row to a known unacked state.
    db.run("UPDATE inbox SET acked = 0 WHERE id = 'msg_xa_b1'");
    await ack({ alias: ALIAS_B, message_id: "msg_xa_b1" });

    const row = db.get<{ acked: number }>(
      "SELECT acked FROM inbox WHERE id = 'msg_xa_b1'",
    );
    // Post-fix: tok_A's ack targeting B is refused → row still acked=0.
    // Current impl: tok_A acks B's row → acked=1. This is the RED signal.
    expect(row?.acked).toBe(0);
  });

  test("gateway_dead_letter with tok_A must NOT succeed against B's row (currently RED — network scope alone is insufficient)", async () => {
    const handlers = await collectHandlersUnderBearer(TOK_A);
    const deadLetter = handlers["gateway_dead_letter"];
    expect(deadLetter).toBeDefined();

    // Reseed the row.
    db.run("UPDATE inbox SET acked = 0 WHERE id = 'msg_xa_b1'");
    const out = await deadLetter({
      message_id: "msg_xa_b1",
      reason: "codex_gateway_cross_alias_probe",
    });
    const body = parseBody(out.content[0].text);

    // Post-fix: tok_A dead-lettering B's row is refused by the typed
    // consumer-lease check. `ok:false` with a typed principal error.
    // Current impl: network scope matches, so the op succeeds and the
    // row is quarantined. RED today.
    if (body.ok === true) {
      const outcome = body.outcome as string | undefined;
      // Any success outcome ("dead_lettered" / "quarantined") is a leak
      // under the cross-alias attack model — refuse ANY affirmative
      // outcome for a caller whose typed alias differs from the row's.
      expect(outcome).toBe("refused_alias_mismatch"); // sentinel from #440 fix
    } else {
      expect(body.ok).toBe(false);
    }
  });
});

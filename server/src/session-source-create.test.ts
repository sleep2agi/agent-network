import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SQLiteAdapter, type DbAdapter } from "./db-adapter";
import { createSessionSourceCreateAdapter } from "./session-source-create";
import { createSessionSourceGrantStore, type SessionSourceBinding } from "./session-source-grant";

// Import the real Hub migrations, not a test-only copy of the create schema.
// The canonical runner owns the isolated COMMHUB_DB path and its cleanup.
const { db } = await import("./db");
const { peekPendingEnvBlob, putPendingEnvBlob, runOrphanSweepOnce, finalizeCreateOnFirstRegister } = await import("./create-node");
const grants = createSessionSourceGrantStore(db);
const adapter = createSessionSourceCreateAdapter(db);
const binding: SessionSourceBinding = { user_id: "user_a", network_id: "net_a", source_node_id: "node_source",
  daemon_node_id: "daemon_a", session_id: "ses_Source", binding_id: "binding_a",
  server_generation: "generation_a", canonical_directory: "/workspace/canonical", mode: "attach_existing" };
const verified = () => ({ binding, requesterTokenId: "tok_caller" });
const differentBinding = (field: keyof SessionSourceBinding): SessionSourceBinding => ({ ...binding,
  [field]: field === "mode" ? "fork_independent" : field === "session_id" ? "ses_Other" : `${binding[field]}_other` });
const count = () => db.get<{ n: number }>("SELECT COUNT(*) AS n FROM node_create_requests")!.n;
afterAll(() => db.close());

test("real create schema: wrong authority dimensions and failed authorization admit nothing", () => {
  const ref = grants.issue(binding, 1000, 2000), before = count();
  for (const field of Object.keys(binding) as (keyof SessionSourceBinding)[]) {
    const changed = differentBinding(field);
    expect(() => adapter.reserve(ref, "child", () => ({ ...verified(), binding: changed }), 1500))
      .toThrow("source_create_grant_refused");
    expect(adapter.recover(ref, () => ({ ...verified(), binding: changed }))).toBeNull();
    expect(count()).toBe(before);
  }
  expect(() => adapter.reserve(ref, "child", () => { throw Error("source_access_denied"); }, 1500)).toThrow("source_access_denied");
  for (const now of [999, 2000]) expect(() => adapter.reserve(ref, "child", verified, now)).toThrow("source_create_grant_refused");
  expect(db.get("SELECT state,create_request_id FROM session_source_grants WHERE source_ref=?1", ref))
    .toEqual({ state: "issued", create_request_id: null });
  expect(count()).toBe(before);
});

test("real INSERT failure rolls back the claim and request together", () => {
  const ref = grants.issue(binding, 1000, 2000), before = count();
  db.exec(`CREATE TRIGGER test_source_insert_failure AFTER INSERT ON node_create_requests
    WHEN NEW.child_name='fail-insert' BEGIN SELECT RAISE(ABORT, 'injected_insert_failure'); END`);
  try {
    expect(() => adapter.reserve(ref, "fail-insert", verified, 1500)).toThrow("injected_insert_failure");
    expect(count()).toBe(before);
    expect(grants.claimedRequest(ref, binding)).toBeNull();
    expect(db.get("SELECT state,create_request_id FROM session_source_grants WHERE source_ref=?1", ref))
      .toEqual({ state: "issued", create_request_id: null });
  } finally { db.exec("DROP TRIGGER test_source_insert_failure"); }
  expect(adapter.reserve(ref, "after-rollback", verified, 1500).status).toBe("source_reserved");
});

test("one real reservation, immutable non-dispatchable receipt and read-only reopen recovery", () => {
  const ref = grants.issue(binding, 1000, 2000), before = count();
  const tokens = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM api_tokens")!.n;
  const receipt = adapter.reserve(ref, "  source-child  ", verified, 1500);
  expect(count()).toBe(before + 1);
  expect(db.get("SELECT child_name,source_ref,workdir,child_token_id,flags_json,env_keys FROM node_create_requests WHERE request_id=?1", receipt.request_id))
    .toEqual({ child_name: "source-child", source_ref: ref, workdir: binding.canonical_directory,
      child_token_id: null, flags_json: "{}", env_keys: "[]" });
  expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM api_tokens")!.n).toBe(tokens);
  expect(peekPendingEnvBlob(receipt.request_id)).toBeNull();
  expect(runOrphanSweepOnce(100_000)).toEqual({ swept: 0, revoked: 0 });
  expect(finalizeCreateOnFirstRegister({ node_id: "node_unrelated", alias: "source-child", network_id: binding.network_id }))
    .toEqual({ finalized: 0, matchedIds: [] });
  expect(db.get("SELECT request_id FROM node_create_requests WHERE request_id=?1 AND status='pending'", receipt.request_id)).toBeNull();
  for (const sql of ["SET status='pending'", "SET source_ref=NULL", "SET child_token_id='tok_child'"]) {
    expect(() => db.run(`UPDATE node_create_requests ${sql} WHERE request_id=?1`, [receipt.request_id])).toThrow("source_create_immutable");
  }
  expect(() => db.run("DELETE FROM node_create_requests WHERE request_id=?1", [receipt.request_id])).toThrow("source_create_immutable");
  expect(() => db.run(`INSERT OR REPLACE INTO node_create_requests
    (request_id,daemon_node_id,child_name,network_id,runtime,flags_json,env_keys,status,created_at,created_by_token)
    VALUES (?1,'daemon_a','overwrite','net_a','opencode-cli','{}','[]','pending',1500,'tok_caller')`, [receipt.request_id]))
    .toThrow("source_create_immutable");
  expect(() => adapter.reserve(ref, "retry", verified, 1500)).toThrow("source_create_grant_refused");
  let other = new SQLiteAdapter(new Database(process.env.COMMHUB_DB!));
  try {
    expect(createSessionSourceCreateAdapter(other).recover(ref, verified)).toEqual(receipt);
    expect(() => createSessionSourceCreateAdapter(other).reserve(ref, "retry-late", verified, 3000)).toThrow("source_create_grant_refused");
    other.close(); other = new SQLiteAdapter(new Database(process.env.COMMHUB_DB!));
    const reopened = createSessionSourceCreateAdapter(other);
    const changes = other.get<{ n: number }>("SELECT total_changes() AS n")!.n;
    expect(reopened.recover(ref, verified)).toEqual(receipt);
    expect(other.get<{ n: number }>("SELECT total_changes() AS n")!.n).toBe(changes);
    for (const field of Object.keys(binding) as (keyof SessionSourceBinding)[]) {
      const changed = differentBinding(field);
      expect(reopened.recover(ref, () => ({ ...verified(), binding: changed }))).toBeNull();
    }
    expect(() => reopened.recover(ref, () => { throw Error("access_revoked"); })).toThrow("access_revoked");
  } finally { other.close(); }
  expect(count()).toBe(before + 1);
});

test("fork-independent is reserved, never executed; ordinary create row remains mutable", () => {
  const fork = { ...binding, mode: "fork_independent" as const };
  const ref = grants.issue(fork, 1000, 2000);
  const receipt = adapter.reserve(ref, "fork-child", () => ({ ...verified(), binding: fork }), 1500);
  expect(adapter.recover(ref, () => ({ ...verified(), binding: fork }))).toEqual(receipt);
  db.run(`INSERT INTO node_create_requests
    (request_id,daemon_node_id,child_name,network_id,runtime,flags_json,env_keys,status,created_at,created_by_token)
    VALUES ('cr_ordinary','daemon_a','ordinary','net_a','opencode-cli','{}','[]','pending',1500,'tok_caller')`);
  expect(db.run("UPDATE node_create_requests SET status='delivered' WHERE request_id='cr_ordinary'").changes).toBe(1);
  expect(db.get("SELECT status,source_ref FROM node_create_requests WHERE request_id='cr_ordinary'"))
    .toEqual({ status: "delivered", source_ref: null });
});

test("unsupported adapters refuse before SQL or authorization callback", () => {
  for (const props of [{ dialect: "postgres", atomicTransactions: true, transactionalFeaturesRefusal: null },
    { dialect: "sqlite", atomicTransactions: false, transactionalFeaturesRefusal: null },
    { dialect: "sqlite", transactionalFeaturesRefusal: null },
    { dialect: "sqlite", atomicTransactions: true, transactionalFeaturesRefusal: "refused" }]) {
    const unsupported = createSessionSourceCreateAdapter(props as unknown as DbAdapter);
    const noAuth = () => { throw Error("callback must not execute"); };
    expect(() => unsupported.reserve("ref", "child", noAuth)).toThrow("source_create_transactions_unsupported");
    expect(() => unsupported.recover("ref", noAuth)).toThrow("source_create_transactions_unsupported");
  }
});

test("real daemon pull handler refuses source reservation while ordinary pull still delivers", async () => {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { registerTools } = await import("./tools");
  db.run("INSERT INTO users (user_id,username,password_hash,role) VALUES ('user_a','source_owner','fixture','user')");
  db.run("INSERT INTO networks (network_id,network_name,owner_id) VALUES ('net_a','source-net','user_a')");
  db.run("INSERT INTO network_members (user_id,network_id,role) VALUES ('user_a','net_a','owner')");
  db.run(`INSERT INTO nodes (node_id,node_name,alias,network_id,owner_user_id)
    VALUES ('daemon_a','source-daemon','source-daemon','net_a','user_a')`);
  db.run(`INSERT INTO api_tokens
    (token_id,token_hash,user_id,network_id,name,scope,bound_node_id,node_identity_epoch)
    VALUES ('tok_daemon','fixture_hash','user_a','net_a','node:source-daemon','network','daemon_a',2)`);
  const handlers: Record<string, (args: any) => Promise<any>> = {};
  const server = new McpServer({ name: "source-create-test", version: "0" });
  const tool = server.tool.bind(server);
  (server as any).tool = (name: string, desc: string, schema: any, handler: any) => {
    handlers[name] = handler;
    return tool(name, desc, schema, handler);
  };
  registerTools(server, undefined, "net_a", "user_a", "source-daemon", true, "tok_daemon");
  try {
    const ref = grants.issue(binding, 1000, 2000);
    const receipt = adapter.reserve(ref, "pull-source", verified, 1500);
    const reply = JSON.parse((await handlers.get_create_request({ request_id: receipt.request_id })).content[0].text);
    expect(reply).toEqual({ ok: false, error: "request_not_pending", current_status: "source_reserved" });
    expect(adapter.recover(ref, verified)).toEqual(receipt);
    db.run(`INSERT INTO node_create_requests
      (request_id,daemon_node_id,child_name,network_id,runtime,flags_json,env_keys,status,created_at,created_by_token)
      VALUES ('cr_pull_ordinary','daemon_a','pull-ordinary','net_a','opencode-cli','{}','[]','pending',1500,'tok_caller')`);
    putPendingEnvBlob({ request_id: "cr_pull_ordinary", daemon_node_id: "daemon_a",
      env_blob: {}, child_token: "fixture_not_a_real_token", child_token_id: "tok_fixture_child" });
    const ordinary = JSON.parse((await handlers.get_create_request({ request_id: "cr_pull_ordinary" })).content[0].text);
    expect(ordinary.ok).toBe(true);
    expect(ordinary.node_spec.name).toBe("pull-ordinary");
    expect(db.get("SELECT status,source_ref FROM node_create_requests WHERE request_id='cr_pull_ordinary'"))
      .toEqual({ status: "delivered", source_ref: null });
    expect(peekPendingEnvBlob("cr_pull_ordinary")).toBeNull();
  } finally { await server.close(); }
});

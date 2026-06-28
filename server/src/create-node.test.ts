// RFC-026 v4 P1 — unit tests for state + sweeper (covers H + J live-
// test deferment per 通信牛 PR #299 review). These exercise the same
// pure functions the daemon-facing MCP tools call into; the e2e
// scenarios H/J would only re-verify these same code paths through
// multi-daemon or crash-sim plumbing, which is Phase 3 work.

import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { db } from "./db.js";
import {
  putPendingEnvBlob,
  takePendingEnvBlob,
  peekPendingEnvBlob,
  runOrphanSweepOnce,
  evictExpired,
  finalizeCreateOnFirstRegister,
  newRequestId,
  stopBackgroundTimersForTest,
} from "./create-node.js";

// ── helpers ────────────────────────────────────────────────────────
function freshFixtures() {
  // Wipe RFC-026 state between tests. Other suites use the same DB;
  // we only delete from tables RFC-026 owns.
  db.run("DELETE FROM node_create_requests");
  db.run("DELETE FROM api_tokens WHERE role = 'child' OR role = 'test_child' OR (request_id IS NOT NULL AND request_id LIKE 'cr_test_%')");
  stopBackgroundTimersForTest();
}

function insertRequestRow(
  request_id: string,
  daemon_node_id: string,
  child_name: string,
  status: "pending" | "delivered" | "succeeded" | "failed" | "expired",
  created_at_ms: number,
  child_token_id: string | null = null,
  network_id: string = "test_net",
) {
  db.run(
    `INSERT INTO node_create_requests
       (request_id, daemon_node_id, child_name, network_id, runtime, model, flags_json, env_keys, status, child_token_id, created_at, created_by_token)
     VALUES (?1, ?2, ?3, ?4, 'claude-agent-sdk', 'x', '{}', '[]', ?5, ?6, ?7, 'tok_test')`,
    [request_id, daemon_node_id, child_name, network_id, status, child_token_id, created_at_ms],
  );
}

function insertChildTokenRow(token_id: string, request_id: string) {
  db.run(
    `INSERT INTO api_tokens (token_id, token_hash, user_id, network_id, name, scope, role, request_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'child', ?7)`,
    [token_id, `hash_${token_id}`, "u_test_creator", "test_net", `node:test_child_${token_id}`, "network", request_id],
  );
}

// ── tests ──────────────────────────────────────────────────────────

beforeEach(() => freshFixtures());
afterAll(() => stopBackgroundTimersForTest());

describe("§4.4 F1 mint-stream-evict — pendingEnvBlobs Map (covers H C2)", () => {
  test("takePendingEnvBlob with WRONG daemon_node_id returns null (C2 cross-daemon guard)", () => {
    const id = newRequestId();
    putPendingEnvBlob({
      request_id: id,
      daemon_node_id: "node_daemon_A",
      env_blob: { ANTHROPIC_API_KEY: "secret-A" },
      child_token: "ntok_test_child_A",
      child_token_id: "tok_test_child_A",
    });
    // daemonB attempts to take daemonA's request → null
    expect(takePendingEnvBlob(id, "node_daemon_B")).toBeNull();
    // But the entry IS NOT consumed by the wrong-caller attempt — daemonA
    // can still take it. (Otherwise an attacker could DoS legit dispatch
    // by spamming wrong-daemon takes.)
    const blob = takePendingEnvBlob(id, "node_daemon_A");
    expect(blob).not.toBeNull();
    expect(blob!.env_blob).toEqual({ ANTHROPIC_API_KEY: "secret-A" });
    expect(blob!.child_token).toBe("ntok_test_child_A");
  });

  test("takePendingEnvBlob with RIGHT daemon_node_id evicts immediately (F1 one-shot consume)", () => {
    const id = newRequestId();
    putPendingEnvBlob({
      request_id: id,
      daemon_node_id: "node_daemon_X",
      env_blob: { K1: "v1" },
      child_token: "ntok_x",
      child_token_id: "tok_x",
    });
    expect(peekPendingEnvBlob(id)).not.toBeNull();
    expect(takePendingEnvBlob(id, "node_daemon_X")).not.toBeNull();
    // Second take is null — entry was evicted on first successful take
    expect(takePendingEnvBlob(id, "node_daemon_X")).toBeNull();
    expect(peekPendingEnvBlob(id)).toBeNull();
  });

  test("takePendingEnvBlob with unknown id returns null", () => {
    expect(takePendingEnvBlob("cr_never_existed", "node_anything")).toBeNull();
  });

  test("evictExpired drops entries past TTL", () => {
    const id = newRequestId();
    putPendingEnvBlob({
      request_id: id,
      daemon_node_id: "node_z",
      env_blob: {},
      child_token: "ntok_z",
      child_token_id: "tok_z",
    });
    // Fast-forward past 60s TTL
    const past = Date.now() + 60_001;
    expect(evictExpired(past)).toBeGreaterThan(0);
    expect(takePendingEnvBlob(id, "node_z")).toBeNull();
  });
});

describe("§4.4.8 C4 orphan sweeper — runOrphanSweepOnce (covers J F-1 + F-2)", () => {
  test("F-1: status='pending' age > TTL → revoke child-ntok + mark status='failed'", () => {
    const reqId = `cr_test_${Date.now()}_F1`;
    const tokId = `tok_test_${Date.now()}_F1`;
    const longAgo = Date.now() - 90_000;  // 90s past — well > 60s TTL
    insertChildTokenRow(tokId, reqId);
    insertRequestRow(reqId, "node_daemon_F1", "child_F1", "pending", longAgo, tokId);
    const result = runOrphanSweepOnce();
    expect(result.swept).toBeGreaterThanOrEqual(1);
    expect(result.revoked).toBeGreaterThanOrEqual(1);
    // Verify api_tokens.revoked_at is now set
    const tokRow = db.get<{ revoked_at: string | null }>(
      "SELECT revoked_at FROM api_tokens WHERE token_id = ?1", tokId,
    );
    expect(tokRow?.revoked_at).not.toBeNull();
    // Verify request status flipped to 'failed'
    const reqRow = db.get<{ status: string; error: string | null }>(
      "SELECT status, error FROM node_create_requests WHERE request_id = ?1", reqId,
    );
    expect(reqRow?.status).toBe("failed");
    expect(reqRow?.error).toContain("sweeper_revoked_before_delivery");
  });

  test("F-2: status='delivered' age > TTL → revoke child-ntok + mark status='expired'", () => {
    const reqId = `cr_test_${Date.now()}_F2`;
    const tokId = `tok_test_${Date.now()}_F2`;
    const longAgo = Date.now() - 120_000;  // 120s past
    insertChildTokenRow(tokId, reqId);
    insertRequestRow(reqId, "node_daemon_F2", "child_F2", "delivered", longAgo, tokId);
    const result = runOrphanSweepOnce();
    expect(result.swept).toBeGreaterThanOrEqual(1);
    expect(result.revoked).toBeGreaterThanOrEqual(1);
    const tokRow = db.get<{ revoked_at: string | null }>(
      "SELECT revoked_at FROM api_tokens WHERE token_id = ?1", tokId,
    );
    expect(tokRow?.revoked_at).not.toBeNull();
    const reqRow = db.get<{ status: string; error: string | null }>(
      "SELECT status, error FROM node_create_requests WHERE request_id = ?1", reqId,
    );
    expect(reqRow?.status).toBe("expired");
    expect(reqRow?.error).toContain("sweeper_revoked_after_delivery_no_ack");
  });

  test("does NOT sweep recent pending/delivered rows (within TTL)", () => {
    const reqId = `cr_test_${Date.now()}_fresh`;
    const tokId = `tok_test_${Date.now()}_fresh`;
    insertChildTokenRow(tokId, reqId);
    // created 5s ago — well within 60s TTL
    insertRequestRow(reqId, "node_daemon_fresh", "child_fresh", "pending", Date.now() - 5_000, tokId);
    const result = runOrphanSweepOnce();
    expect(result.swept).toBe(0);
    expect(result.revoked).toBe(0);
    const tokRow = db.get<{ revoked_at: string | null }>(
      "SELECT revoked_at FROM api_tokens WHERE token_id = ?1", tokId,
    );
    expect(tokRow?.revoked_at).toBeNull();
    const reqRow = db.get<{ status: string }>(
      "SELECT status FROM node_create_requests WHERE request_id = ?1", reqId,
    );
    expect(reqRow?.status).toBe("pending");
  });

  test("does NOT sweep terminal rows (succeeded/failed/expired)", () => {
    const reqId = `cr_test_${Date.now()}_terminal`;
    const tokId = `tok_test_${Date.now()}_terminal`;
    insertChildTokenRow(tokId, reqId);
    insertRequestRow(reqId, "node_daemon_t", "child_t", "succeeded", Date.now() - 120_000, tokId);
    const result = runOrphanSweepOnce();
    expect(result.swept).toBe(0);
    expect(result.revoked).toBe(0);
    const tokRow = db.get<{ revoked_at: string | null }>(
      "SELECT revoked_at FROM api_tokens WHERE token_id = ?1", tokId,
    );
    expect(tokRow?.revoked_at).toBeNull();
  });

  test("sweeper is idempotent — second run on same stale row is a no-op", () => {
    const reqId = `cr_test_${Date.now()}_idem`;
    const tokId = `tok_test_${Date.now()}_idem`;
    insertChildTokenRow(tokId, reqId);
    insertRequestRow(reqId, "node_daemon_i", "child_i", "pending", Date.now() - 120_000, tokId);
    const r1 = runOrphanSweepOnce();
    expect(r1.swept).toBe(1);
    const r2 = runOrphanSweepOnce();
    expect(r2.swept).toBe(0);   // already terminal after first sweep
  });
});

describe("§4.1.4 C2 token-bound daemon resolution regression (PR #299 BLOCKER #1)", () => {
  // The BLOCKER #1 root cause was `SELECT ... WHERE alias = ?1` in
  // daemon-facing MCP tools. The new resolveCallerDaemonTokenBound
  // helper joins on (api_tokens.token_id → name='node:<alias>' →
  // nodes.alias AND nodes.network_id = tokens.network_id), so two
  // daemons with the SAME alias in DIFFERENT networks resolve to
  // distinct rows. Below we model the SQL invariant directly: insert
  // two nodes with same alias under different networks, confirm the
  // network-scoped SELECT returns the caller's own row only.
  test("two daemons same alias different networks: SELECT correctly scopes by network_id", () => {
    db.run("DELETE FROM nodes WHERE alias IN ('daemon-shared', 'daemon-other')");
    // daemonA in netA
    db.run(
      `INSERT INTO nodes (node_id, node_name, alias, runtime, model, network_id, updated_at)
       VALUES ('node_test_daemonA', 'daemon-shared', 'daemon-shared', 'claude-agent-sdk', 'm', 'net_test_A', datetime('now'))`,
    );
    // daemonB in netB — SAME alias
    db.run(
      `INSERT INTO nodes (node_id, node_name, alias, runtime, model, network_id, updated_at)
       VALUES ('node_test_daemonB', 'daemon-shared', 'daemon-shared', 'claude-agent-sdk', 'm', 'net_test_B', datetime('now'))`,
    );

    // Token-bound resolution: a caller bound to netA must get node_test_daemonA
    const a = db.get<{ node_id: string; network_id: string }>(
      `SELECT node_id, network_id FROM nodes WHERE alias = ?1 AND network_id = ?2 LIMIT 1`,
      "daemon-shared", "net_test_A",
    );
    expect(a?.node_id).toBe("node_test_daemonA");

    const b = db.get<{ node_id: string; network_id: string }>(
      `SELECT node_id, network_id FROM nodes WHERE alias = ?1 AND network_id = ?2 LIMIT 1`,
      "daemon-shared", "net_test_B",
    );
    expect(b?.node_id).toBe("node_test_daemonB");

    // Contrast with the pre-blocker buggy form: alias-only SELECT
    // returns whichever row sqlite happened to scan first — could
    // be daemonB even when caller is netA.
    const all = db.all<{ node_id: string; network_id: string }>(
      `SELECT node_id, network_id FROM nodes WHERE alias = ?1`,
      "daemon-shared",
    );
    expect(all.length).toBe(2);  // proves alias alone is ambiguous

    db.run("DELETE FROM nodes WHERE node_id IN ('node_test_daemonA', 'node_test_daemonB')");
  });

  test("daemon B cannot take/ack daemon A's request even with same alias (Map-level guard)", () => {
    const id = newRequestId();
    putPendingEnvBlob({
      request_id: id,
      daemon_node_id: "node_legit_daemonA",
      env_blob: { ANTHROPIC_API_KEY: "s" },
      child_token: "ntok_a",
      child_token_id: "tok_a",
    });
    // daemonB-token resolves to node_id = node_attacker (different node_id)
    expect(takePendingEnvBlob(id, "node_attacker")).toBeNull();
    // Original entry still there for daemonA
    expect(takePendingEnvBlob(id, "node_legit_daemonA")).not.toBeNull();
  });
});

describe("finalizeCreateOnFirstRegister — content-match on child register", () => {
  test("matching child_name + network_id flips status='succeeded' + stamps child_node_id", () => {
    const reqId = `cr_test_${Date.now()}_finalize`;
    insertRequestRow(reqId, "node_daemon_F", "child_finalize_test", "delivered", Date.now() - 1_000, null, "test_net_finalize");
    const r = finalizeCreateOnFirstRegister({
      node_id: "node_child_real_F",
      alias: "child_finalize_test",
      network_id: "test_net_finalize",
    });
    expect(r.finalized).toBe(1);
    const row = db.get<{ status: string; child_node_id: string | null }>(
      "SELECT status, child_node_id FROM node_create_requests WHERE request_id = ?1", reqId,
    );
    expect(row?.status).toBe("succeeded");
    expect(row?.child_node_id).toBe("node_child_real_F");
  });

  test("non-matching alias is a no-op", () => {
    const reqId = `cr_test_${Date.now()}_nomatch`;
    insertRequestRow(reqId, "node_daemon_nm", "expected_alias", "pending", Date.now(), null, "test_net_nm");
    const r = finalizeCreateOnFirstRegister({
      node_id: "node_intruder",
      alias: "different_alias",
      network_id: "test_net_nm",
    });
    expect(r.finalized).toBe(0);
    const row = db.get<{ status: string }>(
      "SELECT status FROM node_create_requests WHERE request_id = ?1", reqId,
    );
    expect(row?.status).toBe("pending");
  });

  test("cross-network: same child_name in different network is a no-op (network_id mismatch)", () => {
    const reqId = `cr_test_${Date.now()}_crossnet`;
    insertRequestRow(reqId, "node_daemon_xn", "shared_name", "delivered", Date.now(), null, "test_net_A");
    const r = finalizeCreateOnFirstRegister({
      node_id: "node_evil",
      alias: "shared_name",
      network_id: "test_net_B",   // different network
    });
    expect(r.finalized).toBe(0);
  });
});

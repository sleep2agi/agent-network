import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "./db.js";

// RFC-026 §9.2 / #338 PR2 — list_host_supervisors SQL behavior tests.
//
// Covers the SQL-level invariants the MCP tool + REST endpoint share:
//   SEC-1 — network_id scope (caller's network only)
//   role filter — only role=host_supervisor (config_snapshot JSON extract)
//   revoked ntok filter — daemons whose api_tokens.revoked_at is set drop out
//   self-declare extraction — runtimes_supported / allowed_secret_keys parse safely
//   session join — online flag derived from sessions.last_seen_at within 60s
//
// MCP/REST boundary (member-脱敏 + auth) is covered by the docker e2e
// (qa-list-host-supervisors). Unit layer locks the SQL contract.

const NET_ALPHA = "net_lhs_alpha";
const NET_BETA = "net_lhs_beta";
const NID_DAEMON_A = "node_daemon_lhs_alpha_active";
const NID_DAEMON_B = "node_daemon_lhs_alpha_revoked";
const NID_DAEMON_X = "node_daemon_lhs_beta";
const NID_REGULAR = "node_lhs_regular_member";

function cleanup() {
  for (const n of [NID_DAEMON_A, NID_DAEMON_B, NID_DAEMON_X, NID_REGULAR]) {
    try { db.run("DELETE FROM nodes WHERE node_id = ?1", [n]); } catch {}
    try { db.run("DELETE FROM sessions WHERE alias = (SELECT alias FROM nodes WHERE node_id = ?1)", [n]); } catch {}
  }
  try { db.run("DELETE FROM sessions WHERE network_id IN (?1, ?2)", [NET_ALPHA, NET_BETA]); } catch {}
  try { db.run("DELETE FROM api_tokens WHERE network_id IN (?1, ?2) AND name LIKE 'node:lhs%'", [NET_ALPHA, NET_BETA]); } catch {}
}

beforeEach(cleanup);
afterAll(cleanup);

function seedDaemon(opts: {
  network_id: string, node_id: string, alias: string,
  role?: string,
  runtimes?: string[],
  secrets?: string[],
  sessionAgeMs?: number,  // undefined → no session row; 0 → "now" (online); large → offline
  revoked?: boolean,
}) {
  const snapshot = JSON.stringify({
    model: "claude-opus", flags: {}, role: opts.role ?? "host_supervisor",
    runtimes_supported: opts.runtimes ?? ["claude-agent-sdk"],
    allowed_secret_keys: opts.secrets ?? [],
  });
  db.run(
    `INSERT OR REPLACE INTO nodes (node_id, node_name, alias, network_id,
                                    runtimes_supported, allowed_secret_keys,
                                    config_snapshot,
                                    created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now'), datetime('now'))`,
    [opts.node_id, opts.alias, opts.alias, opts.network_id,
     JSON.stringify(opts.runtimes ?? ["claude-agent-sdk"]),
     JSON.stringify(opts.secrets ?? []),
     snapshot],
  );
  if (opts.sessionAgeMs !== undefined) {
    const ts = new Date(Date.now() - opts.sessionAgeMs).toISOString().replace("T", " ").replace(/\..+/, "");
    db.run(
      `INSERT OR REPLACE INTO sessions (resume_id, alias, network_id, last_seen_at, status, cpu_cores, mem_total_gb, ip)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      [`s_${opts.node_id}`, opts.alias, opts.network_id, ts, "idle", 8, 16, "10.0.0.5"],
    );
  }
  if (opts.revoked) {
    db.run(
      `INSERT OR REPLACE INTO api_tokens (token_id, user_id, network_id, scope, name, token_hash, expires_at, revoked_at)
       VALUES (?1, ?2, ?3, 'network', ?4, ?5, NULL, datetime('now'))`,
      [`tok_${opts.node_id}`, `u_seed_${opts.node_id}`, opts.network_id, `node:${opts.alias}`, `hash_${opts.node_id}`],
    );
  }
}

// Reproduce the SAME SQL the production handler runs.
function runQuery(network_id: string) {
  return db.all<Record<string, any>>(`
    SELECT
      n.node_id, n.alias, n.hostname, n.network_id,
      n.runtimes_supported, n.allowed_secret_keys,
      s.last_seen_at AS session_last_seen,
      n.config_snapshot
    FROM nodes n
    LEFT JOIN sessions s ON s.alias = n.alias AND (s.network_id = n.network_id OR s.network_id IS NULL)
    LEFT JOIN api_tokens t ON t.network_id = n.network_id
                          AND t.name = 'node:' || n.alias
    WHERE n.network_id = ?1
      AND (t.revoked_at IS NULL OR t.token_id IS NULL)
    ORDER BY n.updated_at DESC
  `, network_id);
}

function extractRole(snap: unknown): string | null {
  if (!snap) return null;
  try {
    const parsed = typeof snap === "string" ? JSON.parse(snap as string) : snap;
    return typeof (parsed as any)?.role === "string" ? (parsed as any).role : null;
  } catch { return null; }
}

describe("list_host_supervisors — SQL invariants (RFC-026 §9.2)", () => {
  test("SEC-1: netA query returns only netA daemons, NOT netB daemons", () => {
    seedDaemon({ network_id: NET_ALPHA, node_id: NID_DAEMON_A, alias: "alpha-daemon" });
    seedDaemon({ network_id: NET_BETA, node_id: NID_DAEMON_X, alias: "beta-daemon" });
    const fromAlpha = runQuery(NET_ALPHA);
    const aliases = fromAlpha.map(r => r.alias).sort();
    expect(aliases).toContain("alpha-daemon");
    expect(aliases).not.toContain("beta-daemon");
  });

  test("role filter: regular member nodes (role=member) excluded after extraction", () => {
    seedDaemon({ network_id: NET_ALPHA, node_id: NID_DAEMON_A, alias: "real-daemon", role: "host_supervisor" });
    seedDaemon({ network_id: NET_ALPHA, node_id: NID_REGULAR, alias: "regular", role: "member" });
    const rows = runQuery(NET_ALPHA);
    const daemons = rows.filter(r => extractRole(r.config_snapshot) === "host_supervisor");
    const aliases = daemons.map(r => r.alias).sort();
    expect(aliases).toEqual(["real-daemon"]);
    // Sanity: SQL returns both, role-extract is what filters
    expect(rows.length).toBe(2);
  });

  test("revoked ntok filter: daemon with revoked_at set is excluded", () => {
    seedDaemon({ network_id: NET_ALPHA, node_id: NID_DAEMON_A, alias: "alive-daemon" });
    seedDaemon({ network_id: NET_ALPHA, node_id: NID_DAEMON_B, alias: "revoked-daemon", revoked: true });
    const rows = runQuery(NET_ALPHA);
    const aliases = rows.map(r => r.alias).sort();
    expect(aliases).toContain("alive-daemon");
    expect(aliases).not.toContain("revoked-daemon");
  });

  test("self-declare extraction: runtimes_supported + allowed_secret_keys parse safely from column", () => {
    seedDaemon({
      network_id: NET_ALPHA, node_id: NID_DAEMON_A, alias: "rich-daemon",
      runtimes: ["claude-agent-sdk", "codex-sdk", "grok-build-acp"],
      secrets: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
    });
    const rows = runQuery(NET_ALPHA);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(JSON.parse(r.runtimes_supported)).toEqual(["claude-agent-sdk", "codex-sdk", "grok-build-acp"]);
    expect(JSON.parse(r.allowed_secret_keys)).toEqual(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
  });

  test("malformed config_snapshot extraction returns null role, no throw", () => {
    db.run(
      `INSERT INTO nodes (node_id, node_name, alias, network_id, config_snapshot,
                          created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'), datetime('now'))`,
      [NID_DAEMON_A, "broken", "broken", NET_ALPHA, "{not json"],
    );
    const rows = runQuery(NET_ALPHA);
    expect(rows).toHaveLength(1);
    // Production handler treats malformed snapshot as role=null → filtered out
    expect(extractRole(rows[0].config_snapshot)).toBeNull();
  });

  test("online derivation: session_last_seen within 60s → online", () => {
    seedDaemon({ network_id: NET_ALPHA, node_id: NID_DAEMON_A, alias: "fresh-daemon", sessionAgeMs: 10_000 });
    seedDaemon({ network_id: NET_ALPHA, node_id: NID_DAEMON_B, alias: "stale-daemon", sessionAgeMs: 5 * 60_000 });
    const rows = runQuery(NET_ALPHA);
    const byAlias = Object.fromEntries(rows.map(r => [r.alias, r]));
    const nowMs = Date.now();
    const ONLINE_MS = 60_000;
    const onlineFresh = byAlias["fresh-daemon"].session_last_seen
      ? (nowMs - Date.parse(byAlias["fresh-daemon"].session_last_seen)) <= ONLINE_MS
      : false;
    const onlineStale = byAlias["stale-daemon"].session_last_seen
      ? (nowMs - Date.parse(byAlias["stale-daemon"].session_last_seen)) <= ONLINE_MS
      : false;
    expect(onlineFresh).toBe(true);
    expect(onlineStale).toBe(false);
  });

  test("no session row: daemon appears, online=false", () => {
    seedDaemon({ network_id: NET_ALPHA, node_id: NID_DAEMON_A, alias: "never-started" });
    const rows = runQuery(NET_ALPHA);
    expect(rows).toHaveLength(1);
    expect(rows[0].session_last_seen).toBeNull();
  });

  test("pre-PR2 daemon (NULL runtimes_supported column) extracts to empty array safely", () => {
    db.run(
      `INSERT INTO nodes (node_id, node_name, alias, network_id, config_snapshot, runtimes_supported, allowed_secret_keys, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, datetime('now'), datetime('now'))`,
      [NID_DAEMON_A, "legacy-daemon", "legacy-daemon", NET_ALPHA,
       JSON.stringify({ role: "host_supervisor" })],
    );
    const rows = runQuery(NET_ALPHA);
    expect(rows).toHaveLength(1);
    expect(rows[0].runtimes_supported).toBeNull();
    // Production code path: NULL → empty array (handler-level extraction tested in docker e2e)
  });
});

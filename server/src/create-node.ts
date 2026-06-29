// RFC-026 v4 hub-side runtime — pendingEnvBlobs Map (F1 mint-stream-
// evict) + sweeper (C4 orphan ntok revoke) + content-match finalize
// helper (called from report_status when a child first registers).
//
// The actual MCP tools (create_node / get_create_request /
// ack_create_request) are registered in tools.ts and call into this
// module. Keeping the heavy state + sweeper here makes the tool layer
// thin + this module independently testable.

import { db, uuidv4 } from "./db.js";

// ── §4.4 F1 — pendingEnvBlobs Map ─────────────────────────────────
// In-memory ONLY. Never touches disk / never enters the SQL store.
// Daemon `get_create_request(request_id)` consumes + evicts. Untaken
// blobs are GC'd at TTL expiry.

export interface PendingEnvBlob {
  request_id: string;
  daemon_node_id: string;          // hub uses this for C2 cross-daemon check
  env_blob: Record<string, string>; // KEY → secret value (plaintext, never logged)
  child_token: string;              // freshly minted ntok_ for the child
  child_token_id: string;           // tokens.token_id for sweeper revoke
  expires_at: number;               // ms epoch
}

const TTL_MS = 60_000;                      // 60s per RFC-026 v4 §4.4
const SWEEPER_INTERVAL_MS = 30_000;         // 30s per RFC-026 v4 §4.4.8
const REAPER_TTL_MS = 60_000;               // 60s timeout for pending/delivered rows

const pendingEnvBlobs = new Map<string, PendingEnvBlob>();
let gcTimer: ReturnType<typeof setInterval> | null = null;
let sweeperTimer: ReturnType<typeof setInterval> | null = null;

export function putPendingEnvBlob(b: Omit<PendingEnvBlob, "expires_at">): void {
  pendingEnvBlobs.set(b.request_id, { ...b, expires_at: Date.now() + TTL_MS });
}

/** Get the pending env_blob for daemon. Returns null if not found OR
 *  if caller's daemon_node_id doesn't match (C2 cross-daemon guard).
 *  Atomically deletes the entry from the Map (one-shot consume). */
export function takePendingEnvBlob(
  request_id: string,
  callerDaemonNodeId: string,
): PendingEnvBlob | null {
  const b = pendingEnvBlobs.get(request_id);
  if (!b) return null;
  if (b.daemon_node_id !== callerDaemonNodeId) return null;
  if (Date.now() > b.expires_at) {
    pendingEnvBlobs.delete(request_id);
    return null;
  }
  pendingEnvBlobs.delete(request_id);  // §4.4 evict immediately
  return b;
}

/** Test/diagnostic helper — does NOT consume. */
export function peekPendingEnvBlob(request_id: string): PendingEnvBlob | null {
  return pendingEnvBlobs.get(request_id) || null;
}

export function evictExpired(now = Date.now()): number {
  let evicted = 0;
  for (const [k, v] of pendingEnvBlobs) {
    if (now > v.expires_at) {
      pendingEnvBlobs.delete(k);
      evicted++;
    }
  }
  return evicted;
}

export function startPendingEnvGcTimer(): void {
  if (gcTimer) return;
  gcTimer = setInterval(() => {
    const n = evictExpired();
    if (n > 0) console.log(`[create-node] GC: evicted ${n} expired env_blob(s)`);
  }, 5_000);
  (gcTimer as any).unref?.();
}

// ── §4.4.8 C4 — orphan ntok revoke sweeper ────────────────────────
// Scans `node_create_requests` for non-terminal rows older than
// REAPER_TTL_MS. Atomically marks request as failed/expired AND
// revokes the matching api_tokens.row (via request_id link) so the
// orphan child-ntok cannot be used by anyone who scraped it.

export function runOrphanSweepOnce(now = Date.now()): { swept: number; revoked: number } {
  const cutoffAge = REAPER_TTL_MS;
  const cutoffMs = now - cutoffAge;
  // Two cohorts (per RFC §4.4.8 case table):
  //  F-1 status='pending'   age > TTL → hub crashed before daemon get
  //  F-2 status='delivered' age > TTL → daemon got blob but never ack'd
  const stale = db.all<{ request_id: string; status: string; child_token_id: string | null }>(
    `SELECT request_id, status, child_token_id
       FROM node_create_requests
      WHERE status IN ('pending', 'delivered')
        AND created_at < ?1`,
    cutoffMs,
  );
  if (stale.length === 0) return { swept: 0, revoked: 0 };

  let swept = 0; let revoked = 0;
  // SQLite Bun driver doesn't expose BEGIN/COMMIT cleanly across the
  // wrapper here; fold per-row into a transaction.
  try {
    db.exec("BEGIN");
    for (const row of stale) {
      // Revoke the child-ntok first (sweeper is server-side ground
      // truth per §4.4.8). If child_token_id null somehow, skip
      // revoke (request never made it that far) but still mark
      // failed.
      if (row.child_token_id) {
        // db.run returns the SQLite adapter's RunResult (changes counter
        // if driver-supported). Only count a revoke when the UPDATE
        // actually touched a row — under the bun:sqlite adapter the
        // changes prop is reliable; on adapters returning undefined we
        // fall back to a post-UPDATE SELECT to confirm revoked_at IS
        // NOT NULL (DB is ground truth). Avoids over-counting when
        // child_token_id is stale or already revoked. (通信龙 nit 2)
        const r = db.run(
          `UPDATE api_tokens SET revoked_at = datetime('now') WHERE token_id = ?1 AND revoked_at IS NULL`,
          [row.child_token_id],
        );
        const changes = (r as any)?.changes;
        if (typeof changes === "number") {
          if (changes > 0) revoked++;
        } else {
          // Adapter didn't report; verify via SELECT
          const after = db.get<{ revoked_at: string | null }>(
            `SELECT revoked_at FROM api_tokens WHERE token_id = ?1`, row.child_token_id,
          );
          if (after?.revoked_at) revoked++;
        }
      }
      const newStatus = row.status === "pending" ? "failed" : "expired";
      const err = row.status === "pending" ? "sweeper_revoked_before_delivery" : "sweeper_revoked_after_delivery_no_ack";
      db.run(
        `UPDATE node_create_requests SET status = ?1, error = ?2, acked_at = ?3 WHERE request_id = ?4 AND status IN ('pending', 'delivered')`,
        [newStatus, err, now, row.request_id],
      );
      // Also drop any lingering env_blob (defense; should already be
      // gone for delivered, but pending could leak if GC hasn't run).
      pendingEnvBlobs.delete(row.request_id);
      swept++;
    }
    db.exec("COMMIT");
  } catch (e: any) {
    try { db.exec("ROLLBACK"); } catch { /* swallow */ }
    console.warn(`[create-node] sweeper transaction failed: ${e?.message || e}`);
    return { swept: 0, revoked: 0 };
  }
  if (swept > 0) {
    console.log(`[commhub] ✓ create-node sweeper: swept ${swept} stale request(s), revoked ${revoked} child-ntok(s)`);
    auditCreateNode({
      action: "create_node_sweeper_revoked",
      detail: { swept, revoked, sweeper_run_at_ms: now },
    });
  }
  return { swept, revoked };
}

export function startSweeperTimer(): void {
  if (sweeperTimer) return;
  // Boot-time sweep: catch any rows left over from a prior process
  // crash (case F-1: hub crashed after mint, before daemon get).
  try { runOrphanSweepOnce(); } catch (e: any) {
    console.warn(`[create-node] boot sweeper failed: ${e?.message || e}`);
  }
  sweeperTimer = setInterval(() => {
    try { runOrphanSweepOnce(); }
    catch (e: any) { console.warn(`[create-node] periodic sweeper failed: ${e?.message || e}`); }
  }, SWEEPER_INTERVAL_MS);
  (sweeperTimer as any).unref?.();
}

export function stopBackgroundTimersForTest(): void {
  if (gcTimer) { clearInterval(gcTimer); gcTimer = null; }
  if (sweeperTimer) { clearInterval(sweeperTimer); sweeperTimer = null; }
  pendingEnvBlobs.clear();
}

// ── content-match finalize on child first register ────────────────
// Called from tools.ts report_status handler when a node registers (or
// re-registers). If there's a pending node_create_requests row whose
// `child_name` matches the incoming alias AND the daemon_node_id is
// in caller's network, mark it succeeded and stamp the real
// child_node_id. Mirrors RFC-024 finalizePendingMatchingUpdates.

export function finalizeCreateOnFirstRegister(
  incoming: { node_id: string; alias: string; network_id: string | null },
): { finalized: number; matchedIds: string[] } {
  if (!incoming.node_id || !incoming.alias) return { finalized: 0, matchedIds: [] };
  const net = incoming.network_id ?? "default";
  const pending = db.all<{ request_id: string; daemon_node_id: string }>(
    `SELECT request_id, daemon_node_id FROM node_create_requests
      WHERE child_name = ?1 AND network_id = ?2 AND status IN ('delivered', 'pending')
      ORDER BY created_at ASC`,
    incoming.alias, net,
  );
  if (pending.length === 0) return { finalized: 0, matchedIds: [] };

  const matchedIds: string[] = [];
  for (const row of pending) {
    const r = db.run(
      `UPDATE node_create_requests
          SET status = 'succeeded', child_node_id = ?1, acked_at = ?2
        WHERE request_id = ?3 AND status IN ('delivered', 'pending')`,
      [incoming.node_id, Date.now(), row.request_id],
    );
    matchedIds.push(row.request_id);
    console.log(`[commhub] ✓ create-node finalize: request=${row.request_id} child=${incoming.alias} (${incoming.node_id}) daemon=${row.daemon_node_id}`);
    auditCreateNode({
      action: "create_node_succeeded",
      network_id: net,
      target_id: row.request_id,
      detail: { child_node_id: incoming.node_id, child_alias: incoming.alias, daemon_node_id: row.daemon_node_id },
    });
  }
  return { finalized: matchedIds.length, matchedIds };
}

export function newRequestId(): string {
  return `cr_${uuidv4()}`;
}

// §4.1.4 C2 — resolve the caller daemon's node row by **token-bound
// identity** (PR #299 BLOCKER #1). Module-level so unit tests can
// import + call directly (per 通信龙 nit 1 — don't inline-mirror SQL
// in tests; that's exactly the helper-drift anti-pattern the tools.ts
// comment warns against).
export type DaemonResolveResult =
  | { ok: true; daemonNodeId: string; daemonAlias: string; networkId: string }
  | { ok: false; error: string };

export function resolveCallerDaemonTokenBound(opts: {
  callerTokenIsNetwork: boolean;
  callerTokenId: string | null | undefined;
  enforceNetworkId: string | null | undefined;
}): DaemonResolveResult {
  if (!opts.callerTokenIsNetwork || !opts.callerTokenId) {
    return { ok: false, error: "caller_not_a_daemon" };
  }
  if (!opts.enforceNetworkId) {
    return { ok: false, error: "caller_not_a_daemon" };
  }
  const tokRow = db.get<{ name: string; network_id: string | null }>(
    `SELECT name, network_id FROM api_tokens WHERE token_id = ?1 AND revoked_at IS NULL`,
    opts.callerTokenId,
  );
  if (!tokRow || !tokRow.name || !tokRow.name.startsWith("node:")) {
    return { ok: false, error: "caller_not_a_daemon" };
  }
  if (tokRow.network_id !== opts.enforceNetworkId) {
    return { ok: false, error: "caller_not_a_daemon" };
  }
  const tokenAlias = tokRow.name.slice(5);
  const nodeRow = db.get<{ node_id: string; alias: string; network_id: string }>(
    `SELECT node_id, alias, network_id FROM nodes WHERE alias = ?1 AND network_id = ?2 LIMIT 1`,
    tokenAlias, tokRow.network_id,
  );
  if (!nodeRow) {
    return { ok: false, error: "caller_not_a_daemon" };
  }
  return {
    ok: true,
    daemonNodeId: nodeRow.node_id,
    daemonAlias: nodeRow.alias,
    networkId: nodeRow.network_id,
  };
}

// RFC-026 §4.5 — append a row to audit_log for every create_node
// lifecycle event. Best-effort: never throw out (calling tool should
// continue even if audit insert fails for any reason).
export function auditCreateNode(input: {
  action:
    | "create_node_dispatched"
    | "create_node_rejected"
    | "create_node_succeeded"
    | "create_node_sweeper_revoked"
    | "daemon_capability_lied"                  // RFC-026 §9.3 D2 — daemon declared runtime support, child died before serving
    // RFC-027 §4.5 — stop/delete lifecycle audit action enum extension.
    // Re-using auditCreateNode is fine: the action column carries the
    // discriminator; target_type stays 'node_create_request' which is a
    // misnomer for stop/delete rows but updating the schema would force a
    // wider migration (see P1.1 issue).
    | "stop_node_dispatched"
    | "stop_node_completed"
    | "delete_node_dispatched"
    | "delete_node_completed"
    | "forced_stop_with_in_flight"
    | "backup_purged";
  user_id?: string | null;
  username?: string | null;
  network_id?: string | null;
  target_id?: string | null;   // request_id
  detail: Record<string, unknown>;
}): void {
  try {
    db.run(
      `INSERT INTO audit_log (user_id, username, action, target_type, target_id, detail, network_id)
       VALUES (?1, ?2, ?3, 'node_create_request', ?4, ?5, ?6)`,
      [
        input.user_id || null,
        input.username || null,
        input.action,
        input.target_id || null,
        JSON.stringify(input.detail),
        input.network_id || null,
      ],
    );
  } catch (e: any) {
    console.warn(`[commhub] audit_log insert (create_node) failed: ${e?.message || e}`);
  }
}

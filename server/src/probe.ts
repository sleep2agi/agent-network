// RFC-028 P1 §2.5 — hub-side probe state (pendingProbeSecrets Map +
// orphan revoke sweeper + finalize helper). MCP tools register in
// tools.ts (calls into here).
//
// Mirrors RFC-026 §4.4 mint-stream-evict pattern:
//  - hub creates probe row (metadata only) + stashes decrypted secret
//    + child fetcher params in in-memory Map (TTL 60s)
//  - daemon get_probe_request takes (one-shot consume + evict)
//  - daemon ack_probe_request → hub deriveErrorLabel + final row write
//  - sweeper revokes orphan rows + tokens (P2 not needed since probe
//    doesn't mint long-lived tokens — short-window only)

import { db, uuidv4 } from "./db.js";
import { vaultGet, VaultError } from "./vault.js";
import {
  validateBaseUrl, deriveErrorLabel, rejectIfSecretLeaked,
  ProbeAckPayloadSchema, type ProbeAckPayload,
  ProbeValidationError,
} from "./probe-validate.js";

// ── Probe ephemeral state Map (F1 mint-stream-evict, RFC-028 §2.5) ──

export interface PendingProbeSecret {
  probe_id: string;
  daemon_node_id: string;          // C2 cross-daemon guard
  provider_id: string;
  vendor: string;
  base_url: string;
  model_name: string;
  api_key: string;                  // plaintext, ephemeral, never persisted
  network_id: string;
  expires_at: number;
}

const TTL_MS = 60_000;
const SWEEPER_INTERVAL_MS = 30_000;
const REAPER_TTL_MS = 60_000;

const pendingProbeSecrets = new Map<string, PendingProbeSecret>();
let _gcTimer: ReturnType<typeof setInterval> | null = null;
let _sweeperTimer: ReturnType<typeof setInterval> | null = null;

export function putPendingProbeSecret(b: Omit<PendingProbeSecret, "expires_at">): void {
  pendingProbeSecrets.set(b.probe_id, { ...b, expires_at: Date.now() + TTL_MS });
}

/** Caller-bound one-shot consume. Returns null if not found, wrong
 *  daemon, or expired; entry deleted on success. */
export function takePendingProbeSecret(probe_id: string, callerDaemonNodeId: string): PendingProbeSecret | null {
  const b = pendingProbeSecrets.get(probe_id);
  if (!b) return null;
  if (b.daemon_node_id !== callerDaemonNodeId) return null;   // wrong-caller probe: DON'T evict
  if (Date.now() > b.expires_at) { pendingProbeSecrets.delete(probe_id); return null; }
  pendingProbeSecrets.delete(probe_id);
  return b;
}

export function peekPendingProbeSecret(probe_id: string): PendingProbeSecret | null {
  return pendingProbeSecrets.get(probe_id) || null;
}

export function evictExpiredProbeSecrets(now = Date.now()): number {
  let n = 0;
  for (const [k, v] of pendingProbeSecrets) {
    if (now > v.expires_at) { pendingProbeSecrets.delete(k); n++; }
  }
  return n;
}

export function startPendingProbeGcTimer(): void {
  if (_gcTimer) return;
  _gcTimer = setInterval(() => {
    const n = evictExpiredProbeSecrets();
    if (n > 0) console.log(`[probe] GC: evicted ${n} expired probe secret(s)`);
  }, 5_000);
  (_gcTimer as any).unref?.();
}

export function stopBackgroundProbeTimersForTest(): void {
  if (_gcTimer) { clearInterval(_gcTimer); _gcTimer = null; }
  if (_sweeperTimer) { clearInterval(_sweeperTimer); _sweeperTimer = null; }
  pendingProbeSecrets.clear();
}

// ── Sweeper: terminal-transition probe_results rows that never got ack ──
// Mirrors RFC-026 §4.4.8 — probe rows older than REAPER_TTL_MS that
// are still status='pending' get marked timeout + error_label set.

export function runOrphanProbeSweepOnce(now = Date.now()): { swept: number } {
  const cutoffMs = now - REAPER_TTL_MS;
  const stale = db.all<{ probe_id: string }>(
    `SELECT probe_id FROM probe_results WHERE status = 'pending' AND probed_at < ?1`,
    cutoffMs,
  );
  if (stale.length === 0) return { swept: 0 };

  let swept = 0;
  try {
    db.exec("BEGIN");
    for (const row of stale) {
      db.run(
        `UPDATE probe_results SET status = ?1, error_label = ?2 WHERE probe_id = ?3 AND status = 'pending'`,
        ["timeout", "连通性测试超时 (sweeper: 60s 无 daemon ack)", row.probe_id],
      );
      pendingProbeSecrets.delete(row.probe_id);
      swept++;
    }
    db.exec("COMMIT");
  } catch (e: any) {
    try { db.exec("ROLLBACK"); } catch { /* ok */ }
    console.warn(`[probe] sweeper failed: ${e?.message || e}`);
    return { swept: 0 };
  }
  if (swept > 0) console.log(`[commhub] ✓ probe sweeper: swept ${swept} stale probe(s)`);
  return { swept };
}

export function startProbeSweeperTimer(): void {
  if (_sweeperTimer) return;
  try { runOrphanProbeSweepOnce(); }
  catch (e: any) { console.warn(`[probe] boot sweeper failed: ${e?.message || e}`); }
  _sweeperTimer = setInterval(() => {
    try { runOrphanProbeSweepOnce(); }
    catch (e: any) { console.warn(`[probe] periodic sweeper failed: ${e?.message || e}`); }
  }, SWEEPER_INTERVAL_MS);
  (_sweeperTimer as any).unref?.();
}

// ── Helpers ─────────────────────────────────────────────────────────

export function newProbeId(): string {
  return `pr_${uuidv4()}`;
}

/** Hub-side: receive daemon ack, validate, redact, derive label, write
 *  final row. Returns the persisted row OR throws ProbeValidationError. */
export function finalizeProbeAck(
  rawAck: unknown,
  caller: { network_id: string; daemon_node_id: string },
): { ok: boolean; error_label: string | null; status: string } {
  // 1. Schema parse — rejects extra fields via .strict()
  const ack = ProbeAckPayloadSchema.parse(rawAck);
  // 2. Pull the row (existence + caller binding)
  const row = db.get<{ probe_id: string; daemon_node_id: string; provider_id: string; status: string }>(
    `SELECT probe_id, daemon_node_id, provider_id, status FROM probe_results WHERE probe_id = ?1`,
    ack.probe_id,
  );
  if (!row) throw new ProbeValidationError("probe_not_found", { probe_id: ack.probe_id });
  if (row.daemon_node_id !== caller.daemon_node_id) {
    throw new ProbeValidationError("not_your_probe", { probe_id: ack.probe_id });
  }
  if (row.status !== "pending") {
    throw new ProbeValidationError("probe_not_pending", { current_status: row.status });
  }
  // 3. Belt-and-suspenders secret-leak guard on full ack JSON
  //    (catches daemon impl bug stuffing secret into probe_id etc.)
  try {
    const providerRow = db.get<{ secret_key_ref: string }>(
      `SELECT secret_key_ref FROM providers WHERE provider_id = ?1 AND network_id = ?2`,
      row.provider_id, caller.network_id,
    );
    if (providerRow) {
      const secretVal = vaultGet(caller.network_id, providerRow.secret_key_ref);
      if (secretVal) {
        rejectIfSecretLeaked(JSON.stringify(ack), [secretVal]);
      }
    }
  } catch (e) {
    if (e instanceof ProbeValidationError && e.code === "ack_secret_leak") {
      // audit-log this serious event (impl pattern below in tools.ts)
      console.warn(`[probe] ack_secret_leak: daemon=${caller.daemon_node_id} probe=${ack.probe_id} reason=${JSON.stringify(e.detail)}`);
      // mark row as failed for safety
      db.run(
        `UPDATE probe_results SET status = 'tls_error', error_label = ?1 WHERE probe_id = ?2 AND status = 'pending'`,
        ["内部安全异常: daemon ack 含 secret 值, 已拒并 audit", ack.probe_id],
      );
      throw e;
    }
    // VaultError (missing key etc.) — non-fatal, skip leak guard but log
    if (e instanceof VaultError) {
      console.warn(`[probe] leak-guard skipped (vault read failed): ${e.message}`);
    } else {
      throw e;
    }
  }

  // 4. Derive error_label from enum + raw_status_code
  const label = deriveErrorLabel(ack);
  // 5. Final write
  db.run(
    `UPDATE probe_results
       SET status = ?1, latency_ms = ?2, raw_status_code = ?3, error_label = ?4
     WHERE probe_id = ?5 AND status = 'pending'`,
    [ack.status, ack.latency_ms, ack.raw_status_code ?? null, label, ack.probe_id],
  );
  return { ok: true, status: ack.status, error_label: label };
}

// Re-export validate funcs for tools.ts convenience
export { validateBaseUrl, ProbeValidationError };

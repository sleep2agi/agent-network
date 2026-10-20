import { z } from 'zod/v4';
import type { DbAdapter } from './db-adapter.js';
const coord = z.string().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/).nullable();
export const executionReceiptSchema = z.object({
  protocol: z.literal(1), request_id: coord, child_node_id: coord,
  child_alias: coord, operation: z.enum(['start','stop','create']),
  session_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).nullable(),
  observed_at: z.number().int().nonnegative(),
  process: z.object({ pid: z.number().int().positive().nullable(),
    state: z.enum(['present','absent','unknown']),
    start_ticks: z.string().max(32).regex(/^\d+$/).nullable(),
    boot_id: z.string().regex(/^[a-f0-9-]{36}$/).nullable(),
    executable_sha256: hash }).strict(),
  process_role: z.enum(['none','recorded-child','launcher']),
  wrapper_sha256: hash, tui_sha256: hash,
  consumer_ready: z.literal('unknown'),
  failure: z.enum(['legacy_execution_unsupported','main_process_not_started',
    'process_evidence_unavailable','execution_failed','execution_outcome_unknown']).nullable(),
}).strict();
export type ExecutionReceipt = z.infer<typeof executionReceiptSchema>;
const ACTION = 'host_execution_receipt_v1';
export const executionReceiptSupported = (db: DbAdapter) => db.atomicTransactions === true && db.transactionalFeaturesRefusal === null;
export function readExecutionReceipt(db: DbAdapter, requestId: string, networkId: string): ExecutionReceipt | null {
  const row = db.get<{detail:string}>(`SELECT detail FROM audit_log WHERE action=?1 AND target_id=?2 AND network_id=?3 ORDER BY id DESC LIMIT 1`, ACTION, requestId, networkId);
  if (!row) return null;
  try { const p = executionReceiptSchema.safeParse(JSON.parse(row.detail)); return p.success ? p.data : null; } catch { return null; }
}
export function validateExecutionReceipt(db: DbAdapter, raw: unknown,
  expected: {requestId:string; nodeId:string; alias:string; networkId:string; operation:string}, status: string, childPid?: number) {
  if (raw === undefined) return { ok: true as const, receipt: null };
  const p = executionReceiptSchema.safeParse(raw);
  if (!executionReceiptSupported(db) || !p.success) return {ok:false as const,error:'execution_receipt_invalid'};
  const r = p.data;
  if (r.request_id !== expected.requestId || r.child_node_id !== expected.nodeId || r.child_alias !== expected.alias || r.operation !== expected.operation)
    return {ok:false as const,error:'execution_receipt_target_mismatch'};
  const observedStart = r.process.state === 'present' && !r.failure && !!r.process.start_ticks
    && !!r.process.boot_id && !!r.process.executable_sha256 && r.process.pid === childPid;
  const unknownStart = r.process.state === 'unknown' && r.failure === 'process_evidence_unavailable'
    && r.process.pid === childPid && r.process.start_ticks === null && r.process.executable_sha256 === null;
  if (status === 'starting' || (status === 'started' && !observedStart && !unknownStart)
      || (status === 'stopped' && r.process.state === 'present') || (!['started','stopped'].includes(status) && !r.failure))
    return {ok:false as const,error:'execution_receipt_outcome_mismatch'};
  const previous = readExecutionReceipt(db, expected.requestId, expected.networkId);
  if (previous && JSON.stringify(previous) !== JSON.stringify(r)) return {ok:false as const,error:'execution_receipt_conflict'};
  return {ok:true as const,receipt:r};
}
/** Inside the existing request finalization transaction, after recipient checks. */
export function saveExecutionReceipt(db: DbAdapter, r: ExecutionReceipt | null, networkId: string, actor: string) {
  if (!r || readExecutionReceipt(db, r.request_id, networkId)) return;
  db.run(`INSERT INTO audit_log(action,username,network_id,target_id,detail,target_type) VALUES(?1,?2,?3,?4,?5,'host_execution_request')`,
    [ACTION, actor, networkId, r.request_id, JSON.stringify(r)]);
}
export function executionProjection(db: DbAdapter, requestId:string, networkId:string, status:string) {
  const receipt = readExecutionReceipt(db, requestId, networkId);
  return { command_status: status, host_receipt: receipt,
    process_observation: receipt?.process.state ?? 'unknown',
    consumer_ready: 'unknown' as const };
}
/** Legacy channel has no exit-75 handler/supervisor contract. A claimed bit or
 * live heartbeat cannot manufacture that capability. */
export function legacyRestartUnsupported(db: DbAdapter, node: {node_id:string; runtime?:string|null; network_id?:string|null}) {
  return ['claude-code','claude-code-cli'].includes(node.runtime ?? '') || db.get<{agent:string}>(
    `SELECT agent FROM sessions WHERE node_id=?1 AND ((network_id=?2) OR (network_id IS NULL AND ?2 IS NULL)) ORDER BY updated_at DESC LIMIT 1`, node.node_id, node.network_id ?? null)?.agent === 'claude-code';
}

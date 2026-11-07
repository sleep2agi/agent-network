import { randomUUID } from "node:crypto";
import { db } from "./db";
import { resolveToken } from "./auth";
import { readSessionControlCredential } from "./node-session-control";
import { resolveNodeCaller } from "./create-node";
import { canRestWriteNetwork } from "./network-scope";
import { createSessionSourceIssuer } from "./session-source-issuer";
import type { createSessionSourceEvidenceQueue } from "./session-source-evidence";
import { isSourceExecutionTask, isSourceExecutionResult, type SourceExecutionTask, type SourceExecutionResult } from "../../contracts/session-source-execution";

type Row = { execution_id: string; admission_request_id: string; task_json: string; user_id: string;
  requester_token_id: string; daemon_token_id: string; state: string; result_json: string | null };
const auth = (req: Request) => resolveToken(req.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1] ?? "");
/** Separate source-aware journal. No mutation of source_reserved, no ordinary
 * daemon event/fallback. Constructor remains opt-in and no endpoints register. */
export function createSessionSourceExecutionQueue(evidenceQueue: ReturnType<typeof createSessionSourceEvidenceQueue>, options: { enabled?: boolean } = {}) {
  const issuer = createSessionSourceIssuer();
  const row = (id: string) => db.get<Row>("SELECT * FROM session_source_executions WHERE execution_id=?1", id);
  const task = (r: Row): SourceExecutionTask | null => {
    try { const v = JSON.parse(r.task_json); return isSourceExecutionTask(v) ? v : null; } catch { return null; }
  };
  const permissions = (r: Row, t: SourceExecutionTask) => {
    const q = t.evidence.request;
    return "permissions_verified" in issuer.inspectStoredRequester(r.requester_token_id, r.user_id,
      { network_id: q.network_id, daemon_node_id: q.daemon_node_id, source_node_id: q.source_node_id, mode: q.mode });
  };
  const daemon = (req: Request, r: Row, t: SourceExecutionTask) => {
    const a = auth(req), c = a?.tokenId ? readSessionControlCredential(a.tokenId) : null;
    const n = a?.tokenId ? resolveNodeCaller(a.tokenId) : null, q = t.evidence.request;
    return a?.tokenId === r.daemon_token_id && c?.bound_node_id === q.daemon_node_id && c.network_id === q.network_id
      && c.scope === "network" && n?.ok && n.kind === "node" && n.nodeId === q.daemon_node_id && n.networkId === q.network_id
      && canRestWriteNetwork({ userId: c.user_id, networkId: c.network_id }, q.network_id, false);
  };
  return {
    deliverySource(req: Request, id: string) {
      if (!options.enabled) return null;
      const r = row(id), t = r ? task(r) : null, a = auth(req);
      if (!r || !t || !r.result_json || r.state !== "session_ready" || a?.tokenId !== r.requester_token_id
        || a.user.user_id !== r.user_id || !permissions(r, t)) return null;
      const v = JSON.parse(r.result_json);
      if (!isSourceExecutionResult(v, t) || v.status !== "session_ready") return null;
      if (!evidenceQueue.executionSource(req, r.admission_request_id)) return null;
      const intent = db.get<{ child_name: string }>("SELECT child_name FROM session_source_admission_intents WHERE create_request_id=?1 AND state='reserved'", r.admission_request_id);
      return intent ? { task: t, result: v, child_name: intent.child_name, daemonTokenId: r.daemon_token_id } : null;
    },
    queue(req: Request, admissionId: string): string | null {
      if (!options.enabled || db.dialect !== "sqlite" || db.atomicTransactions !== true) return null;
      const source = evidenceQueue.executionSource(req, admissionId), a = auth(req);
      if (!source || !a?.tokenId) return null;
      const t: SourceExecutionTask = { execution_id: `srcx_${randomUUID()}`, admission_request_id: admissionId,
        evidence: source.evidence, authorized_until: source.authorized_until, owner_policy: "retain_existing_bridge_only" };
      try {
        db.run(`INSERT INTO session_source_executions (execution_id,admission_request_id,task_json,user_id,requester_token_id,daemon_token_id,state)
          VALUES (?1,?2,?3,?4,?5,?6,'pending')`, [t.execution_id, admissionId, JSON.stringify(t), a.user.user_id, a.tokenId, source.daemonTokenId]);
        return t.execution_id;
      } catch { return null; } // one execution association per immutable admission
    },
    take(req: Request, id: string): SourceExecutionTask | null {
      if (!options.enabled) return null;
      return db.transaction(() => {
        const r = row(id), t = r ? task(r) : null;
        if (!r || !t || r.state !== "pending" || Date.now() >= t.authorized_until || !daemon(req, r, t) || !permissions(r, t)) return null;
        // Durable BEFORE any daemon API. Lost delivery never permits re-take.
        if (db.run("UPDATE session_source_executions SET state='claimed' WHERE execution_id=?1 AND state='pending'", [id]).changes !== 1) return null;
        return structuredClone(t);
      });
    },
    ack(req: Request, value: unknown): boolean {
      if (!options.enabled || !value || typeof value !== "object") return false;
      const r = row((value as any).execution_id), t = r ? task(r) : null;
      if (!r || !t || !isSourceExecutionResult(value, t) || !daemon(req, r, t)) return false;
      // Completion may arrive after observation expiry. Record an outcome, not
      // authorization; it cannot dispatch another operation or regain a lease.
      return db.run(`UPDATE session_source_executions SET state=?1,session_id=?2,result_json=?3
        WHERE execution_id=?4 AND state='claimed'`, [value.status, value.session_id ?? null, JSON.stringify(value), r.execution_id]).changes === 1;
    },
    recover(req: Request, id: string): SourceExecutionResult | null {
      if (!options.enabled) return null;
      const r = row(id), t = r ? task(r) : null, a = auth(req);
      if (!r || !t || a?.tokenId !== r.requester_token_id || a.user.user_id !== r.user_id || !permissions(r, t)) return null;
      if (r.result_json) { const v = JSON.parse(r.result_json); return isSourceExecutionResult(v, t) ? v : null; }
      // Read-only uncertain outcome: no reset, requeue or second POST, including
      // after Hub process restart. Claimed state itself permanently blocks take.
      return r.state === "claimed" ? { execution_id: id, admission_request_id: r.admission_request_id, status: "unknown", bridge: "not_created" } : null;
    },
  };
}

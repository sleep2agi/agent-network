import { randomUUID } from "node:crypto";
import { db } from "./db";
import { resolveToken, createNetworkTokenForNode } from "./auth";
import { putPendingEnvBlob, takePendingEnvBlob, resolveNodeCaller } from "./create-node";
import { readSessionControlCredential } from "./node-session-control";
import { parseDbTimestampMs } from "./db-timestamp";
import type { createSessionSourceExecutionQueue } from "./session-source-execution";
import { SOURCE_DELIVERY_CAPABILITY, type SourceNodeDelivery } from "./contracts/session-source-delivery";
import type { SourceExecutionTask } from "./contracts/session-source-execution";
import { createSessionSourceIssuer } from "./session-source-issuer";
import { canRestWriteNetwork } from "./network-scope";

type Row = { delivery_id: string; execution_id: string; child_node_id: string; child_name: string; token_id: string; expires_at: number; state: string;
  task_json: string; session_id: string; daemon_token_id: string };
const auth = (r: Request) => resolveToken(r.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1] ?? "");
/** Registration receipt only, shared by fork/new-project delivery. Never health. */
export function hasFreshChildRegistration(nodeId: string, networkId: string, alias: string, sessionId: string): boolean {
  const session = db.get<{ last_seen_at: string }>(`SELECT last_seen_at FROM sessions WHERE node_id=?1 AND network_id=?2
    AND alias=?3 AND session_id=?4 ORDER BY last_seen_at DESC LIMIT 1`, nodeId, networkId, alias, sessionId);
  const age = Date.now() - parseDbTimestampMs(session?.last_seen_at ?? "");
  return Number.isFinite(age) && age >= 0 && age <= 30000;
}
export function createSessionSourceDeliveryQueue(executions: ReturnType<typeof createSessionSourceExecutionQueue>, options: { enabled?: boolean } = {}) {
  const issuer = createSessionSourceIssuer();
  const row = (id: string) => db.get<Row>(`SELECT d.*,e.task_json,e.session_id,e.daemon_token_id FROM session_source_node_deliveries d
    JOIN session_source_executions e ON e.execution_id=d.execution_id WHERE d.delivery_id=?1 AND e.state='session_ready'`, id);
  const capable = (task: SourceExecutionTask) => {
    try {
      const node = db.get<{ config_snapshot: string }>("SELECT config_snapshot FROM nodes WHERE node_id=?1 AND network_id=?2", task.evidence.request.daemon_node_id, task.evidence.request.network_id);
      return JSON.parse(node?.config_snapshot ?? "{}").daemon_capabilities?.source_node_delivery === SOURCE_DELIVERY_CAPABILITY;
    } catch { return false; }
  };
  const unknown = (r: Row) => {
    db.transaction(() => {
      db.run("UPDATE session_source_node_deliveries SET state='unknown' WHERE delivery_id=?1 AND state!='registered'", [r.delivery_id]);
      db.run("UPDATE api_tokens SET revoked_at=datetime('now') WHERE token_id=?1", [r.token_id]);
    });
  };
  return {
    /** Negative-only internal orchestration cleanup; never rotates/reconstructs
     * credentials and never revokes an already confirmed registered identity. */
    abandon(id: string) {
      const r = row(id); if (!options.enabled || !r || r.state === "registered") return;
      takePendingEnvBlob(id, JSON.parse(r.task_json).evidence.request.daemon_node_id); unknown(r);
    },
    queue(req: Request, executionId: string): string | null {
      if (!options.enabled || db.dialect !== "sqlite" || db.atomicTransactions !== true) return null;
      const source = executions.deliverySource(req, executionId), a = auth(req);
      if (!source || !a?.tokenId || !capable(source.task)) return null;
      const id = `srcd_${randomUUID()}`, child = `node_${id}`, expires = Date.now() + 60_000;
      let minted: ReturnType<typeof createNetworkTokenForNode>;
      try {
        minted = db.transaction(() => {
          if (db.get("SELECT 1 FROM session_source_node_deliveries WHERE execution_id=?1", executionId)) throw Error("already_delivered");
          const t = createNetworkTokenForNode(a.user.user_id, source.task.evidence.request.network_id, source.child_name, child);
          if (!t.ok || !t.token || !t.token_id) throw Error("source_child_token_refused");
          db.run("UPDATE api_tokens SET expires_at=datetime('now','+60 seconds') WHERE token_id=?1", [t.token_id]);
          db.run(`INSERT INTO session_source_node_deliveries (delivery_id,execution_id,child_node_id,child_name,token_id,expires_at,state)
            VALUES (?1,?2,?3,?4,?5,?6,'pending')`, [id, executionId, child, source.child_name, t.token_id, expires]);
          return t;
        });
      } catch { return null; }
      // SAME in-memory one-shot mechanism as ordinary create. No plaintext SQL.
      putPendingEnvBlob({ request_id: id, daemon_node_id: source.task.evidence.request.daemon_node_id,
        child_token: minted.token!, child_token_id: minted.token_id!, env_blob: {} });
      return id;
    },
    take(req: Request, id: string, capability: string): SourceNodeDelivery | null {
      if (!options.enabled || capability !== SOURCE_DELIVERY_CAPABILITY) return null;
      const r = row(id), a = auth(req);
      if (!r || r.state !== "pending" || a?.tokenId !== r.daemon_token_id) return null;
      const t: SourceExecutionTask = JSON.parse(r.task_json), q = t.evidence.request;
      const caller = resolveNodeCaller(a.tokenId);
      if (!capable(t) || !caller.ok || caller.kind !== "node" || caller.nodeId !== q.daemon_node_id || caller.networkId !== q.network_id
        || !canRestWriteNetwork({ userId: a.user.user_id, networkId: q.network_id }, q.network_id, false)
        || !("permissions_verified" in issuer.inspectStoredRequester(q.requester_token_id, q.user_id,
          { network_id: q.network_id, daemon_node_id: q.daemon_node_id, source_node_id: q.source_node_id, mode: q.mode }))) return null;
      const token = readSessionControlCredential(r.token_id);
      if (!token || Date.now() >= r.expires_at) { unknown(r); return null; }
      const blob = takePendingEnvBlob(id, q.daemon_node_id);
      if (!blob || blob.child_token_id !== r.token_id) { unknown(r); return null; }
      if (db.run("UPDATE session_source_node_deliveries SET state='delivered' WHERE delivery_id=?1 AND state='pending'", [id]).changes !== 1) return null;
      return { delivery_id: id, execution: t, session_id: r.session_id, child_node_id: r.child_node_id,
        child_name: r.child_name, child_token: blob.child_token, expires_at: r.expires_at };
    },
    confirmRegistration(req: Request, id: string): boolean {
      if (!options.enabled) return false;
      const r = row(id), a = auth(req);
      if (!r || r.state !== "delivered" || a?.tokenId !== r.token_id) return false;
      const t: SourceExecutionTask = JSON.parse(r.task_json), caller = resolveNodeCaller(a.tokenId);
      if (!caller.ok || caller.kind !== "node" || caller.nodeId !== r.child_node_id || caller.networkId !== t.evidence.request.network_id) return false;
      if (Date.now() >= r.expires_at) { unknown(r); return false; }
      if (!hasFreshChildRegistration(r.child_node_id, caller.networkId, r.child_name, r.session_id)) return false;
      return db.transaction(() => {
        if (db.run("UPDATE session_source_node_deliveries SET state='registered' WHERE delivery_id=?1 AND state='delivered'", [id]).changes !== 1) return false;
        db.run("UPDATE api_tokens SET expires_at=NULL WHERE token_id=?1 AND revoked_at IS NULL", [r.token_id]);
        return true;
      });
    },
    recover(req: Request, id: string) {
      if (!options.enabled) return null;
      const r = row(id); if (!r || !executions.recover(req, r.execution_id)) return null;
      // An unacknowledged credential cannot be reconstructed or auto-reminted.
      if (r.state !== "registered") { takePendingEnvBlob(id, JSON.parse(r.task_json).evidence.request.daemon_node_id); unknown(r); }
      return { delivery_id: id, child_node_id: r.child_node_id, session_id: r.session_id,
        status: r.state === "registered" ? "registration_confirmed" : "unknown_rotation_required" };
    },
  };
}

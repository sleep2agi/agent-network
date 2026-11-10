import { randomBytes, randomUUID } from "node:crypto";
import { db } from "./db";
import { resolveToken } from "./auth";
import { readSessionControlCredential } from "./node-session-control";
import { resolveNodeCaller } from "./create-node";
import { canRestWriteNetwork } from "./network-scope";
import { createSessionSourceIssuer, type SourceSelection } from "./session-source-issuer";
import { createSessionSourceCreateAdapter, type SourceCreateReceipt, type VerifiedSourceCreateContext } from "./session-source-create";
import { createSessionSourceGrantStore, type SessionSourceBinding } from "./session-source-grant";
import { validateName } from "./create-node-validate";
import { isSourceReadEvidence, sameSourceChallenge, isSourceLeaseConfirmation, sameSourceRecheck,
  type SourceLeaseRecheck, type SourceReadChallenge, type SourceReadEvidence } from "./contracts/session-source-evidence";

export type SourceAdmissionReceipt = SourceCreateReceipt & {
  source_ref: string; scope: "admission_only"; intent_id: string;
  execution: { protocol: "source-aware-v1-required"; guard: "daemon_recheck_in_execution_context_required";
    lease_kind: "process_local_lease"; lease_id: string; evidence_request_id: string; recheck_request_id: string;
    authorized_until: number; mode: SourceSelection["mode"]; dispatchable: false };
};

// Internal, explicitly opt-in, process-local queue. No HTTP/MCP registration or
// SSE doorbell. No secret/config path is in a challenge. Restart loses all rows.
export function createSessionSourceEvidenceQueue(options: { enabled?: boolean } = {}) {
  const issuer = createSessionSourceIssuer();
  type Entry = { q: SourceReadChallenge; selection: SourceSelection; userId: string; tokenId: string;
    daemonTokenId?: string; evidence?: SourceReadEvidence;
    recheck?: { q: SourceLeaseRecheck; taken: boolean; confirmed: boolean } };
  const entries = new Map<string, Entry>();
  const available = (id: string) => {
    const e = entries.get(id);
    if (!options.enabled || !e || Date.now() >= e.q.expires_at) { entries.delete(id); return null; }
    const current = issuer.inspectStoredRequester(e.tokenId, e.userId, e.selection);
    const source = db.get<{ alias: string }>("SELECT alias FROM nodes WHERE node_id=?1 AND network_id=?2", e.q.source_node_id, e.q.network_id);
    if (!("permissions_verified" in current) || source?.alias !== e.q.alias) { entries.delete(id); return null; }
    return e;
  };
  const daemon = (req: Request, e: Entry): string | null => {
    const auth = resolveToken(req.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1] ?? "");
    if (!auth?.tokenId || auth.networkId !== e.q.network_id) return null;
    const c = readSessionControlCredential(auth.tokenId), n = resolveNodeCaller(auth.tokenId);
    return c?.scope === "network" && c.bound_node_id === e.q.daemon_node_id
      && n.ok && n.kind === "node" && n.nodeId === e.q.daemon_node_id && n.networkId === e.q.network_id
      && canRestWriteNetwork({ userId: c.user_id, networkId: c.network_id }, e.q.network_id, false) ? auth.tokenId : null;
  };
  const api = {
    /** Authenticated admission lookup for the source-aware execution queue only.
     * Reads immutable rows; a caller cannot provide a receipt/binding payload. */
    executionSource(req: Request, admissionId: string) {
      const row = db.get<SessionSourceBinding & { evidence_request_id: string; lease_id: string; recheck_request_id: string; authorized_until: number }>(`SELECT g.*,i.evidence_request_id,i.lease_id,i.recheck_request_id,i.authorized_until
        FROM session_source_admission_intents i JOIN node_create_requests n ON n.request_id=i.create_request_id AND n.source_ref=i.source_ref
        JOIN session_source_grants g ON g.source_ref=n.source_ref AND g.create_request_id=n.request_id
        WHERE n.request_id=?1 AND n.status='source_reserved' AND i.state='reserved' AND g.state='claimed'
        AND g.binding_id=i.recheck_request_id AND g.server_generation='process_local:' || i.lease_id
        AND n.network_id=g.network_id AND n.daemon_node_id=g.daemon_node_id AND n.workdir=g.canonical_directory
        AND i.user_id=g.user_id AND i.network_id=g.network_id
        AND i.execution_guard='daemon_recheck_in_execution_context_required'`, admissionId);
      if (!row || Date.now() >= row.authorized_until) return null;
      const evidence = api.result(req, row.evidence_request_id), e = available(row.evidence_request_id);
      if (!e?.daemonTokenId || !evidence || evidence.lease_id !== row.lease_id || row.user_id !== evidence.request.user_id
        || row.network_id !== evidence.request.network_id || row.source_node_id !== evidence.request.source_node_id
        || row.daemon_node_id !== evidence.request.daemon_node_id || row.session_id !== evidence.request.session_id
        || row.mode !== evidence.request.mode || row.canonical_directory !== evidence.canonical_directory) return null;
      return { evidence, daemonTokenId: e.daemonTokenId, authorized_until: row.authorized_until };
    },
    queue(req: Request, selection: SourceSelection, sessionId: string): SourceReadChallenge | null {
      if (!options.enabled || !/^ses_[A-Za-z0-9]{1,190}$/.test(sessionId)) return null;
      for (const [id, e] of entries) if (Date.now() >= e.q.expires_at) entries.delete(id);
      if (entries.size >= 128 || !("permissions_verified" in issuer.inspect(req, selection))) return null;
      const auth = resolveToken(req.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1] ?? "");
      if (!auth?.tokenId) return null;
      const source = db.get<{ alias: string }>("SELECT alias FROM nodes WHERE node_id=?1 AND network_id=?2", selection.source_node_id, selection.network_id);
      if (!source?.alias) return null;
      const q: SourceReadChallenge = { request_id: `srcq_${randomUUID()}`, challenge: randomBytes(32).toString("base64url"),
        network_id: selection.network_id, daemon_node_id: selection.daemon_node_id, source_node_id: selection.source_node_id,
        alias: source.alias, session_id: sessionId, expires_at: Date.now() + 15000,
        user_id: auth.user.user_id, requester_token_id: auth.tokenId, mode: selection.mode };
      entries.set(q.request_id, { q, selection: structuredClone(selection), userId: auth.user.user_id, tokenId: auth.tokenId });
      return structuredClone(q);
    },
    take(req: Request, id: string): SourceReadChallenge | null {
      const e = available(id); if (!e || e.daemonTokenId) return null;
      const tokenId = daemon(req, e); if (!tokenId) return null;
      e.daemonTokenId = tokenId;
      return structuredClone(e.q);
    },
    ack(req: Request, value: unknown): boolean {
      if (!isSourceReadEvidence(value)) return false;
      const e = available(value.request.request_id);
      if (!e || e.evidence || !e.daemonTokenId || daemon(req, e) !== e.daemonTokenId
        || !sameSourceChallenge(e.q, value.request)) return false;
      e.evidence = structuredClone(value); return true;
    },
    result(req: Request, id: string): SourceReadEvidence | null {
      const e = available(id); if (!e?.evidence) return null;
      const c = e.daemonTokenId ? readSessionControlCredential(e.daemonTokenId) : null;
      const n = e.daemonTokenId ? resolveNodeCaller(e.daemonTokenId) : null;
      if (!c || c.scope !== "network" || c.bound_node_id !== e.q.daemon_node_id || c.network_id !== e.q.network_id
        || !n?.ok || n.kind !== "node" || n.nodeId !== e.q.daemon_node_id || n.networkId !== e.q.network_id
        || !canRestWriteNetwork({ userId: c.user_id, networkId: c.network_id }, e.q.network_id, false)) return null;
      const auth = resolveToken(req.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1] ?? "");
      return auth?.user.user_id === e.userId && auth.tokenId === e.tokenId ? structuredClone(e.evidence) : null;
    },
    takeRecheck(req: Request, evidenceRequestId: string): SourceLeaseRecheck | null {
      const e = available(evidenceRequestId), r = e?.recheck;
      if (!e || !r || r.taken || Date.now() >= r.q.expires_at || daemon(req, e) !== e.daemonTokenId) return null;
      r.taken = true; return structuredClone(r.q);
    },
    ackRecheck(req: Request, value: unknown): boolean {
      if (!isSourceLeaseConfirmation(value)) return false;
      const e = available(value.request.evidence.request.request_id), r = e?.recheck;
      if (!e || !r || !r.taken || r.confirmed || Date.now() >= r.q.expires_at
        || daemon(req, e) !== e.daemonTokenId || !sameSourceRecheck(r.q, value.request)) return false;
      r.confirmed = true; return true;
    },
    /** Internal async issuer + admission. dispatchRecheck only wakes the private
     * authenticated pull/ack transport; its return value is never evidence.
     * No await, HTTP, credential mint or SSE occurs in the SQL transaction. */
    async admit(req: Request, id: string, intentId: string, name: string,
      dispatchRecheck: (evidenceRequestId: string) => Promise<void>): Promise<SourceAdmissionReceipt> {
      if (db.dialect !== "sqlite" || db.atomicTransactions !== true || db.transactionalFeaturesRefusal !== null)
        throw Error("source_create_transactions_unsupported");
      if (!/^[A-Za-z0-9_-]{1,200}$/.test(intentId)) throw Error("source_intent_invalid");
      const childName = validateName(name), evidence = api.result(req, id), e = available(id);
      if (!e || !evidence) throw Error("source_evidence_unavailable");
      const r = { q: { request_id: `srcr_${randomUUID()}`, challenge: randomBytes(32).toString("base64url"), evidence,
        intent_id: intentId, child_name: childName, expires_at: Math.min(e.q.expires_at, Date.now() + 5000) }, taken: false, confirmed: false };
      // Persist the intent before awaiting. Conflict is an explicit refusal,
      // including retries with a new evidence request or another queue instance.
      try {
        db.run(`INSERT INTO session_source_admission_intents
          (user_id,network_id,intent_id,evidence_request_id,requester_token_id,child_name,lease_id,recheck_request_id,authorized_until,execution_guard,state)
          VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'daemon_recheck_in_execution_context_required','checking')`,
          [e.userId, e.q.network_id, intentId, id, e.tokenId, childName, evidence.lease_id, r.q.request_id, r.q.expires_at]);
      } catch { throw Error("source_intent_already_associated"); }
      e.recheck = r;
      try {
        await dispatchRecheck(id);
        const revalidate = (): VerifiedSourceCreateContext => {
          const current = api.result(req, id);
          if (entries.get(id) !== e || e.recheck !== r || !r.confirmed || Date.now() >= r.q.expires_at || !current
            || !sameSourceRecheck(r.q, { ...r.q, evidence: current })) throw Error("source_lease_recheck_required");
          // This is an expiring process-local observation, not durable generation.
          return { requesterTokenId: e.tokenId, binding: { user_id: e.userId, network_id: e.q.network_id,
            daemon_node_id: e.q.daemon_node_id, source_node_id: e.q.source_node_id, session_id: e.q.session_id,
            mode: e.selection.mode, canonical_directory: evidence.canonical_directory,
            binding_id: r.q.request_id, server_generation: `process_local:${evidence.lease_id}` } };
        };
        return db.transaction(() => {
          const context = revalidate(), now = Date.now();
          const row = db.get<{ state: string }>(`SELECT state FROM session_source_admission_intents
            WHERE user_id=?1 AND network_id=?2 AND intent_id=?3 AND evidence_request_id=?4 AND requester_token_id=?5 AND child_name=?6
            AND lease_id=?7 AND recheck_request_id=?8 AND authorized_until=?9
            AND execution_guard='daemon_recheck_in_execution_context_required'`,
            e.userId, e.q.network_id, intentId, id, e.tokenId, childName, evidence.lease_id, r.q.request_id, r.q.expires_at);
          if (row?.state !== "checking") throw Error("source_intent_already_associated");
          const ref = createSessionSourceGrantStore(db).issue(context.binding, now, r.q.expires_at);
          const receipt = createSessionSourceCreateAdapter(db).reserve(ref, childName, revalidate, now);
          db.run(`UPDATE session_source_admission_intents SET state='reserved',source_ref=?1,create_request_id=?2
            WHERE evidence_request_id=?3 AND state='checking'`, [ref, receipt.request_id, id]);
          if (Date.now() >= r.q.expires_at) throw Error("source_lease_expired");
          return { ...receipt, source_ref: ref, scope: "admission_only" as const, intent_id: intentId,
            execution: { protocol: "source-aware-v1-required" as const, guard: "daemon_recheck_in_execution_context_required" as const,
              lease_kind: "process_local_lease" as const, lease_id: evidence.lease_id, evidence_request_id: id,
              recheck_request_id: r.q.request_id, authorized_until: r.q.expires_at, mode: e.selection.mode, dispatchable: false as const } };
        });
      } catch (error) {
        db.run("UPDATE session_source_admission_intents SET state='refused' WHERE evidence_request_id=?1 AND state='checking'", [id]);
        throw error;
      } finally { e.recheck = undefined; }
    },
    /** Historical, read-only lost-response recovery. No lease continuation and
     * deliberately no execution authorization, even while a daemon is live. */
    recoverAdmission(req: Request, selection: SourceSelection, intentId: string) {
      if (!options.enabled || !("permissions_verified" in issuer.inspect(req, selection))) return null;
      const auth = resolveToken(req.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1] ?? "");
      if (!auth?.tokenId) return null;
      const row = db.get<SessionSourceBinding & { source_ref: string }>(`SELECT g.* FROM session_source_admission_intents i
        JOIN session_source_grants g ON g.source_ref=i.source_ref AND g.create_request_id=i.create_request_id
        WHERE i.user_id=?1 AND i.network_id=?2 AND i.intent_id=?3 AND i.requester_token_id=?4 AND i.state='reserved'
        AND g.source_node_id=?5 AND g.daemon_node_id=?6 AND g.mode=?7`, auth.user.user_id, selection.network_id, intentId,
        auth.tokenId, selection.source_node_id, selection.daemon_node_id, selection.mode);
      if (!row) return null;
      const receipt = createSessionSourceCreateAdapter(db).recover(row.source_ref, () => {
        if (!("permissions_verified" in issuer.inspect(req, selection))) throw Error("source_auth_required");
        return { requesterTokenId: auth.tokenId!, binding: row };
      });
      return receipt ? { ...receipt, scope: "historical_admission_only" as const, execution: "not_authorized" as const, dispatchable: false as const } : null;
    },
  };
  return api;
}

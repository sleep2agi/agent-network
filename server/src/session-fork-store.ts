import type { DbAdapter } from "./db-adapter";

export type ForkEntry = {
  request_id: string; intent_id: string; operation: "fork";
  networkId: string; nodeId: string; tokenId: string; requester: string; requesterUser: string;
  session_id: string; binding_id: string; expires_at: number;
  status: "pending" | "in_progress" | "done" | "failed" | "unknown" | "expired";
  result?: { session_id: string }; error?: string;
};
const columns = `request_id,intent_id,network_id,node_id,token_id,requester_token_id,
  requester_user_id,session_id,binding_id,expires_at,status,result_session_id,error`;
function decode(r: any): ForkEntry | undefined {
  if (!r) return;
  return { request_id: r.request_id, intent_id: r.intent_id, operation: "fork",
    networkId: r.network_id, nodeId: r.node_id, tokenId: r.token_id,
    requester: r.requester_token_id, requesterUser: r.requester_user_id,
    session_id: r.session_id, binding_id: r.binding_id, expires_at: Number(r.expires_at), status: r.status,
    ...(r.result_session_id === null ? {} : { result: { session_id: r.result_session_id } }),
    ...(r.error === null ? {} : { error: r.error }) };
}

/** No token values or prompts. CAS claims never return to pending, including
 * after timeout, ACK loss, restart or another store instance reading the row. */
export function createSessionForkStore(db: DbAdapter) {
  const get = (requestId: string) => decode(db.get(`SELECT ${columns} FROM session_fork_requests WHERE request_id=?1`, requestId));
  return {
    get,
    intent(userId: string, networkId: string, intentId: string) {
      return decode(db.get(`SELECT ${columns} FROM session_fork_requests WHERE requester_user_id=?1 AND network_id=?2 AND intent_id=?3`, userId, networkId, intentId));
    },
    active(): ForkEntry[] {
      return db.all(`SELECT ${columns} FROM session_fork_requests WHERE status IN ('pending','in_progress')`).map(r => decode(r)!);
    },
    reserve(e: ForkEntry): ForkEntry {
      db.run(`INSERT INTO session_fork_requests (${columns}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'pending',NULL,NULL)
        ON CONFLICT(requester_user_id,network_id,intent_id) DO NOTHING`,
        [e.request_id,e.intent_id,e.networkId,e.nodeId,e.tokenId,e.requester,e.requesterUser,e.session_id,e.binding_id,e.expires_at]);
      return decode(db.get(`SELECT ${columns} FROM session_fork_requests WHERE requester_user_id=?1 AND network_id=?2 AND intent_id=?3`, e.requesterUser,e.networkId,e.intent_id))!;
    },
    claim(e: ForkEntry, now: number): boolean {
      return db.run(`UPDATE session_fork_requests SET status='in_progress' WHERE request_id=?1 AND status='pending' AND expires_at>?2`, [e.request_id,now]).changes === 1;
    },
    settle(e: ForkEntry, previous: "pending" | "in_progress"): ForkEntry {
      if (e.status === "pending" || e.status === "in_progress") throw Error("fork_transition_invalid");
      if (previous === "pending" && e.status !== "expired" && e.status !== "failed") throw Error("fork_transition_invalid");
      db.run(`UPDATE session_fork_requests SET status=?1,result_session_id=?2,error=?3 WHERE request_id=?4 AND status=?5`,
        [e.status,e.result?.session_id ?? null,e.error ?? null,e.request_id,previous]);
      return get(e.request_id)!;
    },
  };
}

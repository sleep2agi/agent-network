import { randomBytes } from "node:crypto";
import type { DbAdapter } from "./db-adapter";

/** Internal storage only. No HTTP/MCP issuer is enabled. A caller must obtain
 * these fields from authenticated live daemon evidence, not client input, and
 * independently enforce create_node and source-session access on every claim. */
export type SessionSourceBinding = {
  user_id: string; network_id: string; source_node_id: string; daemon_node_id: string;
  session_id: string; binding_id: string; server_generation: string; canonical_directory: string;
  mode: "attach_existing" | "fork_independent";
};
// server_generation is a legacy storage key, NOT automatically incarnation
// proof. Internal async admission uses process_local:<opaque lease> explicitly;
// such grants only reserve admission, never authorize daemon execution/restart.
const fields = ["user_id", "network_id", "source_node_id", "daemon_node_id", "session_id",
  "binding_id", "server_generation", "canonical_directory", "mode"] as const;
export const sessionSourceGrantSchema = `CREATE TABLE IF NOT EXISTS session_source_grants (
  source_ref TEXT PRIMARY KEY,
  user_id TEXT NOT NULL, network_id TEXT NOT NULL, source_node_id TEXT NOT NULL,
  daemon_node_id TEXT NOT NULL, session_id TEXT NOT NULL, binding_id TEXT NOT NULL,
  server_generation TEXT NOT NULL, canonical_directory TEXT NOT NULL, mode TEXT NOT NULL
    CHECK(mode IN ('attach_existing','fork_independent')),
  issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('issued','claimed','revoked')),
  create_request_id TEXT UNIQUE
);`;

const valid = (b: SessionSourceBinding) => fields.every(f => typeof b[f] === "string"
  && b[f].length > 0 && b[f].length <= (f === "canonical_directory" ? 4096 : 200)
  && !/[\x00-\x1f\x7f]/.test(b[f])) && /^ses_[A-Za-z0-9]+$/.test(b.session_id)
  && (b.mode === "attach_existing" || b.mode === "fork_independent");
const refValid = (ref: string) => /^src_[A-Za-z0-9_-]{43}$/.test(ref);

export function createSessionSourceGrantStore(db: DbAdapter) {
  const supported = () => db.dialect === "sqlite" && db.atomicTransactions === true
    && db.transactionalFeaturesRefusal === null;
  return {
    issue(binding: SessionSourceBinding, now: number, expiresAt: number): string {
      if (!supported() || !valid(binding) || !Number.isSafeInteger(now) || now < 0
        || !Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt - now > 60_000) {
        throw Error("session_source_grant_invalid");
      }
      const ref = `src_${randomBytes(32).toString("base64url")}`;
      db.run(`INSERT INTO session_source_grants (source_ref,${fields.join(",")},issued_at,expires_at,state)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'issued')`,
        [ref, ...fields.map(f => binding[f]), now, expiresAt]);
      return ref;
    },
    /** CAS consumes before dispatch; never unclaim on timeout/ACK loss. An
     * identical retry is also refused: recover the creation receipt separately.
     * Binding must be freshly revalidated at launch, not just when issued. */
    claim(ref: string, binding: SessionSourceBinding, createRequestId: string, now: number): boolean {
      if (!supported() || !refValid(ref) || !valid(binding) || !Number.isSafeInteger(now)
        || !/^cr_[A-Za-z0-9_-]{1,190}$/.test(createRequestId)) return false;
      return db.run(`UPDATE session_source_grants SET state='claimed',create_request_id=?1
        WHERE source_ref=?2 AND state='issued' AND issued_at<=?3 AND expires_at>?3
        AND ${fields.map((f, i) => `${f}=?${i + 4}`).join(" AND ")}
        AND NOT EXISTS (SELECT 1 FROM session_source_grants WHERE create_request_id=?1)`,
        [createRequestId, ref, now, ...fields.map(f => binding[f])]).changes === 1;
    },
    /** Read-only recovery after a lost admission response, including after the
     * grant deadline. The caller must reauthenticate and reauthorize access;
     * possession of ref or a client-supplied binding is not authority. This ID
     * is not creation/launch success and must never cause a second dispatch. */
    claimedRequest(ref: string, binding: SessionSourceBinding): string | null {
      if (!supported() || !refValid(ref) || !valid(binding)) return null;
      const row = db.get<{ create_request_id: string | null }>(
        `SELECT create_request_id FROM session_source_grants WHERE source_ref=?1 AND state='claimed'
          AND ${fields.map((f, i) => `${f}=?${i + 2}`).join(" AND ")}`,
        ref, ...fields.map(f => binding[f]));
      return row?.create_request_id ?? null;
    },
    revoke(ref: string): boolean {
      if (!supported() || !refValid(ref)) return false;
      return db.run(`UPDATE session_source_grants SET state='revoked' WHERE source_ref=?1 AND state='issued'`, [ref]).changes === 1;
    },
  };
}

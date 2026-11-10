import { randomUUID } from "node:crypto";
import type { DbAdapter } from "./db-adapter";
import { validateName } from "./create-node-validate";
import { createSessionSourceGrantStore, type SessionSourceBinding } from "./session-source-grant";

// Installed after the ordinary create-request migrations. These are durable
// tombstones, NOT an outbox. No existing daemon may pull or promote them.
export const sessionSourceCreateGuards = `
CREATE UNIQUE INDEX IF NOT EXISTS uniq_ncr_source_ref ON node_create_requests(source_ref);
-- SQLite REPLACE can bypass DELETE triggers when recursive_triggers is off.
CREATE TRIGGER IF NOT EXISTS ncr_source_replace BEFORE INSERT ON node_create_requests
WHEN EXISTS (SELECT 1 FROM node_create_requests WHERE source_ref IS NOT NULL
  AND (request_id=NEW.request_id OR source_ref=NEW.source_ref))
BEGIN SELECT RAISE(ABORT, 'source_create_immutable'); END;
CREATE TRIGGER IF NOT EXISTS ncr_source_insert BEFORE INSERT ON node_create_requests
WHEN NEW.source_ref IS NOT NULL
BEGIN
  SELECT CASE WHEN NEW.status != 'source_reserved' OR NEW.child_token_id IS NOT NULL
    OR NEW.delivered_at IS NOT NULL OR NEW.acked_at IS NOT NULL OR NEW.child_node_id IS NOT NULL
    OR NEW.launch_verified_at IS NOT NULL OR NEW.clone_json IS NOT NULL
    OR NEW.runtime != 'opencode-cli' OR NEW.env_keys != '[]' OR NEW.flags_json != '{}'
    OR NOT EXISTS (SELECT 1 FROM session_source_grants g
      WHERE g.source_ref=NEW.source_ref AND g.state='claimed' AND g.create_request_id=NEW.request_id
      AND g.network_id=NEW.network_id AND g.daemon_node_id=NEW.daemon_node_id
      AND g.canonical_directory=NEW.workdir)
    THEN RAISE(ABORT, 'source_create_not_dispatchable') END;
END;
CREATE TRIGGER IF NOT EXISTS ncr_source_update BEFORE UPDATE ON node_create_requests
WHEN OLD.source_ref IS NOT NULL OR NEW.source_ref IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'source_create_immutable'); END;
CREATE TRIGGER IF NOT EXISTS ncr_source_delete BEFORE DELETE ON node_create_requests
WHEN OLD.source_ref IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'source_create_immutable'); END;`;

export type VerifiedSourceCreateContext = {
  binding: SessionSourceBinding;
  requesterTokenId: string;
};
export type SourceCreateReceipt = { request_id: string; status: "source_reserved" };

/** Internal admission boundary only; deliberately not wired to create_node.
 * revalidate MUST synchronously enforce current create-node permission, source
 * access and the current authenticated evidence authorization using server
 * context. session-source-evidence's async admit first obtains a bounded,
 * challenge-bound daemon observation, then rechecks permissions/expiry here.
 * That observation is NOT a lock on the remote runtime: source_reserved is only
 * admission; execution requires a fresh daemon-local execution-context check.
 * Neither a grant nor a supplied binding is authorization. No network/profile/
 * secret/SSE effects in this callback. Existing synchronous callers are unchanged.
 */
export function createSessionSourceCreateAdapter(db: DbAdapter) {
  const grants = createSessionSourceGrantStore(db);
  const requireSupported = () => {
    if (db.dialect !== "sqlite" || db.atomicTransactions !== true || db.transactionalFeaturesRefusal !== null) {
      throw Error("source_create_transactions_unsupported");
    }
  };
  const context = (revalidate: () => VerifiedSourceCreateContext) => {
    const verified = revalidate();
    if (!verified || typeof verified.requesterTokenId !== "string"
      || !/^[A-Za-z0-9_-]{1,200}$/.test(verified.requesterTokenId)) {
      throw Error("source_create_auth_required");
    }
    return verified;
  };
  return {
    reserve(sourceRef: string, name: string, revalidate: () => VerifiedSourceCreateContext, now = Date.now()): SourceCreateReceipt {
      requireSupported();
      const childName = validateName(name);
      return db.transaction<SourceCreateReceipt>(() => {
        const { binding, requesterTokenId } = context(revalidate);
        const requestId = `cr_${randomUUID()}`;
        if (!grants.claim(sourceRef, binding, requestId, now)) throw Error("source_create_grant_refused");
        // No token is minted, even hashed metadata: without a durable launch
        // protocol, a restart could lose its in-memory secret and invite replay.
        // Directory comes exclusively from the freshly verified binding.
        db.run(`INSERT INTO node_create_requests
          (request_id,daemon_node_id,child_name,network_id,runtime,model,flags_json,env_keys,
           status,created_at,created_by_token,workdir,source_ref)
          VALUES (?1,?2,?3,?4,'opencode-cli',NULL,'{}','[]','source_reserved',?5,?6,?7,?8)`,
          [requestId, binding.daemon_node_id, childName, binding.network_id, now,
            requesterTokenId, binding.canonical_directory, sourceRef]);
        return { request_id: requestId, status: "source_reserved" };
      });
    },
    /** Lost ACK recovery is read-only, even after grant expiry or Hub reopen.
     * Never reserve again, mint a token, or dispatch from this receipt. */
    recover(sourceRef: string, revalidate: () => VerifiedSourceCreateContext): SourceCreateReceipt | null {
      requireSupported();
      const { binding } = context(revalidate);
      const requestId = grants.claimedRequest(sourceRef, binding);
      if (!requestId) return null;
      return db.get<SourceCreateReceipt>(`SELECT request_id,status FROM node_create_requests
        WHERE request_id=?1 AND source_ref=?2 AND status='source_reserved'`, requestId, sourceRef);
    },
  };
}

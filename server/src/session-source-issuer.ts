import { db } from "./db";
import { resolveToken, getUserNetworkRole } from "./auth";
import { canSeeAgent } from "./agent-access";
import { canRestWriteNetwork, getUserNetworkIds } from "./network-scope";
import { resolveNodeCaller } from "./create-node";
import { parseDbTimestampMs } from "./db-timestamp";
import { createSessionSourceCreateAdapter, type VerifiedSourceCreateContext } from "./session-source-create";
import type { SessionSourceBinding } from "./session-source-grant";
import { readSessionControlCredential, isHumanCredential } from "./node-session-control";
import { isOpenCodeV2CopresenceRuntime, readOpencodeSnapshotFlags } from "./config-apply-validate";

/** Routing assertions only. No binding, session, directory, URL or user proof. */
export type SourceSelection = {
  network_id: string; source_node_id: string; daemon_node_id: string;
  mode: SessionSourceBinding["mode"];
};
export type SourceIssuerCode = "source_selection_invalid" | "source_auth_required" | "source_network_forbidden"
  | "source_read_forbidden" | "insufficient_role_for_create_node" | "daemon_not_found"
  | "daemon_cannot_create_nodes" | "source_runtime_unsupported" | "source_daemon_unverified"
  | "source_daemon_mismatch" | "source_evidence_stale" | "source_evidence_unavailable";
export type SourceIssuerRefusal = { ok: false; error: SourceIssuerCode };
export class SourceIssuerError extends Error {
  constructor(public readonly code: SourceIssuerCode) { super(code); this.name = "SourceIssuerError"; }
}
type NodeRow = { node_id: string; alias: string; network_id: string; runtime: string | null; config_snapshot: string | null };
type Permissions = { selection: SourceSelection };
const fail = (error: SourceIssuerCode): SourceIssuerRefusal => ({ ok: false, error });
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const snapshot = (n: NodeRow): Record<string, any> => {
  try { const v = JSON.parse(n.config_snapshot || "{}"); return object(v) ? v : {}; } catch { return {}; }
};
function selectionValid(s: SourceSelection): boolean {
  return object(s) && Object.keys(s).every(k => ["network_id", "source_node_id", "daemon_node_id", "mode"].includes(k))
    && [s.network_id, s.source_node_id, s.daemon_node_id].every(v => typeof v === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(v))
    && (s.mode === "attach_existing" || s.mode === "fork_independent");
}

function permissions(req: Request, selection: SourceSelection): Permissions | SourceIssuerRefusal {
  if (!selectionValid(selection)) return fail("source_selection_invalid");
  // Same persisted-token authentication as session-control, without master/dev
  // fallbacks. Re-resolve on every call; no caller-supplied user/token-id proof.
  const raw = req.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1] ?? "";
  if (!raw) return fail("source_auth_required");
  const auth = resolveToken(raw);
  if (!auth?.tokenId) return fail("source_auth_required");
  return storedPermissions(auth.tokenId, auth.user.user_id, selection);
}
function storedPermissions(tokenId: string, userId: string, selection: SourceSelection): Permissions | SourceIssuerRefusal {
  if (!selectionValid(selection)) return fail("source_selection_invalid");
  const token = readSessionControlCredential(tokenId);
  if (!isHumanCredential(token) || token.user_id !== userId) return fail("source_auth_required");
  const net = selection.network_id;
  if (!getUserNetworkIds(userId).includes(net)) return fail("source_network_forbidden");
  const source = db.get<NodeRow>("SELECT node_id,alias,network_id,runtime,config_snapshot FROM nodes WHERE node_id=?1 AND network_id=?2",
    selection.source_node_id, net);
  if (!source || !canSeeAgent(userId, net, { nodeId: source.node_id, alias: source.alias })) return fail("source_read_forbidden");
  // create_node's shared write gate + exact network admin/owner rule. A Hub
  // admin outside the network does not receive a new bypass here.
  const role = getUserNetworkRole(userId, net);
  if (!canRestWriteNetwork({ userId, networkId: token.network_id }, net, false)
    || (role !== "owner" && role !== "admin")) return fail("insufficient_role_for_create_node");
  const daemon = db.get<NodeRow>("SELECT node_id,alias,network_id,runtime,config_snapshot FROM nodes WHERE node_id=?1 AND network_id=?2",
    selection.daemon_node_id, net);
  if (!daemon) return fail("daemon_not_found");
  const snap = snapshot(daemon);
  // A reported host role is necessary, not proof of Server or local ownership.
  const runtimes = snap.daemon_capabilities?.runtimes_supported;
  if (snap.role !== "host_supervisor" || snap.daemon_capabilities?.can_create_nodes === false
    || (Array.isArray(runtimes) && !runtimes.includes("opencode-cli"))) return fail("daemon_cannot_create_nodes");
  const flags = readOpencodeSnapshotFlags(source.config_snapshot);
  if (!isOpenCodeV2CopresenceRuntime(source.runtime, flags.opencodeGeneration, flags.opencodeMode)
    || snapshot(source).role === "host_supervisor") return fail("source_runtime_unsupported");
  return { selection };
}

export type SourceEvidenceRead = {
  ok: false; error: "source_evidence_unavailable";
  permissions_verified: true;
  management: "created" | "adopted";
  missing: readonly ["server_session_generation", "canonical_directory_ownership"];
};
function readEvidence(p: Permissions): SourceEvidenceRead | SourceIssuerRefusal {
  const { selection: s } = p;
  // Read actual server journal relations, not hostname, node-id prefix, profile
  // paths or client claims. Fail closed on ambiguous/conflicting management.
  const created = db.all<{ daemon_node_id: string }>(`SELECT DISTINCT daemon_node_id FROM node_create_requests
    WHERE child_node_id=?1 AND network_id=?2 AND status='succeeded' AND source_ref IS NULL
    UNION SELECT daemon_node_id FROM session_project_creates
    WHERE child_node_id=?1 AND network_id=?2 AND state='registration_confirmed'`, s.source_node_id, s.network_id);
  const adopted = db.all<{ daemon_node_id: string }>(`SELECT daemon_node_id FROM node_daemon_bindings
    WHERE node_id=?1 AND network_id=?2 AND status='active'`, s.source_node_id, s.network_id);
  const owners = new Set([...created, ...adopted].map(r => r.daemon_node_id));
  if (!owners.size) return fail("source_daemon_unverified");
  if (owners.size !== 1 || !owners.has(s.daemon_node_id)) return fail("source_daemon_mismatch");
  // Hub receipt time is a liveness prerequisite only, NOT a generation lease.
  // Immutable token binding is deliberately stricter than legacy alias fallback.
  for (const nodeId of [s.source_node_id, s.daemon_node_id]) {
    const seen = db.get<{ last_seen_at: string | null }>(`SELECT last_seen_at FROM sessions
      WHERE node_id=?1 AND network_id=?2 ORDER BY last_seen_at DESC LIMIT 1`, nodeId, s.network_id);
    const time = parseDbTimestampMs(seen?.last_seen_at ?? "");
    const age = Date.now() - time;
    if (!Number.isFinite(time) || age < 0 || age > 75_000) return fail("source_evidence_stale");
    const tokens = db.all<{ token_id: string; user_id: string }>(`SELECT t.token_id,t.user_id FROM api_tokens t JOIN users u ON u.user_id=t.user_id
      JOIN network_members m ON m.user_id=t.user_id AND m.network_id=t.network_id
      WHERE t.bound_node_id=?1 AND t.network_id=?2 AND t.scope='network' AND t.revoked_at IS NULL
      AND (t.expires_at IS NULL OR t.expires_at>datetime('now'))`, nodeId, s.network_id);
    if (!tokens.some(t => {
      const caller = resolveNodeCaller(t.token_id);
      return caller.ok && caller.kind === "node" && caller.nodeId === nodeId && caller.networkId === s.network_id
        && canRestWriteNetwork({ userId: t.user_id, networkId: s.network_id }, s.network_id, false);
    })) return fail("source_evidence_stale");
  }
  // node-session-control's node-reported process-local session/binding lease
  // has neither Server-generation authorization nor canonical directory proof.
  // Adoption workdir and config_snapshot/project_dir are not substitutes.
  return { ok: false, error: "source_evidence_unavailable", permissions_verified: true,
    management: created.length ? "created" : "adopted",
    missing: ["server_session_generation", "canonical_directory_ownership"] };
}

/** Real authentication/permission/evidence reader. No public endpoint, injectable
 * proof provider or successful fake-binding branch. Currently cannot issue a
 * grant: the daemon's independent Server/session/directory proof is absent. */
export function createSessionSourceIssuer() {
  const adapter = createSessionSourceCreateAdapter(db);
  const inspect = (req: Request, selection: SourceSelection): SourceIssuerRefusal | SourceEvidenceRead => {
    const p = permissions(req, selection);
    return "ok" in p ? p : readEvidence(p);
  };
  const revalidation = (req: Request, selection: SourceSelection): (() => VerifiedSourceCreateContext) => () => {
    const refusal = inspect(req, selection);
    throw new SourceIssuerError(refusal.error);
  };
  return {
    inspect,
    // Directory grants are explicit daemon-local authorities, not evidence that
    // this source owns any Server. Reuse only human/network/create/read gates.
    directoryPermissions(tokenId: string, userId: string, selection: SourceSelection): boolean {
      return !("ok" in storedPermissions(tokenId, userId, selection));
    },
    /** Only for a requester authenticated and frozen by an internal queue.
     * A token ID itself is NOT authentication; never expose this as an endpoint. */
    inspectStoredRequester(tokenId: string, userId: string, selection: SourceSelection) {
      const p = storedPermissions(tokenId, userId, selection);
      return "ok" in p ? p : readEvidence(p);
    },
    // No store.issue call until a real evidence reader can return an authorized
    // binding. This method returns a typed refusal rather than a bogus grant.
    issue: inspect,
    revalidation,
    reserve(req: Request, selection: SourceSelection, sourceRef: string, name: string) {
      return adapter.reserve(sourceRef, name, revalidation(req, selection));
    },
    recover(req: Request, selection: SourceSelection, sourceRef: string) {
      return adapter.recover(sourceRef, revalidation(req, selection));
    },
  };
}

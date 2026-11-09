import { randomUUID } from "node:crypto";
import { db } from "./db";
import { resolveToken } from "./auth";
import { isHumanCredential, readSessionControlCredential, resolveSessionControlNodeCaller, readSessionControlBody } from "./node-session-control";
import { createSessionSourceIssuer } from "./session-source-issuer";
import { createSessionSourceEvidenceQueue } from "./session-source-evidence";
import { createSessionSourceExecutionQueue } from "./session-source-execution";
import { createSessionSourceDeliveryQueue } from "./session-source-delivery";
import { checkNodeName } from "./shared/node-name";
import { SOURCE_DELIVERY_CAPABILITY } from "../../contracts/session-source-delivery";
import { secretTransportVerdict } from "./env-transport-policy";
import { SOURCE_DIRECTORY_CAPABILITY as DIR_CAP, isDirectoryRequestId, isDirectoryServerId, isSourceDirectorySnapshot,
  type SourceDirectoryTask, type SourceDirectorySnapshot } from "../../contracts/session-source-directory";
import { PROJECT_CREATE_CAPABILITY, SESSION_ATTACH_CAPABILITY } from "../../contracts/session-project-create";
import { createSessionProjectTransport } from "./session-project-create";
import { SOURCE_FORK_ROOT as ROOT, SOURCE_FORK_CAPABILITY as CAP, isSourceForkRequestId,
  type SourceForkTask, type SourceForkStatus, type SourceForkReceipt } from "../../contracts/session-source-transport";

type Row = { request_id: string; user_id: string; requester_token_id: string; network_id: string; intent_id: string;
  source_node_id: string; daemon_node_id: string; daemon_token_id: string; daemon_instance_id: string; session_id: string;
  child_name: string; state: SourceForkStatus; expires_at: number; evidence_id: string; execution_id: string | null;
  delivery_id: string | null; child_node_id: string | null; child_session_id: string | null };
const keys = (o: Record<string, unknown>, allowed: string[]) => Object.keys(o).every(k => allowed.includes(k));
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(v);
const terminal = (r: Row) => ["registration_confirmed", "refused", "unknown_rotation_required"].includes(r.state);
const ok = (value: object) => Response.json({ ok: true, ...value }, { headers: { "cache-control": "no-store" } });

/** Why a fork create was refused after the caller's source permissions were verified. */
export type SourceForkFailureReason = "daemon_offline" | "daemon_not_capable" | "hub_busy" | "evidence_unavailable" | "intent_reused";

/** Separate REST semantics within the existing session-control HTTP surface.
 * Secret bodies are never persisted. Original human Request lives ONLY in this
 * bounded in-memory orchestration until terminal/expiry, like pendingEnvBlobs;
 * no plaintext requester bearer is journaled or reconstructed after restart. */

export function createSessionSourceTransport(options: { enabled?: boolean; directoryEnabled?: boolean; projectEnabled?: boolean; attachEnabled?: boolean } = {}) {
  const enabled = options.enabled === true;
  const issuer = createSessionSourceIssuer(), evidence = createSessionSourceEvidenceQueue({ enabled });
  const execution = createSessionSourceExecutionQueue(evidence, { enabled });
  const delivery = createSessionSourceDeliveryQueue(execution, { enabled });
  const daemons = new Map<string, { token: string; instance: string; expires: number; retired: Set<string>; projectCreate?: boolean; sessionAttach?: boolean }>();
  type DirectoryRow = { task: SourceDirectoryTask; token: string; user: string; daemonToken: string; instance: string;
    status: "pending" | "claimed" | "ready" | "failed"; snapshot?: SourceDirectorySnapshot; parent?: string };
  const directories = new Map<string, DirectoryRow>();
  const directoryPermissions = (r: DirectoryRow) => issuer.directoryPermissions(r.token, r.user, { network_id: r.task.network_id,
    source_node_id: r.task.source_node_id, daemon_node_id: r.task.daemon_node_id, mode: "attach_existing" });
  const directoryCapable = (nodeId: string, network: string) => {
    try {
      const n = db.get<{ config_snapshot: string }>("SELECT config_snapshot FROM nodes WHERE node_id=?1 AND network_id=?2", nodeId, network);
      const s = JSON.parse(n?.config_snapshot ?? "{}");
      const channel = db.get<{ env_transport: string }>("SELECT env_transport FROM sessions WHERE node_id=?1 AND network_id=?2 ORDER BY last_seen_at DESC LIMIT 1", nodeId, network);
      return s.role === "host_supervisor" && s.daemon_capabilities?.source_directory_read === DIR_CAP
        && secretTransportVerdict(channel?.env_transport ?? null, { ANET_SECRET_TRANSPORT_GATE: "enforce", ANET_SECRET_TRANSPORT_GATE_STRICT: "1" }) === null;
    } catch { return false; }
  };
  const directoryCurrent = (r: DirectoryRow, projectSelection = false): boolean => {
    const t = r.task, d = daemons.get(`directory:${t.network_id}:${t.daemon_node_id}`), n = resolveSessionControlNodeCaller(r.daemonToken);
    return Date.now() < (projectSelection ? r.snapshot?.selection_expires_at ?? t.expires_at : t.expires_at) && !!d && d.token === r.daemonToken && d.instance === r.instance && d.expires > Date.now()
      && n?.node_id === t.daemon_node_id && n.network_id === t.network_id && directoryCapable(t.daemon_node_id, t.network_id)
      && directoryPermissions(r) && (!r.parent || (!!directories.get(r.parent) && directoryCurrent(directories.get(r.parent)!, projectSelection)));
  };
  const directoryView = (r: DirectoryRow) => ({ ...r.task, status: r.status, ...(r.snapshot ? { snapshot: r.snapshot } : {}),
    ...(r.status === "failed" ? { error: "directory_read_failed" } : {}) });
  const attachEnabled = options.directoryEnabled === true && process.env.COMMHUB_SESSION_ATTACH_PREVIEW === "1";
  const projectTransport = createSessionProjectTransport({ enabled: options.projectEnabled === true && options.directoryEnabled === true,
    attachEnabled,
    select(s, token, user) {
      const r = directories.get(s.selection_scope);
      if (!r || r.status !== "ready" || r.token !== token || r.user !== user || !r.task.server_id || !directoryCurrent(r, true)
         || typeof r.snapshot?.selection_expires_at !== "number" || r.snapshot.snapshot_id !== s.snapshot_id) return null;
       const attach = "session_id" in s;
       const parent = attach ? r.snapshot.sessions.find(v => v.session_id === s.session_id)?.project_id : s.project_id;
       if (!parent || !r.snapshot.projects.some(p => p.project_id === parent)) return null;
       return { network_id: r.task.network_id, source_node_id: r.task.source_node_id, daemon_node_id: r.task.daemon_node_id,
         daemon_token_id: r.daemonToken, daemon_instance_id: r.instance, selected_project_id: parent,
         operation_kind: attach ? "attach_existing_session" : "project_new_session" };
    },
    permissions: r => issuer.directoryPermissions(r.requester_token_id, r.user_id, { network_id: r.network_id,
      source_node_id: r.source_node_id, daemon_node_id: r.daemon_node_id, mode: "attach_existing" }),
    current(r) {
      const d = daemons.get(`directory:${r.network_id}:${r.daemon_node_id}`), n = resolveSessionControlNodeCaller(r.daemon_token_id);
      try {
        const s = JSON.parse(db.get<{ config_snapshot: string }>("SELECT config_snapshot FROM nodes WHERE node_id=?1 AND network_id=?2", r.daemon_node_id, r.network_id)?.config_snapshot ?? "{}");
         const canNew = options.projectEnabled === true && d?.projectCreate === true && s.daemon_capabilities?.project_new_session === PROJECT_CREATE_CAPABILITY;
         const canAttach = attachEnabled && d?.sessionAttach === true && s.daemon_capabilities?.session_attach === SESSION_ATTACH_CAPABILITY;
         const operationAllowed = r.operation_kind === "attach_existing_session" ? canAttach : r.source_node_id ? canNew : canNew || canAttach;
         return !!d && operationAllowed && d.token === r.daemon_token_id && d.instance === r.daemon_instance_id && d.expires > Date.now()
          && n?.node_id === r.daemon_node_id && n.network_id === r.network_id && directoryCapable(r.daemon_node_id, r.network_id)
           ;
      } catch { return false; }
    } });
  const active = new Map<string, { human: Request; release?: () => void; timer: ReturnType<typeof setTimeout> }>();
  const row = (requestId: string) => db.get<Row>("SELECT * FROM session_source_transports WHERE request_id=?1", requestId);
  const selection = (r: Row) => ({ network_id: r.network_id, source_node_id: r.source_node_id,
    daemon_node_id: r.daemon_node_id, mode: "fork_independent" as const });
  const permissions = (r: Row) => "permissions_verified" in issuer.inspectStoredRequester(r.requester_token_id, r.user_id, selection(r));
  const capable = (nodeId: string, network: string) => {
    try {
      const n = db.get<{ config_snapshot: string }>("SELECT config_snapshot FROM nodes WHERE node_id=?1 AND network_id=?2", nodeId, network);
      const s = JSON.parse(n?.config_snapshot ?? "{}");
      const channel = db.get<{ env_transport: string }>("SELECT env_transport FROM sessions WHERE node_id=?1 AND network_id=?2 ORDER BY last_seen_at DESC LIMIT 1", nodeId, network);
      return s.role === "host_supervisor" && s.daemon_capabilities?.source_node_delivery === SOURCE_DELIVERY_CAPABILITY
        && s.daemon_capabilities?.source_fork_transport === CAP && secretTransportVerdict(channel?.env_transport ?? null,
          { ANET_SECRET_TRANSPORT_GATE: "enforce", ANET_SECRET_TRANSPORT_GATE_STRICT: "1" }) === null;
    } catch { return false; }
  };
  const current = (r: Row) => {
    const d = daemons.get(`${r.network_id}:${r.daemon_node_id}`), n = resolveSessionControlNodeCaller(r.daemon_token_id);
    return Date.now() < r.expires_at && !!d && d.token === r.daemon_token_id && d.instance === r.daemon_instance_id && d.expires > Date.now()
      && n?.node_id === r.daemon_node_id && n.network_id === r.network_id && capable(r.daemon_node_id, r.network_id) && permissions(r);
  };
  const forget = (r: Row) => { const a = active.get(r.request_id); if (a) { clearTimeout(a.timer); active.delete(r.request_id); a.release?.(); } };
  const settle = (r: Row, state: "refused" | "unknown_rotation_required" | "registration_confirmed") => {
    const a = active.get(r.request_id);
    if (state === "unknown_rotation_required" && r.delivery_id) delivery.abandon(r.delivery_id);
    if (state === "unknown_rotation_required" && r.delivery_id && a) {
      const d = delivery.recover(a.human, r.delivery_id);
      if (d) db.run("UPDATE session_source_transports SET child_node_id=?1,child_session_id=?2 WHERE request_id=?3", [d.child_node_id, d.session_id, r.request_id]);
    }
    db.run("UPDATE session_source_transports SET state=?1 WHERE request_id=?2 AND state NOT IN ('registration_confirmed','refused','unknown_rotation_required')", [state, r.request_id]);
    forget(r);
  };
  const refresh = (r: Row) => {
    if (!terminal(r) && (!active.has(r.request_id) || Date.now() >= r.expires_at || !current(r))) settle(r, "unknown_rotation_required");
    return row(r.request_id)!;
  };
  const view = (r: Row): Omit<SourceForkReceipt, "ok"> => ({ request_id: r.request_id, intent_id: r.intent_id, network_id: r.network_id,
    source_node_id: r.source_node_id, daemon_node_id: r.daemon_node_id, session_id: r.session_id, mode: "fork_independent",
    child_name: r.child_name, status: r.state, expires_at: r.expires_at,
    ...(r.child_node_id ? { child_node_id: r.child_node_id } : {}), ...(r.child_session_id ? { child_session_id: r.child_session_id } : {}),
    native_acceptance: "not_verified", dispatch_scope: "gated_preview" });
  const envelope = (r: Row) => ({ request_id: r.request_id, intent_id: r.intent_id, network_id: r.network_id,
    source_node_id: r.source_node_id, daemon_node_id: r.daemon_node_id });
  function startAdmission(r: Row) {
    const a = active.get(r.request_id)!;
    void evidence.admit(a.human, r.evidence_id, r.intent_id, r.child_name, async () => {
      db.run("UPDATE session_source_transports SET state='recheck_pending' WHERE request_id=?1 AND state='evidence_claimed'", [r.request_id]);
      await new Promise<void>(resolve => { a.release = resolve; });
      if (active.get(r.request_id) !== a || !current(r)) throw Error("source_fork_changed");
    }).then(receipt => {
      const now = row(r.request_id)!;
      if (terminal(now) || !current(now)) return;
      const executionId = execution.queue(a.human, receipt.request_id);
      if (!executionId) { settle(now, "refused"); return; }
      db.run("UPDATE session_source_transports SET execution_id=?1,state='execute_pending' WHERE request_id=?2", [executionId, r.request_id]);
    }).catch(() => { const now = row(r.request_id); if (now) settle(now, "refused"); });
  }
  return async function handle(req: Request, url: URL): Promise<Response | null> {
    const projectResponse = await projectTransport(req, url); if (projectResponse) return projectResponse;
    if (url.pathname !== ROOT && !url.pathname.startsWith(`${ROOT}/`)) return null;
    const directoryPath = url.pathname === `${ROOT}/directory` || url.pathname.startsWith(`${ROOT}/directory/`);
    // `reason` is additive diagnostics for the UI (it used to show a bare "conflict" for every 409).
    // Only attached after the caller's permissions on the source are verified — see the fork create path.
    const fail = (status = 409, reason?: SourceForkFailureReason) => Response.json({ ok: false, error: directoryPath ? "source_directory_unavailable" : "source_fork_unavailable",
      ...(reason ? { reason } : {}) }, { status, headers: { "cache-control": "no-store" } });
    if (directoryPath ? options.directoryEnabled !== true : !enabled) return fail(404);
    try {
      const auth = resolveToken(req.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1] ?? "");
      if (!auth?.tokenId) return fail(401);
      const credential = readSessionControlCredential(auth.tokenId);
      const suffix = url.pathname.slice((directoryPath ? `${ROOT}/directory` : ROOT).length);
      if (directoryPath) {
        // Read-only, bounded process-memory queue using the same pin/instance
        // transport as source execution. Restart/expiry discards read scopes;
        // no mutation recovery journal or evidence/admission machine is involved.
        for (const [key, r] of directories) if (Date.now() >= (r.snapshot?.selection_expires_at ?? r.task.expires_at)) directories.delete(key);
        if (req.method === "GET") {
          const r = directories.get(suffix.slice(1));
          if (!isHumanCredential(credential) || !isDirectoryRequestId(suffix.slice(1)) || !r
            || [...url.searchParams.keys()].some(k => k !== "network_id") || url.searchParams.getAll("network_id").length !== 1
            || url.searchParams.get("network_id") !== r.task.network_id || auth.tokenId !== r.token || auth.user.user_id !== r.user
            || !directoryCurrent(r)) return fail(403);
          return ok(directoryView(r));
        }
        if (req.method !== "POST" || url.search) return fail(400);
        const b = await readSessionControlBody(req, 65536); if (!b) return fail(400);
        if (!suffix) {
          if (!isHumanCredential(credential) || !keys(b, ["network_id", "source_node_id", "daemon_node_id", "server_id", "selection_scope"])
            || !id(b.network_id) || !id(b.source_node_id) || !id(b.daemon_node_id)
            || (b.server_id !== undefined && (!isDirectoryServerId(b.server_id) || !isDirectoryRequestId(b.selection_scope)))
            || (b.server_id === undefined && b.selection_scope !== undefined)) return fail(400);
          const d = daemons.get(`directory:${b.network_id}:${b.daemon_node_id}`);
          const task: SourceDirectoryTask = { request_id: `srcdir_${randomUUID()}`, network_id: b.network_id as string,
            source_node_id: b.source_node_id as string, daemon_node_id: b.daemon_node_id as string,
            expires_at: Date.now() + 30000, ...(b.server_id ? { server_id: b.server_id as string } : {}) };
          const r: DirectoryRow = { task, token: auth.tokenId, user: auth.user.user_id, daemonToken: d?.token ?? "", instance: d?.instance ?? "", status: "pending" };
          if (!directoryCurrent(r)) return fail(403);
          if (b.server_id) {
            const parent = directories.get(b.selection_scope as string);
            if (!parent || parent.parent || parent.status !== "ready" || !directoryCurrent(parent) || parent.token !== r.token || parent.user !== r.user
              || parent.task.network_id !== task.network_id || parent.task.source_node_id !== task.source_node_id || parent.task.daemon_node_id !== task.daemon_node_id
              || parent.instance !== r.instance || !parent.snapshot?.servers.some(s => s.server_id === b.server_id)) return fail(403);
            r.parent = parent.task.request_id; task.expires_at = Math.min(task.expires_at, parent.task.expires_at);
          }
          if (directories.size >= 100) return fail();
          directories.set(task.request_id, r); return ok(directoryView(r));
        }
        const n = resolveSessionControlNodeCaller(auth.tokenId), expected: any = b.expected;
        if (!n || !expected || Object.keys(expected).length !== 2 || expected.node_id !== n.node_id || expected.network_id !== n.network_id
          || b.capability !== DIR_CAP || !directoryCapable(n.node_id, n.network_id)) return fail(403);
        const key = `directory:${n.network_id}:${n.node_id}`;
        if (suffix === "/daemon") {
           if (!keys(b, ["expected", "capability", "instance_id", "project_create_capability", "session_attach_capability"]) || typeof b.instance_id !== "string" || !/^[a-f0-9-]{36}$/.test(b.instance_id)
             || (b.project_create_capability !== undefined && b.project_create_capability !== PROJECT_CREATE_CAPABILITY)
             || (b.session_attach_capability !== undefined && b.session_attach_capability !== SESSION_ATTACH_CAPABILITY)) return fail(400);
          const previous = daemons.get(key), retired = previous?.retired ?? new Set<string>();
          if ((!previous && daemons.size >= 128) || retired.has(b.instance_id) || (previous?.instance === b.instance_id && previous.token !== auth.tokenId)) return fail();
          if (previous && (previous.instance !== b.instance_id || previous.token !== auth.tokenId)) {
            if (retired.size >= 64) return fail(); retired.add(previous.instance);
            for (const [id, r] of directories) if (r.task.daemon_node_id === n.node_id && r.task.network_id === n.network_id) directories.delete(id);
          }
          daemons.set(key, { token: auth.tokenId, instance: b.instance_id, expires: Date.now() + 30000, retired,
             projectCreate: options.projectEnabled === true && b.project_create_capability === PROJECT_CREATE_CAPABILITY,
             sessionAttach: attachEnabled && b.session_attach_capability === SESSION_ATTACH_CAPABILITY }); return ok({ capability: DIR_CAP, expected });
        }
        const d = daemons.get(key);
        if (!d || d.token !== auth.tokenId || d.instance !== b.instance_id || d.expires <= Date.now()) return fail(403);
        if (suffix === "/pull") {
          if (!keys(b, ["expected", "capability", "instance_id"])) return fail(400);
          for (const r of directories.values()) if (r.status === "pending" && r.daemonToken === auth.tokenId && r.instance === d.instance && directoryCurrent(r)) {
            r.status = "claimed"; return ok({ task: r.task });
          }
          return ok({ task: null });
        }
        if (suffix === "/ack") {
          if (!keys(b, ["expected", "capability", "instance_id", "request_id", "result"]) || !isDirectoryRequestId(b.request_id)) return fail(400);
          const r = directories.get(b.request_id as string);
          if (!r || r.status !== "claimed" || r.daemonToken !== auth.tokenId || r.instance !== d.instance || !directoryCurrent(r)) return fail(403);
          const result: any = b.result;
          if (result && Object.keys(result).length === 1 && result.error === "directory_read_failed") r.status = "failed";
          else if (isSourceDirectorySnapshot(result, r.task.expires_at)
            && (!r.task.server_id ? !result.projects.length && !result.sessions.length : result.servers.some(s => s.server_id === r.task.server_id)
              && result.projects.every(p => p.server_id === r.task.server_id))) { r.status = "ready"; r.snapshot = result; }
          else return fail(400);
          return ok({ acknowledged: true });
        }
        return fail(404);
      }
      if (req.method === "GET") {
        if (!isHumanCredential(credential) || !/^\/srcf_[a-f0-9-]{36}$/.test(suffix)
          || [...url.searchParams.keys()].some(k => k !== "network_id")) return fail(403);
        const r = row(suffix.slice(1));
        if (!r || url.searchParams.get("network_id") !== r.network_id || auth.tokenId !== r.requester_token_id
          || auth.user.user_id !== r.user_id || !permissions(r)) return fail(403);
        const now = refresh(r);
        // Unknown recovery may record known IDs/revoke an unconfirmed credential,
        // never dispatch, mint or repeat a session mutation.
        if (now.state === "unknown_rotation_required") {
          const e = now.execution_id && execution.recover(req, now.execution_id);
          if (e && e.status === "session_ready") now.child_session_id = e.session_id!;
          const d = now.delivery_id && delivery.recover(req, now.delivery_id);
          if (d) { now.child_node_id = d.child_node_id; now.child_session_id = d.session_id; }
        }
        return ok(view(now));
      }
      if (req.method !== "POST" || url.search) return fail(400);
      const b = await readSessionControlBody(req, 32768); if (!b) return fail(400);
      if (suffix === "") {
        if (db.dialect !== "sqlite" || db.atomicTransactions !== true || db.transactionalFeaturesRefusal !== null) return fail();
        if (!isHumanCredential(credential) || !keys(b, ["network_id", "source_node_id", "session_id", "mode", "child_name", "intent_id"])
          || !id(b.network_id) || !id(b.source_node_id) || !id(b.intent_id) || typeof b.session_id !== "string"
          || !/^ses_[A-Za-z0-9]{1,190}$/.test(b.session_id) || b.mode !== "fork_independent") return fail(400);
        const name = checkNodeName(b.child_name); if (!name.ok || name.name !== b.child_name) return fail(400);
        // Infer management from existing authoritative create/adoption journals.
        const owners = db.all<{ daemon_node_id: string }>(`SELECT daemon_node_id FROM node_create_requests WHERE child_node_id=?1
          AND network_id=?2 AND status='succeeded' AND source_ref IS NULL UNION SELECT daemon_node_id FROM node_daemon_bindings
           WHERE node_id=?1 AND network_id=?2 AND status='active'
           UNION SELECT daemon_node_id FROM session_project_creates
           WHERE child_node_id=?1 AND network_id=?2 AND state='registration_confirmed'`, b.source_node_id, b.network_id);
        if (owners.length !== 1) return fail();
        const s = { network_id: b.network_id, source_node_id: b.source_node_id, daemon_node_id: owners[0].daemon_node_id, mode: "fork_independent" as const };
        if (!("permissions_verified" in issuer.inspect(req, s))) return fail(403);
        const existing = db.get<Row>("SELECT * FROM session_source_transports WHERE user_id=?1 AND network_id=?2 AND intent_id=?3", auth.user.user_id, b.network_id, b.intent_id);
        if (existing) {
          if (existing.requester_token_id !== auth.tokenId || existing.source_node_id !== b.source_node_id || existing.session_id !== b.session_id
            || existing.child_name !== b.child_name || existing.daemon_node_id !== s.daemon_node_id) return fail(409, "intent_reused");
          return ok(view(refresh(existing))); // idempotent receipt, not a new workflow
        }
        const d = daemons.get(`${s.network_id}:${s.daemon_node_id}`);
        if (!d || d.expires <= Date.now()) return fail(409, "daemon_offline");
        if (!capable(s.daemon_node_id, s.network_id)) return fail(409, "daemon_not_capable");
        if (active.size >= 128) return fail(409, "hub_busy");
        const q = evidence.queue(req, s, b.session_id); if (!q) return fail(409, "evidence_unavailable");
        const requestId = `srcf_${randomUUID()}`, expires = Date.now() + 75_000;
        db.run(`INSERT INTO session_source_transports (request_id,user_id,requester_token_id,network_id,intent_id,source_node_id,
          daemon_node_id,daemon_token_id,daemon_instance_id,session_id,child_name,state,expires_at,evidence_id)
          VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'evidence_pending',?12,?13)`,
          [requestId, auth.user.user_id, auth.tokenId, s.network_id, b.intent_id, s.source_node_id, s.daemon_node_id,
            d.token, d.instance, b.session_id, name.name, expires, q.request_id]);
        const timer = setTimeout(() => { const r = row(requestId); if (r && !terminal(r)) settle(r, "unknown_rotation_required"); }, 75_000);
        timer.unref?.(); active.set(requestId, { human: req, timer }); return ok(view(row(requestId)!));
      }
      if (suffix === "/child-register") {
        if (!keys(b, ["request_id", "intent_id", "network_id", "source_node_id", "daemon_node_id", "delivery_id"]) || !isSourceForkRequestId(b.request_id)) return fail(400);
        const r = row(b.request_id);
        if (!r || r.state !== "deliver_claimed" || !current(r) || !active.has(r.request_id)
          || !Object.entries(envelope(r)).every(([k, v]) => b[k] === v) || r.delivery_id !== b.delivery_id
          || !delivery.confirmRegistration(req, r.delivery_id!)) return fail(403);
        const child = db.get<{ child_node_id: string }>("SELECT child_node_id FROM session_source_node_deliveries WHERE delivery_id=?1", r.delivery_id!);
        db.run("UPDATE session_source_transports SET child_node_id=?1 WHERE request_id=?2", [child!.child_node_id, r.request_id]);
        settle(r, "registration_confirmed"); return ok({ request_id: r.request_id, delivery_id: r.delivery_id, status: "registration_confirmed" });
      }
      const n = resolveSessionControlNodeCaller(auth.tokenId);
      const expected: any = b.expected;
      if (!n || !expected || Object.keys(expected).length !== 2 || expected.node_id !== n.node_id || expected.network_id !== n.network_id
        || b.capability !== CAP || !capable(n.node_id, n.network_id)) return fail(403);
      const daemonKey = `${n.network_id}:${n.node_id}`;
      if (suffix === "/daemon") {
        if (!keys(b, ["expected", "capability", "instance_id"]) || typeof b.instance_id !== "string" || !/^[a-f0-9-]{36}$/.test(b.instance_id)) return fail(400);
        if (!daemons.has(daemonKey) && daemons.size >= 128) return fail();
        const previous = daemons.get(daemonKey), retired = previous?.retired ?? new Set<string>();
        if (retired.has(b.instance_id)) return fail();
        if (previous?.instance === b.instance_id && previous.token !== auth.tokenId) return fail();
        if (previous && (previous.instance !== b.instance_id || previous.token !== auth.tokenId)) {
          if (retired.size >= 64) return fail();
          retired.add(previous.instance);
          for (const r of db.all<Row>("SELECT * FROM session_source_transports WHERE daemon_node_id=?1 AND network_id=?2 AND state NOT IN ('registration_confirmed','refused','unknown_rotation_required')", n.node_id, n.network_id)) {
            settle(r, "unknown_rotation_required");
          }
        }
        daemons.set(daemonKey, { token: auth.tokenId, instance: b.instance_id, expires: Date.now() + 75_000, retired }); return ok({ capability: CAP, expected });
      }
      if (suffix === "/pull") {
        if (!keys(b, ["expected", "capability", "instance_id"]) || daemons.get(daemonKey)?.instance !== b.instance_id) return fail(403);
        const rows = db.all<Row>("SELECT * FROM session_source_transports WHERE daemon_node_id=?1 AND network_id=?2 AND daemon_token_id=?3 AND state NOT IN ('registration_confirmed','refused','unknown_rotation_required') ORDER BY rowid", n.node_id, n.network_id, auth.tokenId);
        for (const original of rows) {
          const r = refresh(original); if (terminal(r)) continue;
          let task: SourceForkTask | null = null;
          if (r.state === "evidence_pending") { const t = evidence.take(req, r.evidence_id); if (t) task = { ...envelope(r), phase: "evidence", task: t }; }
          if (r.state === "recheck_pending") { const t = evidence.takeRecheck(req, r.evidence_id); if (t) task = { ...envelope(r), phase: "recheck", task: t }; }
          if (r.state === "execute_pending") { const t = execution.take(req, r.execution_id!); if (t) task = { ...envelope(r), phase: "execute", task: t }; }
          if (r.state === "deliver_pending") { const t = delivery.take(req, r.delivery_id!, SOURCE_DELIVERY_CAPABILITY); if (t) task = { ...envelope(r), phase: "deliver", task: t }; }
          if (task) { db.run("UPDATE session_source_transports SET state=?1 WHERE request_id=?2", [`${task.phase}_claimed`, r.request_id]); return ok({ task }); }
          if (r.state.endsWith("_pending")) settle(r, "unknown_rotation_required");
        }
        return ok({ task: null });
      }
      if (suffix === "/ack") {
        if (!keys(b, ["expected", "capability", "instance_id", "request_id", "intent_id", "network_id", "source_node_id", "daemon_node_id", "phase", "result"])
          || !isSourceForkRequestId(b.request_id)) return fail(400);
        const r = row(b.request_id);
        if (!r || !Object.entries(envelope(r)).every(([k, v]) => b[k] === v) || r.daemon_token_id !== auth.tokenId
          || r.daemon_instance_id !== b.instance_id || !current(r)) return fail(403);
        if (r.state === "registration_confirmed" && b.phase === "deliver") return ok({ acknowledged: true });
        if (r.state !== `${b.phase}_claimed` || !active.has(r.request_id)) return fail();
        const result: any = b.result;
        if (result && Object.keys(result).length === 1 && result.transport_failure === "unknown_rotation_required") {
          settle(r, "unknown_rotation_required"); return ok({ acknowledged: true });
        }
        if (b.phase === "evidence") { if (result?.request?.request_id !== r.evidence_id || !evidence.ack(req, result)) return fail(400); startAdmission(r); }
        else if (b.phase === "recheck") { if (result?.request?.evidence?.request?.request_id !== r.evidence_id || !evidence.ackRecheck(req, result)) return fail(400); active.get(r.request_id)?.release?.(); }
        else if (b.phase === "execute") {
          if (result?.execution_id !== r.execution_id || !execution.ack(req, b.result)) return fail(400);
          const a = active.get(r.request_id)!, recovered = execution.recover(a.human, r.execution_id!);
          if (recovered?.status !== "session_ready") { settle(r, recovered?.status === "refused" ? "refused" : "unknown_rotation_required"); }
          else {
            const deliveryId = delivery.queue(a.human, r.execution_id!);
            if (!deliveryId) settle(r, "unknown_rotation_required");
            else db.run("UPDATE session_source_transports SET state='deliver_pending',delivery_id=?1,child_session_id=?2 WHERE request_id=?3", [deliveryId, recovered.session_id!, r.request_id]);
          }
        } else if (b.phase === "deliver") { settle(r, "unknown_rotation_required"); }
        else return fail(400);
        return ok({ acknowledged: true });
      }
      return fail(404);
    } catch { return fail(); }
  };
}

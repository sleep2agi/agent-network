import { randomUUID } from "node:crypto";
import { db } from "./db";
import { resolveToken, createNetworkTokenForNode } from "./auth";
import { readSessionControlBody, readSessionControlCredential, isHumanCredential, resolveSessionControlNodeCaller } from "./node-session-control";
import { putPendingEnvBlob, takePendingEnvBlob } from "./create-node";
import { checkNodeName } from "./shared/node-name";
import { hasFreshChildRegistration } from "./session-source-delivery";
import { PROJECT_CREATE_ROOT as ROOT, PROJECT_CREATE_CAPABILITY as CAP, isProjectCreateId,
  type ProjectCreateTask, type ProjectCreateSelection, type SessionAttachSelection, type ProjectOperation } from "./contracts/session-project-create";

export type ProjectRow = ProjectCreateTask & { user_id: string; requester_token_id: string; daemon_token_id: string;
  daemon_instance_id: string; state: string; session_id: string | null; child_node_id: string | null;
  child_token_id: string | null; credential_expires_at: number | null };
export type ProjectScope = { network_id: string; source_node_id: string; daemon_node_id: string; daemon_token_id: string; daemon_instance_id: string;
  operation_kind?: ProjectOperation; selected_project_id?: string };
/** Uses the existing source HTTP handler/pin/declaration and directory scope.
 * One journal for accepted writes, no source/fork evidence or recovery mutation. */
export function createSessionProjectTransport(deps: { enabled: boolean; attachEnabled?: boolean;
  select: (s: ProjectCreateSelection | SessionAttachSelection, token: string, user: string) => ProjectScope | null;
  permissions: (r: ProjectRow) => boolean; current: (r: ProjectScope) => boolean }) {
  const live = new Set<string>();
  const row = (id: string) => db.get<ProjectRow>("SELECT * FROM session_project_creates WHERE request_id=?1", id);
  const terminal = (r: ProjectRow) => ["registration_confirmed", "unknown_rotation_required"].includes(r.state);
  const unknown = (r: ProjectRow) => {
    if (r.state === "registration_confirmed") return;
    takePendingEnvBlob(r.request_id, r.daemon_node_id);
    db.transaction(() => {
      db.run("UPDATE session_project_creates SET state='unknown_rotation_required' WHERE request_id=?1 AND state!='registration_confirmed'", [r.request_id]);
      if (r.child_token_id) db.run("UPDATE api_tokens SET revoked_at=datetime('now') WHERE token_id=?1", [r.child_token_id]);
    }); live.delete(r.request_id);
  };
  const current = (r: ProjectRow) => deps.current(r) && deps.permissions(r) && Date.now() < r.expires_at;
  const refresh = (r: ProjectRow) => { if (!terminal(r) && (!live.has(r.request_id) || !current(r)
    || (r.credential_expires_at !== null && Date.now() >= r.credential_expires_at))) unknown(r); return row(r.request_id)!; };
  const view = (r: ProjectRow) => ({ request_id: r.request_id, network_id: r.network_id, daemon_node_id: r.daemon_node_id,
    intent_id: r.intent_id, child_name: r.child_name, status: r.state, accepted_at: r.accepted_at, expires_at: r.expires_at,
    operation_kind: r.operation_kind ?? "project_new_session",
    session_creation: r.operation_kind === "attach_existing_session" ? "not_performed" : r.session_id ? "confirmed" : r.state === "create_pending" ? "not_started" : "unknown",
    ...(r.child_node_id ? { child_node_id: r.child_node_id } : {}),
    registration_is_health: false, native_acceptance: "not_verified" });
  const task = (r: ProjectRow): ProjectCreateTask => ({ request_id: r.request_id, network_id: r.network_id, source_node_id: r.source_node_id,
    daemon_node_id: r.daemon_node_id, selection_scope: r.selection_scope, snapshot_id: r.snapshot_id, project_id: r.project_id,
    child_name: r.child_name, intent_id: r.intent_id, accepted_at: r.accepted_at, expires_at: r.expires_at,
    operation_kind: r.operation_kind ?? "project_new_session", selected_session_id: r.selected_session_id ?? null });
  const keys = (o: object, names: string[]) => Object.keys(o).every(k => names.includes(k));
  const ok = (o: object) => Response.json({ ok: true, ...o }, { headers: { "cache-control": "no-store" } });
  const fail = (status = 409) => Response.json({ ok: false, error: "project_create_unavailable" }, { status, headers: { "cache-control": "no-store" } });
  return async (req: Request, url: URL): Promise<Response | null> => {
    if (url.pathname !== ROOT && !url.pathname.startsWith(`${ROOT}/`)) return null;
    if (!deps.enabled && !deps.attachEnabled) return fail(404);
    try {
      const a = resolveToken(req.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1] ?? "");
      if (!a?.tokenId) return fail(401);
      const credential = readSessionControlCredential(a.tokenId), suffix = url.pathname.slice(ROOT.length);
      if (req.method === "GET") {
        if (!isHumanCredential(credential) || !isProjectCreateId(suffix.slice(1))) return fail(403);
        const r = row(suffix.slice(1));
        if (!r || r.requester_token_id !== a.tokenId || r.user_id !== a.user.user_id || url.searchParams.getAll("network_id").length !== 1
          || [...url.searchParams.keys()].some(k => k !== "network_id") || url.searchParams.get("network_id") !== r.network_id || !deps.permissions(r)) return fail(403);
        return ok(view(refresh(r)));
      }
      if (req.method !== "POST" || url.search) return fail(400);
      const b: any = await readSessionControlBody(req, 16384); if (!b) return fail(400);
      if (!suffix) {
        const attach = Object.hasOwn(b, "session_id"), operation = attach ? "attach_existing_session" : "project_new_session";
        if (attach ? !deps.attachEnabled : !deps.enabled) return fail(404);
        if (!isHumanCredential(credential) || !keys(b, ["selection_scope", "snapshot_id", attach ? "session_id" : "project_id", "child_name", "intent_id"])
          || !/^srcdir_[a-f0-9-]{36}$/.test(b.selection_scope) || !/^snap_[a-f0-9-]{36}$/.test(b.snapshot_id)
          || !(attach ? /^oses_[a-f0-9-]{36}$/.test(b.session_id) : /^oprj_[a-f0-9-]{36}$/.test(b.project_id)) || typeof b.intent_id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(b.intent_id)) return fail(400);
        const name = checkNodeName(b.child_name); if (!name.ok || name.name !== b.child_name) return fail(400);
        // Resolve replay BEFORE looking at a possibly expired directory scope.
        const existing = db.get<ProjectRow>("SELECT * FROM session_project_creates WHERE user_id=?1 AND intent_id=?2 AND selection_scope=?3", a.user.user_id, b.intent_id, b.selection_scope);
        if (existing) {
          if ((existing.operation_kind ?? "project_new_session") !== operation || existing.requester_token_id !== a.tokenId || existing.snapshot_id !== b.snapshot_id
            || (attach ? existing.selected_session_id !== b.session_id : existing.project_id !== b.project_id)
            || existing.child_name !== b.child_name || !deps.permissions(existing)) return fail(403);
          return ok(view(refresh(existing)));
        }
        if (db.dialect !== "sqlite" || db.atomicTransactions !== true || db.transactionalFeaturesRefusal !== null || live.size >= 100) return fail();
        const scope = deps.select(b, a.tokenId, a.user.user_id); if (!scope || !deps.current(scope)) return fail(403);
        const id = `prjc_${randomUUID()}`, now = Date.now();
        db.transaction(() => {
          // A new project reservation never enters ordinary create's dispatch statuses.
          if (db.get("SELECT 1 FROM nodes WHERE network_id=?1 AND alias=?2", scope.network_id, b.child_name)
            || db.get("SELECT 1 FROM node_create_requests WHERE network_id=?1 AND child_name=?2 AND status IN ('pending','delivered','source_reserved')", scope.network_id, b.child_name)) throw Error("name_reserved");
          db.run(`INSERT INTO session_project_creates (request_id,user_id,requester_token_id,network_id,source_node_id,daemon_node_id,daemon_token_id,daemon_instance_id,
             intent_id,selection_scope,snapshot_id,project_id,child_name,accepted_at,expires_at,state,operation_kind,selected_session_id)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,'create_pending',?16,?17)`,
            [id, a.user.user_id, a.tokenId, scope.network_id, scope.source_node_id, scope.daemon_node_id, scope.daemon_token_id, scope.daemon_instance_id,
              b.intent_id, b.selection_scope, b.snapshot_id, attach ? scope.selected_project_id : b.project_id, b.child_name, now, now + 300000, operation, attach ? b.session_id : null]);
        });
        live.add(id);
        const timer = setTimeout(() => { const r = row(id); if (r && !terminal(r)) unknown(r); }, 300000); timer.unref?.();
        return ok(view(row(id)!));
      }
      if (suffix === "/child-register") {
        if (!keys(b, ["request_id"]) || !isProjectCreateId(b.request_id)) return fail(400);
        const r = row(b.request_id); if (!r || r.state !== "delivery_claimed" || !current(r) || Date.now() >= r.credential_expires_at!
          || a.tokenId !== r.child_token_id) return fail(403);
        const n = resolveSessionControlNodeCaller(a.tokenId);
        if (n?.node_id !== r.child_node_id || n.network_id !== r.network_id) return fail(403);
        if (!hasFreshChildRegistration(r.child_node_id!, r.network_id, r.child_name, r.session_id!)) return fail(403);
        db.transaction(() => { db.run("UPDATE session_project_creates SET state='registration_confirmed' WHERE request_id=?1", [r.request_id]);
          db.run("UPDATE api_tokens SET expires_at=NULL WHERE token_id=?1 AND revoked_at IS NULL", [r.child_token_id]); });
        live.delete(r.request_id); return ok({ status: "registration_confirmed" });
      }
      const n = resolveSessionControlNodeCaller(a.tokenId), expected = b.expected;
      if (!n || !expected || Object.keys(expected).length !== 2 || expected.node_id !== n.node_id || expected.network_id !== n.network_id
        || b.capability !== CAP || typeof b.instance_id !== "string" || !deps.current({ network_id: n.network_id, daemon_node_id: n.node_id,
          daemon_token_id: a.tokenId, daemon_instance_id: b.instance_id, source_node_id: "" })) return fail(403);
      const rows = db.all<ProjectRow>("SELECT * FROM session_project_creates WHERE daemon_token_id=?1 AND daemon_instance_id=?2 ORDER BY accepted_at", a.tokenId, b.instance_id);
      if (suffix === "/pull") {
        if (!keys(b, ["expected", "capability", "instance_id"])) return fail(400);
        for (const original of rows) {
          const r = refresh(original); if (terminal(r)) continue;
          if (!current(r)) continue;
          if (r.state === "create_pending") {
            db.run("UPDATE session_project_creates SET state='create_claimed' WHERE request_id=?1 AND state='create_pending'", [r.request_id]);
            return ok({ task: { phase: "create", task: task(r) } });
          }
          if (r.state === "delivery_pending") {
            const blob = takePendingEnvBlob(r.request_id, r.daemon_node_id);
            const child = r.child_token_id && resolveSessionControlNodeCaller(r.child_token_id);
            if (!blob || blob.child_token_id !== r.child_token_id || !child || child.node_id !== r.child_node_id || child.network_id !== r.network_id
              || Date.now() >= r.credential_expires_at!) { unknown(r); continue; }
            db.run("UPDATE session_project_creates SET state='delivery_claimed' WHERE request_id=?1 AND state='delivery_pending'", [r.request_id]);
            return ok({ task: { phase: "deliver", task: { ...task(r), session_id: r.session_id, child_node_id: r.child_node_id,
              child_token: blob.child_token, credential_expires_at: r.credential_expires_at } } });
          }
        }
        return ok({ task: null });
      }
      if (suffix === "/ack") {
        if (!keys(b, ["expected", "capability", "instance_id", "request_id", "result"]) || !isProjectCreateId(b.request_id)) return fail(400);
        const r = row(b.request_id);
        if (!r || r.daemon_token_id !== a.tokenId || r.daemon_instance_id !== b.instance_id || !current(r)) return fail(403);
        if (r.state === "registration_confirmed") return ok({ acknowledged: true });
        if (!live.has(r.request_id)) { unknown(r); return fail(); }
        const result = b.result;
        if (result && keys(result, ["status"]) && result.status === "unknown_rotation_required") { unknown(r); return ok({ acknowledged: true }); }
        if (r.state !== "create_claimed" || !result || !keys(result, ["status", "session_id"]) || result.status !== "session_ready"
          || typeof result.session_id !== "string" || !/^ses_[A-Za-z0-9]{1,190}$/.test(result.session_id)) return fail(400);
        const child = `node_${r.request_id}`, expires = Math.min(r.expires_at, Date.now() + 60000);
        const token = db.transaction(() => {
          // Claim and credential are atomic. No secret is written into this journal.
          if (db.run("UPDATE session_project_creates SET state='delivery_pending',session_id=?1,child_node_id=?2,credential_expires_at=?3 WHERE request_id=?4 AND state='create_claimed'",
            [result.session_id, child, expires, r.request_id]).changes !== 1) throw Error("already_minted");
          const t = createNetworkTokenForNode(r.user_id, r.network_id, r.child_name, child);
          if (!t.ok || !t.token || !t.token_id) throw Error("child_credential_refused");
          db.run("UPDATE api_tokens SET expires_at=?1 WHERE token_id=?2", [new Date(expires).toISOString().replace("T", " ").slice(0, 19), t.token_id]);
          db.run("UPDATE session_project_creates SET child_token_id=?1 WHERE request_id=?2", [t.token_id, r.request_id]); return t;
        });
        putPendingEnvBlob({ request_id: r.request_id, daemon_node_id: r.daemon_node_id, child_token: token.token!, child_token_id: token.token_id!, env_blob: {} });
        return ok({ acknowledged: true });
      }
      return fail(404);
    } catch { return fail(); }
  };
}

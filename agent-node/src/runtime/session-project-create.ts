import { openSync, closeSync, fsyncSync, writeFileSync, mkdirSync, lstatSync, realpathSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { createSingleClaimSourceOperation } from "./session-source-execution";
import { createSourceResumeLauncher, claimSharedSessionBridge, type SourceResumeChild } from "./source-resume-launcher";
import { writeCreatedOpencodeProfile } from "./opencode-create-profile";
import { childDirNameForCreate } from "./child-dir-name";
import { recordChildWorkdir } from "./child-workdir";
import { checkNodeName } from "../shared/node-name";
import { readOpenCodeCatalog } from "./opencode-v2-catalog";
import { acceptsSharedVersion } from "./opencode-copresence/v2-test-build-identity";
import type { createSourceDirectoryReader } from "./session-source-directory";
import { isProjectCreateId, type ProjectCreateTask, type ProjectCreateDelivery } from "../../../contracts/session-project-create";

const sync = (path: string) => { const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } };
function privateDirectory(path: string) {
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
  const s = lstatSync(path); if (!s.isDirectory() || s.isSymbolicLink() || realpathSync(path) !== path || (s.mode & 0o077)
    || s.uid !== process.getuid!()) throw Error("project_create_private_directory_required");
}
const binding = (t: ProjectCreateTask) => createHash("sha256").update(JSON.stringify([t.request_id, t.intent_id, t.network_id, t.source_node_id,
   t.daemon_node_id, t.selection_scope, t.snapshot_id, t.project_id, t.child_name, t.accepted_at, t.expires_at,
   ...(t.operation_kind === "attach_existing_session" ? [t.operation_kind, t.selected_session_id] : [])])).digest("hex");
type Result = { binding: string; status: "unknown_rotation_required" | "session_ready"; session_id?: string };
export function createProjectSessionWorker(local: { reader: ReturnType<typeof createSourceDirectoryReader>; daemonWorkDir: string; home: string; hubUrl: string;
  checkpoint: () => void; signal: AbortSignal; nativeLaunch: Parameters<typeof createSourceResumeLauncher>[0];
  confirm: (requestId: string, token: string) => Promise<boolean> }) {
  const journal = join(local.daemonWorkDir, ".anet", "project-create-journal"); privateDirectory(journal);
  const contexts = new Map<string, { t: ProjectCreateTask; sessionId: string; pid: number; model: string; version: string }>();
  const children = new Map<string, SourceResumeChild>();
  const validTask = (t: ProjectCreateTask) => !!t && isProjectCreateId(t.request_id) && /^oprj_[a-f0-9-]{36}$/.test(t.project_id)
    && (t.operation_kind === undefined || t.operation_kind === "project_new_session" || t.operation_kind === "attach_existing_session" && /^oses_[a-f0-9-]{36}$/.test(t.selected_session_id ?? ""))
    && /^snap_[a-f0-9-]{36}$/.test(t.snapshot_id) && /^srcdir_[a-f0-9-]{36}$/.test(t.selection_scope)
    && Number.isSafeInteger(t.accepted_at) && t.expires_at === t.accepted_at + 300000 && Date.now() < t.expires_at
    && checkNodeName(t.child_name).ok;
  const client = (c: Awaited<ReturnType<typeof local.reader.selectProject>>) => async (path: string, body?: object, unauth = false): Promise<any> => {
    local.checkpoint();
    const r = await fetch(`${c.endpoint.opencodeSharedServerUrl}${path}`, { method: body ? "POST" : "GET", redirect: "error",
      signal: AbortSignal.any([local.signal, AbortSignal.timeout(3000)]),
       headers: { ...(unauth ? {} : { authorization: `Basic ${Buffer.from(`opencode:${c.password}`).toString("base64")}` }), "content-type": "application/json", "x-opencode-directory": c.project },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    if (unauth) { await r.body?.cancel(); if (r.status !== 401) throw Error("project_create_auth_required"); return; }
    if (!r.ok) { await r.body?.cancel(); throw Error("project_create_api_failed"); }
    const reader = r.body?.getReader(); if (!reader) throw Error("project_create_api_failed");
    let size = 0; const parts: Uint8Array[] = [];
    try { for (;;) { const p = await reader.read(); if (p.done) break; size += p.value.length; if (size > 262144) throw Error("project_create_api_limit"); parts.push(p.value); } }
    finally { await reader.cancel(); }
    local.checkpoint(); return JSON.parse(Buffer.concat(parts).toString("utf8"));
  };
  const executor = createSingleClaimSourceOperation<ProjectCreateTask, Result>({ journalDirectory: journal, key: t => t.request_id, validTask,
    validResult: (v, t) => v?.binding === binding(t) && ["session_ready", "unknown_rotation_required"].includes(v.status)
      && (v.status !== "session_ready" || /^ses_[A-Za-z0-9]{1,190}$/.test(v.session_id)),
    fallback: t => ({ binding: binding(t), status: "unknown_rotation_required" }),
    async run(t) {
      // Claim already fsynced. Any exception, including an uncertain POST, leaves
      // unknown. No caller/native idempotency ID, parent, model or prompt is sent.
      const c = await local.reader.selectProject(t), request = client(c);
      const info = await request("/api/info");
       if (!await acceptsSharedVersion(c.endpoint.opencodeSharedServerUrl, info, !!c.sharedVariantAuthority) || !Number.isSafeInteger(info.pid) || info.pid <= 1) throw Error("project_create_server_invalid");
       if (t.operation_kind === "attach_existing_session" && info.pid !== c.serverPid) throw Error("project_attach_server_changed");
      process.kill(info.pid, 0); await request("/api/info", undefined, true);
      const projects = await request("/api/project");
      if (!Array.isArray(projects) || projects.length > 128 || projects.filter(p => p?.id === c.projectId && p.canonical === c.project).length !== 1) throw Error("project_create_project_changed");
      // The shared co-presence core requires an explicit model even when the
      // newly created Session has none. Reuse the read-only native catalog, not
      // source-node config, client input, a paid probe or guessed first model.
      const catalog = await readOpenCodeCatalog({ scope: { networkId: t.network_id, daemonId: t.daemon_node_id, directory: c.project },
        url: c.endpoint.opencodeSharedServerUrl, authorization: `Basic ${Buffer.from(`opencode:${c.password}`).toString("base64")}`, timeoutMs: 3000 });
      if (!catalog.defaultModel || catalog.defaultModel.providerId.includes("/")) throw Error("project_create_default_model_unavailable");
      const model = `${catalog.defaultModel.providerId}/${catalog.defaultModel.id}`;
      await local.reader.selectProject(t); local.checkpoint();
       const attach = t.operation_kind === "attach_existing_session";
       if (attach && !c.nativeSessionId) throw Error("project_attach_selection_invalid");
       const freshInfo = await request("/api/info");
       if (freshInfo.pid !== info.pid || freshInfo.version !== info.version || !await acceptsSharedVersion(c.endpoint.opencodeSharedServerUrl, freshInfo, !!c.sharedVariantAuthority)) throw Error("project_create_server_changed");
       const response = attach ? await request(`/api/session/${c.nativeSessionId}`) : await request("/api/session", { location: { directory: c.project } });
      const s = response?.data;
      if (typeof s?.id !== "string" || !/^ses_[A-Za-z0-9]{1,190}$/.test(s.id) || s.projectID !== c.projectId || s.location?.directory !== c.project
         || (attach ? s.id !== c.nativeSessionId : s.parentID !== undefined)) throw Error("project_create_response_invalid");
       if (attach) {
         const active = await request("/api/session/active");
         if (!active?.data || Array.isArray(active.data) || typeof active.data !== "object"
           || Object.values(active.data).some((s: any) => s?.type !== "running") || Object.hasOwn(active.data, s.id)) throw Error("project_attach_busy_or_unknown");
         claimSharedSessionBridge({ project: c.project, url: c.endpoint.opencodeSharedServerUrl, serverPid: info.pid,
           sessionId: s.id, workDir: join(c.project, ".anet", "nodes", childDirNameForCreate(t.child_name)), requestId: t.request_id });
       }
      await local.reader.selectProject(t);
       const selectedModel = attach && typeof s.model?.providerID === "string" && typeof s.model?.id === "string"
         ? `${s.model.providerID}/${s.model.id}` : model;
       contexts.set(t.request_id, { t: structuredClone(t), sessionId: s.id, pid: info.pid, model: selectedModel, version: info.version });
      return { binding: binding(t), status: "session_ready", session_id: s.id };
    } });
  return {
    async create(t: ProjectCreateTask) {
      for (const [id, c] of contexts) if (Date.now() >= c.t.expires_at) contexts.delete(id);
      if (contexts.size >= 100 && !contexts.has(t.request_id)) return { status: "unknown_rotation_required" };
      try { const result = await executor.execute(t); return result.status === "session_ready" && contexts.has(t.request_id)
        ? { status: result.status, session_id: result.session_id! } : { status: "unknown_rotation_required" }; }
      catch { return { status: "unknown_rotation_required" }; }
    },
    async deliver(t: ProjectCreateDelivery) {
      let child: SourceResumeChild | undefined, confirmed = false;
      try {
        const context = contexts.get(t.request_id);
        if (!validTask(t) || !context || binding(context.t) !== binding(t) || context.sessionId !== t.session_id
          || t.child_node_id !== `node_${t.request_id}` || !/^ntok_[A-Za-z0-9_-]+$/.test(t.child_token)
          || Date.now() >= t.credential_expires_at || t.credential_expires_at > t.expires_at) throw Error("project_create_delivery_scope");
        const c = await local.reader.selectProject(t);
        const nodes = join(c.project, ".anet", "nodes"); privateDirectory(dirname(nodes)); privateDirectory(nodes);
        const dir = join(nodes, childDirNameForCreate(t.child_name));
        // Exclusive private directory and existing launcher claims are the
        // durable no-relaunch boundary. No source profile/evidence is involved.
        mkdirSync(dir, { mode: 0o700 });
        const fd = openSync(join(dir, "source-delivery-claim.json"), "wx", 0o600);
        try { writeFileSync(fd, JSON.stringify({ delivery_id: t.request_id, execution_id: t.request_id, session_id: t.session_id, child_node_id: t.child_node_id })); fsyncSync(fd); }
        finally { closeSync(fd); } sync(dir); sync(nodes);
        const passwordFile = join(dir, "source-server-password");
        writeCreatedOpencodeProfile(dir, { node_id: t.child_node_id, node_name: t.child_name, alias: t.child_name, network_id: t.network_id,
          runtime: "opencode-cli", opencodeGeneration: "v2", opencodeMode: "copresence", hub: local.hubUrl, token: t.child_token, sessionId: t.session_id,
          model: context.model, flags: { opencodeUnsafeTools: true }, sharedVariantAuthority: c.sharedVariantAuthority, opencodeSharedServerUrl: c.endpoint.opencodeSharedServerUrl, opencodeSharedServerPasswordFile: passwordFile,
          sourceDelivery: { delivery_id: t.request_id, execution_id: t.request_id, expires_at: t.credential_expires_at, server_pid: context.pid,
             operation_kind: t.operation_kind ?? "project_new_session", resume_only: true, expected_version: context.version } }, local.home);
        writeFileSync(passwordFile, c.password, { mode: 0o600, flag: "wx" });
        recordChildWorkdir(local.daemonWorkDir, t.child_name, c.project); await local.reader.selectProject(t); local.checkpoint();
        child = await createSourceResumeLauncher(local.nativeLaunch)({ configPath: join(dir, "config.json"), cwd: c.project,
          existingSessionId: t.session_id, resumeSessionId: t.session_id, newSession: false, expectedVersion: context.version, bridgePolicy: "new_child_only" });
        local.checkpoint(); confirmed = await local.confirm(t.request_id, t.child_token);
        if (confirmed) children.set(t.request_id, child);
      } catch { /* Unknown is negative-only; never relaunch or delete any Session. */ }
      finally { if (!confirmed && child) await child.stop(); contexts.delete(t.request_id); }
      return { status: confirmed ? "registration_confirmed" : "unknown_rotation_required" };
    },
    async stop() { for (const c of children.values()) await c.stop(); children.clear(); contexts.clear(); },
  };
}

import { constants, openSync, closeSync, fstatSync, readFileSync, lstatSync, realpathSync, mkdirSync, existsSync, writeFileSync, fsyncSync } from "node:fs";
import { observeHostSharedServe } from "./opencode-host-shared-observer";
import { join, isAbsolute } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { readHostSharedOpenCodeServer } from "./opencode-shared-server-registry";
import { directoryTitle, isDirectoryServerId, type SourceDirectoryTask, type SourceDirectorySnapshot } from "../../../contracts/session-source-directory";
import type { ProjectCreateTask } from "../../../contracts/session-project-create";
import { acceptsSharedVersion } from "./opencode-copresence/v2-test-build-identity";

function privateText(path: string) {
  if (realpathSync(path) !== path) throw Error("directory_authority_invalid");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = fstatSync(fd); if (!s.isFile() || s.nlink !== 1 || s.size > 32768 || (s.mode & 0o077)
      || !process.getuid || s.uid !== process.getuid()) throw Error("directory_authority_invalid");
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}
/** Explicit local operator grant, NOT a port/path scanner or managed-node
 * fallback. Existing host registry supplies endpoint/password, never HTTP input.
 * Process-local references are bounded and expire with this snapshot. They are
 * not Server incarnation or ownership leases and authorize no write operation. */
export function createSourceDirectoryReader(local: { home: string; daemonWorkDir: string; networkId: string; daemonId: string;
  signal?: AbortSignal; checkpoint?: () => void; projectSelectionEnabled?: boolean; attachSelectionEnabled?: boolean }) {
  const leases = new Map<string, { task: SourceDirectoryTask; authority: string; selectionExpires: number;
    selections: Map<string, { directory: string; nativeProjectId?: string; nativeSessionId?: string }> }>();
  const authority = () => {
    for (const dir of [join(local.daemonWorkDir, ".anet"), join(local.home, ".anet")]) {
      const s = lstatSync(dir); if (!s.isDirectory() || s.isSymbolicLink() || realpathSync(dir) !== dir
        || (s.mode & 0o077) || s.uid !== process.getuid!()) throw Error("directory_authority_invalid");
    }
    const text = privateText(join(local.daemonWorkDir, ".anet", "opencode-directory-authorities.json"));
    const v = JSON.parse(text);
    if (v?.version !== 1 || !Array.isArray(v.grants) || v.grants.length > 16) throw Error("directory_authority_invalid");
    const registryPath = join(local.home, ".anet", "opencode-shared-server.json");
    const registryText = privateText(registryPath), endpoint = readHostSharedOpenCodeServer(registryPath);
    if (!endpoint) throw Error("directory_authority_missing");
    const password = privateText(endpoint.opencodeSharedServerPasswordFile).trim();
    if (!password || password.length > 4096 || /[\r\n]/.test(password)) throw Error("directory_authority_invalid");
    for (const g of v.grants) if (!g || !isDirectoryServerId(g.server_id) || typeof g.network_id !== "string" || typeof g.source_node_id !== "string"
      || !Array.isArray(g.directories) || !g.directories.length || g.directories.length > 16 || new Set(g.directories).size !== g.directories.length
      || g.directories.some((d: unknown) => typeof d !== "string" || !isAbsolute(d) || d.length > 1024 || /[^\x20-\x7e]/.test(d)
        || realpathSync(d) !== d || !lstatSync(d).isDirectory())) throw Error("directory_authority_invalid");
    if (new Set(v.grants.map((g: any) => g.server_id)).size > 1) throw Error("directory_registry_single_server_only");
    return { grants: v.grants as { server_id: string; network_id: string; source_node_id: string; directories: string[];
       allow_new_session?: boolean; opencode_unsafe_tools?: boolean; test_only_shared_variant?: boolean;
       allow_attach_existing?: { enabled: true; policy_id: string; daemon_id: string; directories: string[]; expires_at: number; grant_ttl_ms: number };
       attach_sessions?: Array<{ grant_id: string; daemon_id: string; directory: string; session_id: string;
         server_pid: number; server_start_ticks: number; expires_at: number }> }[], endpoint, password,
      fingerprint: createHash("sha256").update(JSON.stringify([text, registryText, password])).digest("hex") };
  };
  return {
    // A project-selection window is NOT a Session ownership lease. A Hub-accepted
    // operation has its own deadline, but must still revalidate private authority.
    async selectProject(t: ProjectCreateTask) {
      local.checkpoint?.(); const lease = leases.get(t.snapshot_id);
       const attach = t.operation_kind === "attach_existing_session";
       if (!(attach ? local.attachSelectionEnabled : local.projectSelectionEnabled) || !lease || lease.task.request_id !== t.selection_scope || t.network_id !== local.networkId || t.daemon_node_id !== local.daemonId
        || lease.task.network_id !== t.network_id || lease.task.source_node_id !== t.source_node_id || lease.task.daemon_node_id !== t.daemon_node_id
        || !Number.isSafeInteger(t.accepted_at) || t.accepted_at > lease.selectionExpires || t.accepted_at < lease.task.expires_at - 30000
        || Date.now() >= t.expires_at || t.expires_at !== t.accepted_at + 300000) throw Error("project_selection_expired");
      const selected = lease.selections.get(t.project_id), a = authority();
      const grant = a.grants.find(g => g.server_id === lease.task.server_id && g.network_id === t.network_id && g.source_node_id === t.source_node_id);
       if (!selected?.nativeProjectId || selected.nativeSessionId || a.fingerprint !== lease.authority
         || grant?.opencode_unsafe_tools !== true || !grant.directories.includes(selected.directory)) throw Error("project_selection_not_authorized");
       let nativeSessionId: string | undefined;
       let serverPid: number | undefined;
       if (attach) {
         const session = lease.selections.get(t.selected_session_id ?? "");
         if (!session?.nativeSessionId || session.directory !== selected.directory) throw Error("project_attach_selection_invalid");
         const observed = observeHostSharedServe(a.endpoint.opencodeSharedServerUrl);
         if (!observed.ok || observed.processEvidence.uid !== process.getuid?.()) throw Error("project_attach_server_unproven");
         const p = observed.processEvidence;
          const grants = grant.attach_sessions ?? [];
         if (!Array.isArray(grants) || grants.length > 128) throw Error("project_attach_grant_required");
          let matches = grants.filter(g => g.directory === selected.directory && g.session_id === session.nativeSessionId && g.daemon_id === local.daemonId
           && g.server_pid === p.pid && g.server_start_ticks === p.startTicks && Number.isSafeInteger(g.expires_at)
           && g.expires_at > Date.now() && g.expires_at <= t.accepted_at + 600000 && /^[a-f0-9-]{36}$/.test(g.grant_id));
          let derivedBinding: object | undefined;
          // Independent local operator delegation. Neither read nor new-session
          // permission enters this branch. No client field can expand its scope.
          if (matches.length === 0 && grant.allow_attach_existing !== undefined) {
            const policy = grant.allow_attach_existing;
            if (!policy || policy.enabled !== true || !/^[a-f0-9-]{36}$/.test(policy.policy_id) || policy.daemon_id !== local.daemonId
              || !Array.isArray(policy.directories) || !policy.directories.length || policy.directories.length > 16
              || policy.directories.some(d => !grant.directories.includes(d)) || !policy.directories.includes(selected.directory)
              || !Number.isSafeInteger(policy.expires_at) || policy.expires_at <= Date.now()
              || !Number.isSafeInteger(policy.grant_ttl_ms) || policy.grant_ttl_ms < 1000 || policy.grant_ttl_ms > 300000)
              throw Error("project_attach_delegate_refused");
            const expires = Math.min(policy.expires_at, t.expires_at, t.accepted_at + policy.grant_ttl_ms);
            if (Date.now() >= expires) throw Error("project_attach_delegate_expired");
            const get = async (path: string): Promise<any> => {
              local.checkpoint?.();
              const r = await fetch(a.endpoint.opencodeSharedServerUrl + path, { redirect: "error",
                signal: AbortSignal.any([AbortSignal.timeout(3000), ...(local.signal ? [local.signal] : [])]),
                headers: { authorization: `Basic ${Buffer.from(`opencode:${a.password}`).toString("base64")}`, "x-opencode-directory": selected.directory } });
              if (!r.ok) { await r.body?.cancel(); throw Error("project_attach_delegate_read_failed"); }
              const reader = r.body?.getReader(); if (!reader) throw Error("project_attach_delegate_read_failed");
              const parts: Uint8Array[] = []; let size = 0;
              try { for (;;) { const v = await reader.read(); if (v.done) break; size += v.value.length;
                if (size > 65536) throw Error("project_attach_delegate_read_limit"); parts.push(v.value); } }
              finally { await reader.cancel(); }
              return JSON.parse(Buffer.concat(parts).toString("utf8"));
            };
            const info = await get("/api/info"), actual = (await get(`/api/session/${session.nativeSessionId}`))?.data;
            const after = observeHostSharedServe(a.endpoint.opencodeSharedServerUrl);
            if (!await acceptsSharedVersion(a.endpoint.opencodeSharedServerUrl, info, grant.test_only_shared_variant === true) || info.pid !== p.pid || actual?.id !== session.nativeSessionId
              || actual.projectID !== selected.nativeProjectId || actual.location?.directory !== selected.directory
              || !after.ok || after.processEvidence.pid !== p.pid || after.processEvidence.startTicks !== p.startTicks
              || after.processEvidence.listenInode !== p.listenInode || after.processEvidence.uid !== p.uid
              || authority().fingerprint !== a.fingerprint || Date.now() >= expires) throw Error("project_attach_delegate_binding_changed");
            local.checkpoint?.();
            // Stable for this accepted intent. Re-reading/recovery never renews
            // an expiry or mints a new identity after an uncertain outcome.
            const hex = createHash("sha256").update(JSON.stringify(["attach-delegate-v1", policy.policy_id, a.fingerprint, t.request_id,
              t.intent_id, t.network_id, t.source_node_id, t.daemon_node_id, t.child_name])).digest("hex").slice(0, 32);
            const grantId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
            matches = [{ grant_id: grantId, daemon_id: local.daemonId, directory: selected.directory, session_id: session.nativeSessionId,
              server_pid: p.pid, server_start_ticks: p.startTicks, expires_at: expires }];
            derivedBinding = { kind: "operator_delegate_v1", policy_id: policy.policy_id, intent_id: t.intent_id,
              network_id: t.network_id, source_node_id: t.source_node_id, daemon_id: t.daemon_node_id,
              server_id: lease.task.server_id, directory: selected.directory, server_pid: p.pid, server_start_ticks: p.startTicks,
              expires_at: expires };
          }
          if (matches.length !== 1) throw Error("project_attach_grant_required");
         // Consumption shares the canonical project namespace across daemon
         // process/workdir reconstruction, not a copyable per-worker cache.
         const parent = join(selected.directory, ".anet");
         if (!existsSync(parent)) mkdirSync(parent, { mode: 0o700 });
         const parentStat = lstatSync(parent);
         if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || realpathSync(parent) !== parent
           || (parentStat.mode & 0o077) || parentStat.uid !== process.getuid?.()) throw Error("project_attach_grant_invalid");
         const root = join(parent, "session-attach-grants");
         if (!existsSync(root)) mkdirSync(root, { mode: 0o700 });
         const stat = lstatSync(root);
         if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.uid !== process.getuid?.()) throw Error("project_attach_grant_invalid");
         const path = join(root, matches[0].grant_id);
          const claim = JSON.stringify({ request_id: t.request_id, session_id: session.nativeSessionId, child_name: t.child_name,
            ...(derivedBinding ? { derived_grant: derivedBinding } : {}) });
         if (existsSync(path)) { if (privateText(path) !== claim) throw Error("project_attach_grant_consumed"); }
         else { const fd = openSync(path, "wx", 0o600); try { writeFileSync(fd, claim); fsyncSync(fd); } finally { closeSync(fd); }
           const dir = openSync(root, "r"); try { fsyncSync(dir); } finally { closeSync(dir); } }
         nativeSessionId = session.nativeSessionId;
         serverPid = p.pid;
       } else if (grant.allow_new_session !== true) throw Error("project_selection_not_authorized");
       return { project: selected.directory, projectId: selected.nativeProjectId, endpoint: a.endpoint, password: a.password, nativeSessionId, serverPid,
         sharedVariantAuthority: grant.test_only_shared_variant === true ? { home: local.home, daemonWorkDir: local.daemonWorkDir,
           network_id: t.network_id, source_node_id: t.source_node_id, server_id: grant.server_id } : undefined };
    },
    async read(t: SourceDirectoryTask): Promise<SourceDirectorySnapshot> {
      local.checkpoint?.();
      if (process.platform !== "linux" || t.network_id !== local.networkId || t.daemon_node_id !== local.daemonId
        || !Number.isFinite(t.expires_at) || Date.now() >= t.expires_at || t.expires_at > Date.now() + 30000) throw Error("directory_scope_invalid");
      for (const [id, l] of leases) if (Date.now() >= l.selectionExpires + 300000) leases.delete(id);
      if (leases.size >= 100) throw Error("directory_limit");
      const a = authority(), grants = a.grants.filter(g => g.network_id === t.network_id && g.source_node_id === t.source_node_id);
      if (!grants.length || new Set(grants.map(g => g.server_id)).size !== grants.length) throw Error("directory_authority_missing");
      const snapshot: SourceDirectorySnapshot = { snapshot_id: `snap_${randomUUID()}`, expires_at: t.expires_at, lease_kind: "process_local",
         ...(local.projectSelectionEnabled || local.attachSelectionEnabled ? { selection_expires_at: t.expires_at + 600000 } : {}),
        servers: grants.map(g => ({ server_id: g.server_id, title: "Server" })), projects: [], sessions: [], completeness: "authorized_scope_only" };
      const selections = new Map<string, { directory: string; nativeProjectId?: string; nativeSessionId?: string }>();
      if (t.server_id !== undefined) {
        const grant = grants.find(g => g.server_id === t.server_id); if (!grant) throw Error("directory_scope_invalid");
        const get = async (path: string, authenticated = true): Promise<any> => {
          local.checkpoint?.();
          const r = await fetch(`${a.endpoint.opencodeSharedServerUrl}${path}`, { redirect: "error",
            signal: AbortSignal.any([AbortSignal.timeout(3000), ...(local.signal ? [local.signal] : [])]),
            headers: authenticated ? { authorization: `Basic ${Buffer.from(`opencode:${a.password}`).toString("base64")}` } : {} });
          if (!authenticated) { await r.body?.cancel(); if (r.status !== 401) throw Error("directory_auth_gate_missing"); return; }
          if (!r.ok) { await r.body?.cancel(); throw Error("directory_api_failed"); }
          const reader = r.body?.getReader(); if (!reader) throw Error("directory_api_failed");
          let size = 0; const parts: Uint8Array[] = [];
          try { for (;;) { const p = await reader.read(); if (p.done) break; size += p.value.length;
            if (size > 262144) throw Error("directory_limit"); parts.push(p.value); } }
          finally { await reader.cancel(); }
          local.checkpoint?.(); return JSON.parse(Buffer.concat(parts).toString("utf8"));
        };
        const info = await get("/api/info"); if (!await acceptsSharedVersion(a.endpoint.opencodeSharedServerUrl, info, grant.test_only_shared_variant === true)) throw Error("directory_version_invalid");
        await get("/api/info", false);
        const projects = await get("/api/project"), active = await get("/api/session/active");
        if (!Array.isArray(projects) || projects.length > 128
          || projects.some(p => typeof p?.id !== "string" || !p.id || p.id.length > 200 || typeof p.canonical !== "string"
            || !isAbsolute(p.canonical) || p.canonical.length > 1024 || (p.name !== undefined && typeof p.name !== "string"))
          || new Set(projects.map(p => p.id)).size !== projects.length || new Set(projects.map(p => p.canonical)).size !== projects.length
          || !active?.data || typeof active.data !== "object" || Array.isArray(active.data)
          || Object.keys(active.data).length > 1000 || Object.values(active.data).some((s: any) => s?.type !== "running")) throw Error("directory_api_invalid");
        for (const directory of grant.directories) {
          const found = projects.filter(p => p?.canonical === directory);
          if (found.length > 1) throw Error("directory_api_invalid");
          if (!found.length) continue; // known native projects only, no disk discovery
          const p = found[0]; if (typeof p.id !== "string" || !p.id || p.id.length > 200) throw Error("directory_api_invalid");
          const projectId = `oprj_${randomUUID()}`;
          snapshot.projects.push({ project_id: projectId, server_id: t.server_id, title: directoryTitle(p.name, "Project") });
          selections.set(projectId, { directory, nativeProjectId: p.id });
          const seen = new Set<string>();
          const cursors = new Set<string>(); let cursor: string | undefined;
          for (let pages = 0; ; pages++) {
            if (pages >= 4 || Date.now() >= t.expires_at) throw Error("directory_limit");
            const page = await get(`/api/session?directory=${encodeURIComponent(directory)}&project=${encodeURIComponent(p.id)}&limit=101${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
            if (!Array.isArray(page?.data) || page.data.length > 100 || !page.cursor || typeof page.cursor !== "object"
              || snapshot.sessions.length + page.data.length > 100) throw Error("directory_limit_or_invalid");
            for (const s of page.data) {
              if (typeof s?.id !== "string" || s.id.length > 200 || !/^ses_[A-Za-z0-9]+$/.test(s.id) || seen.has(s.id) || s.projectID !== p.id
                || s.location?.directory !== directory || (s.title !== undefined && typeof s.title !== "string")) throw Error("directory_api_scope_invalid");
              seen.add(s.id); const sessionId = `oses_${randomUUID()}`;
              snapshot.sessions.push({ session_id: sessionId, project_id: projectId, title: directoryTitle(s.title, "Session"),
                activity: Object.hasOwn(active.data, s.id) ? "running" : "unknown", binding: "unknown", attach_authorized: false });
              selections.set(sessionId, { directory, nativeSessionId: s.id });
            }
            // 2.0.22 emits a next cursor even on its final nonempty page.
            // Follow to the empty page; never interpret a cursor as completeness.
            // Native Effect optional encoding emits null for the final empty
            // page; older protocol fixtures omitted the field. Both terminate.
            if (page.cursor.next === undefined || page.cursor.next === null) break;
            if (typeof page.cursor.next !== "string" || page.cursor.next.length > 8192 || !page.data.length || cursors.has(page.cursor.next)) throw Error("directory_api_invalid");
            cursor = page.cursor.next; cursors.add(cursor);
          }
        }
      }
      if (a.fingerprint !== authority().fingerprint || Date.now() >= t.expires_at) throw Error("directory_scope_changed");
      leases.set(snapshot.snapshot_id, { task: structuredClone(t), authority: a.fingerprint, selections, selectionExpires: snapshot.selection_expires_at ?? t.expires_at });
      return snapshot;
    },
  };
}

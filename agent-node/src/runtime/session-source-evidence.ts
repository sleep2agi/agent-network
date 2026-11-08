// Linux process-local source leases plus an internal, guarded session resume/fork
// adapter. No start/reload/prompt/bridge takeover. Production dispatch is off.
import { randomUUID, createHash } from "node:crypto";
import { constants, openSync, closeSync, fstatSync, lstatSync, readFileSync, realpathSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { checkNodeName } from "../shared/node-name";
import { readChildWorkdirs, assertWorkdirAllowed } from "./child-workdir";
import { LAUNCH_HEALTH_FILE, readLiveProcess } from "./opencode-copresence/launcher-health";
import { findOwnedOpenCodeNodeDir } from "./opencode-catalog-dispatch";
import { readOpenCodeV2CatalogEndpoint } from "./opencode-v2-catalog-endpoint";
import { readOpenCodeCatalog } from "./opencode-v2-catalog";
import { observeHostSharedServe } from "./opencode-host-shared-observer";
import { isSourceReadChallenge, isSourceLeaseRecheck, sameSourceEvidence, type SourceLeaseRecheck, type SourceLeaseConfirmation,
  type SourceReadChallenge, type SourceReadEvidence } from "../../../contracts/session-source-evidence";
import { isSourceExecutionTask, type SourceExecutionTask, type SourceExecutionResult } from "../../../contracts/session-source-execution";
import { forkV2Session } from "./opencode-copresence/v2-fork";
import { resumeV2Session } from "./opencode-copresence/v2-resume";
import { isSourceNodeDelivery, type SourceNodeDelivery } from "../../../contracts/session-source-delivery";
import { sharedVariantAuthorized, observeSharedTestBuild, TEST_BUILD_VERSION, type SharedTestBuildEvidence } from "./opencode-copresence/v2-test-build-identity";
import { readV2ModelSelection, catalogSupportsVariants } from "./opencode-copresence/v2-model-selection";

// Cooperating daemon operations only, not a native Server-wide atomic idle gate.
const sourceExecutions = new Set<string>();

function directory(path: string) {
  const st = lstatSync(path, { bigint: true });
  if (!st.isDirectory() || st.isSymbolicLink() || realpathSync(path) !== path
    || st.uid !== BigInt(process.getuid!()) || (st.mode & 0o022n)) throw Error("source_directory_unsafe");
  return { dev: String(st.dev), ino: String(st.ino), uid: Number(st.uid) };
}
function privateRecord(path: string): any {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid!() || (st.mode & 0o077) || st.size > 65536) throw Error("source_config_unsafe");
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally { closeSync(fd); }
}
function localConfig(path: string, q: SourceReadChallenge): string {
    const v = privateRecord(path);
    if (v.node_id !== q.source_node_id || v.network_id !== q.network_id || v.runtime !== "opencode-cli"
      || v.opencodeGeneration !== "v2" || v.alias !== q.alias) throw Error("source_config_mismatch");
    return JSON.stringify([v.node_id, v.network_id, v.runtime, v.opencodeGeneration, v.alias, v.flags?.opencodeUnsafeTools,
      v.sessionId, v.sharedVariantAuthority, v.sourceDelivery]);
}
async function json(url: string, authorization: string, path: string, project: string, init: RequestInit = {}): Promise<any> {
  const response = await fetch(`${url}${path}`, { ...init, redirect: "error", signal: AbortSignal.timeout(3000),
    headers: { authorization, "x-opencode-directory": project, "content-type": "application/json" } });
  if (!response.ok) { await response.body?.cancel(); throw Error("source_api_unavailable"); }
  const reader = response.body?.getReader();
  if (!reader) throw Error("source_api_invalid");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.length;
      if (size > 32768) throw Error("source_api_too_large");
      chunks.push(part.value);
    }
  } finally { await reader.cancel(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export function createSessionSourceEvidenceReader(local: { networkId: string; daemonId: string; daemonWorkDir: string; home: string }) {
  // The Map and opaque lease IDs belong to this daemon instance only. A new
  // instance cannot recover them from files, API version strings or timestamps.
  const leases = new Map<string, { q: SourceReadChallenge; fingerprint: string; evidence: SourceReadEvidence; confirmed?: boolean; executed?: boolean;
    readySessionId?: string; executionId?: string; admissionId?: string }>();
  // Reader-held initial double-hash observations, never profile-supplied proofs.
  // Rechecks still re-read authority/registry and verify the exact incarnation.
  const testIdentities = new Map<string, SharedTestBuildEvidence>();
  const expire = () => { for (const [id, v] of leases) if (Date.now() >= v.q.expires_at) leases.delete(id); };
  async function probe(q: SourceReadChallenge) {
    if (process.platform !== "linux" || !isSourceReadChallenge(q) || q.network_id !== local.networkId
      || q.daemon_node_id !== local.daemonId || Date.now() >= q.expires_at || q.expires_at > Date.now() + 15000) throw Error("source_scope_refused");
    const name = checkNodeName(q.alias);
    if (!name.ok || name.name !== q.alias) throw Error("source_scope_refused");
    directory(local.daemonWorkDir); directory(join(local.daemonWorkDir, ".anet"));
    const registry = join(local.daemonWorkDir, ".anet", "child-workdirs.json");
    const registered = privateRecord(registry)?.[q.alias];
    const project = readChildWorkdirs(local.daemonWorkDir)[q.alias];
    if (registered !== project) throw Error("source_registry_changed");
    if (!project) throw Error("source_not_registered"); // no legacy cwd fallback
    assertWorkdirAllowed(project, { home: local.home });
    const identity = directory(project);
    const ancestors = [join(project, ".anet"), join(project, ".anet", "nodes")];
    const ancestry = ancestors.map(directory);
    const nodeDir = findOwnedOpenCodeNodeDir(local.daemonWorkDir, q.alias, q.source_node_id);
    if (!nodeDir) throw Error("source_not_owned");
    const nodeIdentity = directory(nodeDir);
    const config = localConfig(join(nodeDir, "config.json"), q);
    const endpoint = readOpenCodeV2CatalogEndpoint(nodeDir);
    if (!endpoint || endpoint.directory !== project || !/^[\x20-\x7e]+$/.test(project)) throw Error("source_endpoint_refused");
    const processAt = () => {
      const observed = observeHostSharedServe(endpoint.url);
      if (!observed.ok || observed.processEvidence.uid !== process.getuid!()
        || !Number.isSafeInteger(observed.processEvidence.startTicks)) throw Error("source_process_unavailable");
      const p = observed.processEvidence;
      return { pid: p.pid, start_ticks: String(p.startTicks), listen_inode: p.listenInode };
    };
    const server = processAt();
    const healthAt = () => {
      const h = privateRecord(join(nodeDir, LAUNCH_HEALTH_FILE));
      const bridge = readLiveProcess(h.bridge?.pid), serve = readLiveProcess(h.serve?.pid);
      if (h.version !== 1 || h.generation !== q.session_id || !bridge || !serve
        || bridge.ticks !== h.bridge.ticks || serve.ticks !== h.serve.ticks || serve.pid !== server.pid
        || serve.ticks !== server.start_ticks || (h.serveOwnership !== "shared" && serve.parent !== bridge.pid)) throw Error("source_runtime_not_live");
      // generation in this existing file is the SESSION ID, not incarnation.
      return JSON.stringify([bridge.pid, bridge.ticks, serve.pid, serve.ticks, h.generation]);
    };
    const health = healthAt();
    const info = await json(endpoint.url, endpoint.authorization, "/api/info", project);
    let version: SourceReadEvidence["api_version"] = "2.0.22";
    let sharedVariantAuthority: { home: string; daemonWorkDir: string; network_id: string; source_node_id: string; server_id: string } | undefined;
    let testIdentity: SharedTestBuildEvidence | undefined;
    const authorized = () => {
      const c = privateRecord(join(nodeDir, "config.json")), a = c.sharedVariantAuthority;
      const decoded = Buffer.from(endpoint.authorization.replace(/^Basic /, ""), "base64").toString("utf8");
      if (!a || a.home !== local.home || a.daemonWorkDir !== local.daemonWorkDir || a.network_id !== local.networkId
        || !endpoint.authorization.startsWith("Basic ") || !decoded.startsWith("opencode:")
        || !sharedVariantAuthorized(join(nodeDir, "config.json"), project, endpoint.url, decoded.slice(9), q.session_id, server.pid)) return undefined;
      return { home: local.home, daemonWorkDir: local.daemonWorkDir, network_id: local.networkId,
        source_node_id: a.source_node_id, server_id: a.server_id };
    };
    if (info?.pid !== server.pid) throw Error("source_version_mismatch");
    if (info.version !== "2.0.22") {
      if (info.version !== TEST_BUILD_VERSION || !(sharedVariantAuthority = authorized())) throw Error("source_version_mismatch");
      if (!testIdentities.has(nodeDir) && testIdentities.size >= 128) throw Error("source_reader_busy");
      testIdentity = await observeSharedTestBuild(endpoint.url, info.version, testIdentities.get(nodeDir));
      if (!testIdentity || testIdentity.pid !== server.pid) throw Error("source_version_mismatch");
      version = TEST_BUILD_VERSION;
    }
    const unauth = await fetch(`${endpoint.url}/api/info`, { redirect: "error", signal: AbortSignal.timeout(3000) });
    await unauth.body?.cancel();
    if (unauth.status !== 401) throw Error("source_auth_gate_missing");
    const session = (await json(endpoint.url, endpoint.authorization, `/api/session/${q.session_id}`, project))?.data;
    if (session?.id !== q.session_id || session?.location?.directory !== project) throw Error("source_session_scope_mismatch");
    if (testIdentity) {
      const started = performance.now();
      const catalog = await json(endpoint.url, endpoint.authorization, "/api/model", project);
      let selected = readV2ModelSelection({ data: session });
      if (session.model === undefined) {
        const d = await json(endpoint.url, endpoint.authorization, "/api/model/default", project);
        if (d?.location?.directory !== project) throw Error("source_catalog_scope");
        selected = readV2ModelSelection({ data: { model: d.data } });
      }
      const againSession = (await json(endpoint.url, endpoint.authorization, `/api/session/${q.session_id}`, project))?.data;
      if (!selected || !catalogSupportsVariants(catalog, project, selected) || performance.now() - started > 5000
        || againSession?.id !== q.session_id || againSession?.location?.directory !== project
        || JSON.stringify(againSession.model) !== JSON.stringify(session.model)
        || !authorized() || !await observeSharedTestBuild(endpoint.url, version, testIdentity)) throw Error("source_test_build_changed");
    }
    const again = readOpenCodeV2CatalogEndpoint(nodeDir);
    if (JSON.stringify(ancestry) !== JSON.stringify(ancestors.map(directory))
      || JSON.stringify(nodeIdentity) !== JSON.stringify(directory(nodeDir))) throw Error("source_changed");
    if (privateRecord(registry)?.[q.alias] !== project || readChildWorkdirs(local.daemonWorkDir)[q.alias] !== project || health !== healthAt()
      || JSON.stringify(server) !== JSON.stringify(processAt()) || JSON.stringify(identity) !== JSON.stringify(directory(project))
      || config !== localConfig(join(nodeDir, "config.json"), q) || JSON.stringify(again) !== JSON.stringify(endpoint)
      || Date.now() >= q.expires_at) throw Error("source_changed");
    // URL/auth stay local, hashed only for equality; neither is returned.
    const fingerprint = createHash("sha256").update(JSON.stringify([server, identity, config, endpoint, health, ancestry, nodeIdentity, version, testIdentity])).digest("hex");
    if (testIdentity) testIdentities.set(nodeDir, testIdentity);
    return { server, identity, project, fingerprint, endpoint, nodeDir, version, sharedVariantAuthority };
  }
  const reader = {
    /** Private source-aware profile handoff; endpoint auth never crosses Hub.
     * Attach cannot take the still-live source bridge required by this lease. */
    async deliver<T>(payload: SourceNodeDelivery, work: (context: { project: string; endpoint: { url: string; authorization: string }; model?: string;
      version: SourceReadEvidence["api_version"]; sharedVariantAuthority?: { home: string; daemonWorkDir: string; network_id: string; source_node_id: string; server_id: string } }) => Promise<T>): Promise<T | null> {
      expire();
      if (!isSourceNodeDelivery(payload) || Date.now() >= payload.expires_at) return null;
      const task = payload.execution, lease = leases.get(task.evidence.lease_id);
      if (!lease?.confirmed || !lease.executed || lease.readySessionId !== payload.session_id
        || lease.executionId !== task.execution_id || lease.admissionId !== task.admission_request_id || !sameSourceEvidence(lease.evidence, task.evidence)
        || lease.q.mode !== "fork_independent") return null;
      const key = `delivery:${lease.q.network_id}:${payload.session_id}`;
      if (sourceExecutions.has(key)) return null;
      sourceExecutions.add(key);
      try {
        const p = await probe(lease.q);
        if (p.fingerprint !== lease.fingerprint) return null;
        if (privateRecord(join(p.nodeDir, "config.json")).flags?.opencodeUnsafeTools !== true) return null;
        for (const name of readdirSync(join(p.project, ".anet", "nodes"))) {
          const dir = join(p.project, ".anet", "nodes", name), path = join(dir, LAUNCH_HEALTH_FILE);
          if (!existsSync(path)) continue;
          directory(dir); const h = privateRecord(path), live = readLiveProcess(h.bridge?.pid);
          if (h.generation === payload.session_id && h.serve?.pid === p.server.pid && live?.ticks === h.bridge?.ticks) return null;
        }
        const active = await json(p.endpoint.url, p.endpoint.authorization, "/api/session/active", p.project);
        if (!active?.data || typeof active.data !== "object" || Array.isArray(active.data) || Object.hasOwn(active.data, payload.session_id)) return null;
        const child = await resumeV2Session({ sessionId: payload.session_id, directory: p.project,
          request: path => json(p.endpoint.url, p.endpoint.authorization, path, p.project) });
        if (!await reader.recheck(task.evidence.lease_id) || Date.now() >= payload.expires_at) return null;
        const m = child.data.model;
        let model = typeof m?.providerID === "string" && typeof m?.id === "string" ? `${m.providerID}/${m.id}` : undefined;
        // Native full-history forks can retain no explicit Session model even
        // after a completed turn. The existing exact-resume core still requires
        // a model hint. Reuse project-new's read-only, directory-scoped catalog;
        // never guess/inject/reconcile a Session model or repeat the fork POST.
        if (!model) {
          const catalog = await readOpenCodeCatalog({ scope: { networkId: lease.q.network_id, daemonId: lease.q.daemon_node_id, directory: p.project },
            url: p.endpoint.url, authorization: p.endpoint.authorization, timeoutMs: 3000 });
          if (!catalog.defaultModel || catalog.defaultModel.providerId.includes("/")) return null;
          model = `${catalog.defaultModel.providerId}/${catalog.defaultModel.id}`;
          if (!await reader.recheck(task.evidence.lease_id) || Date.now() >= payload.expires_at) return null;
        }
        return await work({ project: p.project, endpoint: p.endpoint, model, version: p.version, sharedVariantAuthority: p.sharedVariantAuthority });
      } catch { return null; }
      finally { sourceExecutions.delete(key); }
    },
    async read(q: SourceReadChallenge): Promise<{ ok: true; evidence: SourceReadEvidence } | { ok: false; error: string }> {
      expire();
      if (leases.size >= 128) return { ok: false, error: "source_reader_busy" };
      try {
        const p = await probe(q), leaseId = `srcl_${randomUUID()}`;
        const evidence: SourceReadEvidence = { request: structuredClone(q), kind: "process_local_lease", lease_id: leaseId,
          api_version: p.version, canonical_directory: p.project, directory: p.identity, server: p.server };
        leases.set(leaseId, { q: structuredClone(q), fingerprint: p.fingerprint, evidence: structuredClone(evidence) });
        return { ok: true, evidence };
      } catch { return { ok: false, error: "source_evidence_refused" }; }
    },
    async recheck(leaseId: string): Promise<boolean> {
      expire(); const old = leases.get(leaseId); if (!old) return false;
      try {
        if ((await probe(old.q)).fingerprint === old.fingerprint) return true;
        leases.delete(leaseId); return false;
      }
      catch { leases.delete(leaseId); return false; }
    },
    async confirm(q: SourceLeaseRecheck): Promise<SourceLeaseConfirmation | null> {
      expire();
      if (!isSourceLeaseRecheck(q) || Date.now() >= q.expires_at) return null;
      const lease = leases.get(q.evidence.lease_id);
      if (!lease || lease.confirmed || !sameSourceEvidence(lease.evidence, q.evidence)) return null;
      // Mark before await: concurrent replays cannot both confirm this lease.
      lease.confirmed = true;
      if (!await reader.recheck(q.evidence.lease_id) || Date.now() >= q.expires_at) return null;
      return { request: structuredClone(q), outcome: "lease_current", execution: "daemon_recheck_in_execution_context_required" };
    },
    /** Only the authenticated source execution handler may call this with the
     * Hub-read task. Never starts/replaces a bridge, server or node. */
    async execute(task: SourceExecutionTask): Promise<SourceExecutionResult> {
      const result = (status: SourceExecutionResult["status"], sessionId?: string): SourceExecutionResult => ({
        execution_id: task.execution_id, admission_request_id: task.admission_request_id, status,
        bridge: "not_created", ...(sessionId ? { session_id: sessionId } : {}) });
      expire();
      if (!isSourceExecutionTask(task) || Date.now() >= task.authorized_until) return result("refused");
      const lease = leases.get(task.evidence.lease_id);
      if (!lease?.confirmed || lease.executed || !sameSourceEvidence(lease.evidence, task.evidence)) return result("refused");
      const q = lease.q, key = `${q.network_id}:${q.daemon_node_id}:${task.evidence.server.listen_inode}:${q.session_id}`;
      if (sourceExecutions.has(key)) return result("refused");
      sourceExecutions.add(key); lease.executed = true; lease.executionId = task.execution_id; lease.admissionId = task.admission_request_id;
      let attempted = false;
      try {
        const p = await probe(q);
        if (p.fingerprint !== lease.fingerprint) return result("refused");
        const current = async () => {
          if (Date.now() >= task.authorized_until || !await reader.recheck(task.evidence.lease_id)) throw Error("source_changed");
          // Same existing health record ownership, no takeover of another bridge.
          const nodes = join(p.project, ".anet", "nodes"), names = readdirSync(nodes);
          if (names.length > 128) throw Error("source_owners_ambiguous");
          for (const name of names) {
            const dir = join(nodes, name), health = join(dir, LAUNCH_HEALTH_FILE);
            if (dir === p.nodeDir || !existsSync(health)) continue;
            directory(dir);
            const other = privateRecord(health), live = readLiveProcess(other.bridge?.pid);
            if (other.generation === q.session_id && other.serve?.pid === p.server.pid && live?.ticks === other.bridge?.ticks)
              throw Error("source_bridge_conflict");
          }
          const active = await json(p.endpoint.url, p.endpoint.authorization, "/api/session/active", p.project);
          if (!active?.data || typeof active.data !== "object" || Array.isArray(active.data)
            || Object.values(active.data).some((v: any) => !v || v.type !== "running") || Object.hasOwn(active.data, q.session_id))
            throw Error("source_busy_or_unknown");
          if (Date.now() >= task.authorized_until) throw Error("source_expired");
        };
        const request = async (path: string, init: RequestInit = {}) => {
          await current();
          const method = init.method ?? "GET";
          if (method === "POST") {
            if (q.mode !== "fork_independent" || path !== `/api/session/${q.session_id}/fork`) throw Error("source_write_refused");
            attempted = true; // no retry, even HTTP outcome/ACK loss
          } else if (method !== "GET" || !/^\/api\/session\/ses_[A-Za-z0-9]+$/.test(path)) throw Error("source_path_refused");
          return json(p.endpoint.url, p.endpoint.authorization, path, p.project, init);
        };
        if (q.mode === "attach_existing") {
          const body = await resumeV2Session({ sessionId: q.session_id, directory: p.project, request });
          if (!await reader.recheck(task.evidence.lease_id)) return result("refused");
          lease.readySessionId = body.data.id;
          return result("session_ready", body.data.id); // existing owner retained, NO second bridge
        }
        const fork = await forkV2Session({ sourceSessionId: q.session_id, expectedDirectory: p.project, request });
        if (fork.status !== "forked") return result(attempted ? "unknown" : "refused");
        if (!await reader.recheck(task.evidence.lease_id)) return result("unknown");
        lease.readySessionId = fork.sessionId;
        return result("session_ready", fork.sessionId);
      } catch { return result(attempted ? "unknown" : "refused"); }
      finally { sourceExecutions.delete(key); }
    },
  };
  return reader;
}

/** Internal pull/read/ack adapter, deliberately not registered with an SSE event
 * or CLI fallback. The caller supplies the authenticated existing Hub transport. */
export async function handleSessionSourceEvidenceRead(id: string, deps: {
  take: (id: string) => Promise<SourceReadChallenge | null>;
  ack: (evidence: SourceReadEvidence) => Promise<boolean>;
  reader: ReturnType<typeof createSessionSourceEvidenceReader>;
}): Promise<boolean> {
  try {
    const q = await deps.take(id);
    if (!q || q.request_id !== id) return false;
    const result = await deps.reader.read(q);
    return result.ok && await deps.reader.recheck(result.evidence.lease_id) && await deps.ack(result.evidence);
  } catch { return false; }
}

/** Separate authenticated pull/ack round-trip for admission, never an execute
 * instruction. Lease_current acknowledges only the observation just completed. */
export async function handleSessionSourceLeaseRecheck(id: string, deps: {
  take: (id: string) => Promise<SourceLeaseRecheck | null>;
  ack: (confirmation: SourceLeaseConfirmation) => Promise<boolean>;
  reader: ReturnType<typeof createSessionSourceEvidenceReader>;
}): Promise<boolean> {
  try {
    const q = await deps.take(id);
    if (!q || q.evidence.request.request_id !== id) return false;
    const confirmation = await deps.reader.confirm(q);
    return !!confirmation && await deps.ack(confirmation);
  } catch { return false; }
}

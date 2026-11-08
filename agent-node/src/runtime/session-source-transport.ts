import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SessionControlPin } from "./session-control-bridge";
import { createSessionSourceEvidenceReader, handleSessionSourceEvidenceRead, handleSessionSourceLeaseRecheck } from "./session-source-evidence";
import { createSessionSourceExecutor, handleSessionSourceExecution } from "./session-source-execution";
import { createSessionSourceProfileWorker } from "./session-source-delivery";
import { verifySourceResumeLauncher } from "./source-resume-launcher";
import { loadAndVerifyAnetBin, minimalEnv } from "./create-node-daemon";
import { SOURCE_DELIVERY_CAPABILITY } from "../../../contracts/session-source-delivery";
import { SOURCE_FORK_ROOT as ROOT, SOURCE_FORK_CAPABILITY as CAP, type SourceForkTask } from "../../../contracts/session-source-transport";
import { SOURCE_DIRECTORY_CAPABILITY, isSourceDirectorySnapshot } from "../../../contracts/session-source-directory";
import { createSourceDirectoryReader } from "./session-source-directory";
import { createProjectSessionWorker } from "./session-project-create";
import { PROJECT_CREATE_ROOT, PROJECT_CREATE_CAPABILITY, SESSION_ATTACH_CAPABILITY } from "../../../contracts/session-project-create";

/** One frozen daemon identity, process-local reader, durable execution journal,
 * actual source-only profile worker. CLI calls tick independently of LLM work.
 * Neither transport loss nor worker reconstruction repeats a claimed phase. */
export function createSessionSourceTransportWorker(local: { pin: SessionControlPin; hubUrl: string; daemonWorkDir: string; home: string;
  directoryEnabled?: boolean; forkEnabled?: boolean; projectEnabled?: boolean; attachEnabled?: boolean;
  nativeLaunch?: Parameters<typeof createSessionSourceProfileWorker>[0]["nativeLaunch"] }) {
  const hub = new URL(local.hubUrl);
  if (hub.username || hub.password || hub.search || hub.hash || (hub.pathname !== "/" && hub.pathname !== "")
    || !(hub.protocol === "https:" || (hub.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(hub.hostname)))) {
    throw Error("source_transport_secure_hub_required");
  }
  const instance = randomUUID(), pin = local.pin;
  const directory = createSourceDirectoryReader({ home: local.home, daemonWorkDir: local.daemonWorkDir,
     networkId: pin.expected.network_id, daemonId: pin.expected.node_id, signal: pin.signal, checkpoint: () => pin.checkpoint(), projectSelectionEnabled: local.projectEnabled,
     attachSelectionEnabled: local.attachEnabled });
  const directoryPost = (path: string, body: object = {}) => pin.post(`${ROOT}/directory/${path}`,
    { expected: pin.expected, capability: SOURCE_DIRECTORY_CAPABILITY, instance_id: instance, ...body });
  const nativeLaunch = () => local.nativeLaunch ?? { command: loadAndVerifyAnetBin(), env: { ...minimalEnv(), HOME: local.home } };
   const declareDirectory = () => directoryPost("daemon", { ...(local.projectEnabled ? { project_create_capability: PROJECT_CREATE_CAPABILITY } : {}),
     ...(local.attachEnabled ? { session_attach_capability: SESSION_ATTACH_CAPABILITY } : {}) });
  const projectPost = (path: string, body: object = {}) => pin.post(`${PROJECT_CREATE_ROOT}/${path}`,
    { expected: pin.expected, capability: PROJECT_CREATE_CAPABILITY, instance_id: instance, ...body });
  let projectWorker: ReturnType<typeof createProjectSessionWorker> | null = null;
  const reader = local.forkEnabled === false ? null : createSessionSourceEvidenceReader({ networkId: pin.expected.network_id, daemonId: pin.expected.node_id,
    daemonWorkDir: local.daemonWorkDir, home: local.home });
  const journal = join(local.daemonWorkDir, ".anet", "source-execution-journal");
  if (reader) mkdirSync(journal, { recursive: true, mode: 0o700 });
  const executor = reader ? createSessionSourceExecutor(reader, journal) : null;
  let pending: Promise<void> | null = null;
  let verified = false;
  const base = { expected: pin.expected, capability: CAP, instance_id: instance };
  const post = async (path: string, body: object = {}) => pin.post(`${ROOT}/${path}`, { ...base, ...body });
  const children = new Map<string, ReturnType<typeof createSessionSourceProfileWorker>>();
  async function consume(t: SourceForkTask) {
    if (!reader || !executor) throw Error("source_fork_disabled");
    if (!t || t.network_id !== pin.expected.network_id || t.daemon_node_id !== pin.expected.node_id) throw Error("source_transport_scope");
    const envelope = { request_id: t.request_id, intent_id: t.intent_id, network_id: t.network_id,
      source_node_id: t.source_node_id, daemon_node_id: t.daemon_node_id };
    const ack = async (result: unknown) => { pin.checkpoint(); const r = await post("ack", { ...envelope, phase: t.phase, result }); return r.acknowledged === true; };
    let acknowledged = true;
    if (t.phase === "evidence") acknowledged = await handleSessionSourceEvidenceRead(t.task.request_id, { reader, take: async () => t.task, ack });
    else if (t.phase === "recheck") acknowledged = await handleSessionSourceLeaseRecheck(t.task.evidence.request.request_id, { reader, take: async () => t.task, ack });
    else if (t.phase === "execute") acknowledged = await handleSessionSourceExecution(t.task.execution_id, { executor, take: async () => t.task, ack });
    else if (t.phase === "deliver") {
      const worker = createSessionSourceProfileWorker({ enabled: true, capability: SOURCE_DELIVERY_CAPABILITY,
        daemonWorkDir: local.daemonWorkDir, bindingHome: local.home, hubUrl: hub.origin, reader, nativeLaunch: local.nativeLaunch,
        confirmRegistration: async (deliveryId, token) => {
          pin.checkpoint();
          // Child-only confirmation, using the one-shot delivered credential.
          // No token persistence, token rotation or retries on lost response.
          const r = await fetch(`${hub.origin}${ROOT}/child-register`, { method: "POST", redirect: "error",
            signal: AbortSignal.any([pin.signal, AbortSignal.timeout(5000)]), headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({ ...envelope, delivery_id: deliveryId }) });
          return r.ok && (await r.json()).status === "registration_confirmed";
        } });
      children.set(t.task.delivery_id, worker);
      const result = await worker.run(t.task); await ack(result);
    }
    if (!acknowledged) await ack({ transport_failure: "unknown_rotation_required" }); // negative-only convergence, no action retry
  }
  return {
    tick(): Promise<void> {
      if (pending) return pending;
      pending = (async () => {
        pin.checkpoint();
         if ((local.projectEnabled || local.attachEnabled) && !projectWorker) {
          await verifySourceResumeLauncher(nativeLaunch()); pin.checkpoint();
          projectWorker = createProjectSessionWorker({ reader: directory, home: local.home, daemonWorkDir: local.daemonWorkDir,
            hubUrl: hub.origin, checkpoint: () => pin.checkpoint(), signal: pin.signal, nativeLaunch: nativeLaunch(),
            confirm: async (requestId, token) => {
              pin.checkpoint(); await declareDirectory();
              const r = await fetch(`${hub.origin}${PROJECT_CREATE_ROOT}/child-register`, { method: "POST", redirect: "error",
                signal: AbortSignal.any([pin.signal, AbortSignal.timeout(5000)]), headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
                body: JSON.stringify({ request_id: requestId }) });
              return r.ok && (await r.json()).status === "registration_confirmed";
            } });
        }
        if (local.directoryEnabled) {
          await declareDirectory();
          for (let i = 0; i < 8; i++) {
            pin.checkpoint(); const r = await directoryPost("pull"); if (!r.task) break;
            let result: unknown;
            try { result = await directory.read(r.task); if (!isSourceDirectorySnapshot(result, r.task.expires_at)) throw Error("directory_invalid"); }
            catch { result = { error: "directory_read_failed" }; }
            pin.checkpoint(); await directoryPost("ack", { request_id: r.task.request_id, result });
          }
        }
        if ((local.projectEnabled || local.attachEnabled) && projectWorker) {
          for (let i = 0; i < 8; i++) {
            pin.checkpoint(); await declareDirectory(); const r = await projectPost("pull"); if (!r.task) break;
            const t = r.task.task;
            if (t.network_id !== pin.expected.network_id || t.daemon_node_id !== pin.expected.node_id) throw Error("project_create_scope");
            const result = r.task.phase === "create" ? await projectWorker.create(t)
              : r.task.phase === "deliver" ? await projectWorker.deliver(t) : { status: "unknown_rotation_required" };
            pin.checkpoint(); await declareDirectory(); await projectPost("ack", { request_id: t.request_id, result });
          }
        }
        if (local.forkEnabled === false) return;
        if (!verified) { await verifySourceResumeLauncher(local.nativeLaunch ?? { command: loadAndVerifyAnetBin(), env: { ...minimalEnv(), HOME: local.home } }); verified = true; }
        pin.checkpoint(); await post("daemon");
        for (let i = 0; i < 8; i++) { pin.checkpoint(); const r = await post("pull"); if (!r.task) break; await consume(r.task); }
      })().finally(() => { pending = null; }); return pending;
    },
    async stop() { pin.invalidate(); await projectWorker?.stop(); for (const [id, w] of children) await w.stopChild(id); children.clear(); },
  };
}

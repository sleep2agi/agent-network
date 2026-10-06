import { spawn } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { execTmux } from "../tmux.js";
import { atomicWriteJson } from "./config-apply.js";
import { getAnetBinAbs, minimalEnv } from "./create-node-daemon.js";
import { reproducibleEnvironment, type AdoptDaemonDeps } from "./adopt-daemon.js";
import { adoptedChild, writeAdoptedChild, type AdoptedChild } from "./adopt-registry.js";
import { verifyAdoptionLocalIdentity, verifyAdoptionProcess } from "./adopt-local-identity.js";
import { readAdoptionPid, readAdoptionProc } from "./adopt-proc.js";
import { processStamp, stopVerifiedTree } from "./adopt-process-tree.js";
import { captureLaunchEvidence, configHash, privateSocket } from "./adopt-launch-evidence.js";

export interface AdoptLifecycleRequest { request_id: string; child_node_id: string; child_alias: string; action: "start" | "stop" | "delete"; }
const queues = new Map<string, Promise<unknown>>();
export async function handleAdoptedLifecycle(req: AdoptLifecycleRequest, deps: AdoptDaemonDeps): Promise<boolean> {
  const key = `${deps.workDir}\0${req.child_node_id}`;
  const previous = queues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(() => handle(req, deps));
  queues.set(key, current);
  try { return await current; } finally { if (queues.get(key) === current) queues.delete(key); }
}
async function handle(req: AdoptLifecycleRequest, deps: AdoptDaemonDeps): Promise<boolean> {
  // Mandatory fresh authority before touching a locally adopted process. If the
  // registry is missing but Hub says adopted, never enter legacy cleanup.
  const live = await deps.callCommHub("list_my_children", {});
  if (!live?.ok || !Array.isArray(live.children)) throw Error("adopt_binding_unavailable");
  const entry = adoptedChild(deps.workDir, req.child_alias);
  const bound = live.children.some((c: any) => c.managed === "adopted" && c.child_node_id === req.child_node_id && c.alias === req.child_alias);
  if (!entry && !bound) return false;
  let result: Record<string, unknown>;
  try {
    if (!entry || !bound || entry.node_id !== req.child_node_id) throw Error("adopt_active_binding_required");
    if (req.action === "delete") throw Error("adopted_node_delete_unsupported");
    result = await operate(req, entry, deps);
  } catch (e: any) {
    result = { status: req.action === "start" ? "start_failed" : "stop_failed",
      error: /^adopt_[a-z_]+$/.test(e?.message ?? "") ? e.message : "adopt_lifecycle_verification_failed" };
  }
  // Ack transport failure is not an operation failure. Preserve local evidence
  // and let the request replay against PID/marker state rather than send a lie.
  await deps.callCommHub(req.action === "start" ? "ack_start_request" : "ack_stop_request", { request_id: req.request_id, ...result });
  return true;
}
async function operate(req: AdoptLifecycleRequest, entry: AdoptedChild, deps: AdoptDaemonDeps): Promise<Record<string, unknown>> {
  const identity = verifyAdoptionLocalIdentity({ node_id: entry.node_id, alias: req.child_alias, network_id: deps.networkId, workdir: entry.workdir }, deps);
  if (identity.nodeDir !== entry.nodeDir) throw Error("adopt_registry_identity_mismatch");
  const env = reproducibleEnvironment(identity, deps);
  const verify = () => {
    const pid = readAdoptionPid(identity.nodeDir), proc = pid ? readAdoptionProc(pid) : null;
    if (proc) {
      if (proc.pid === process.pid) throw Error("adopt_self_process_refused");
      verifyAdoptionProcess(identity, proc, { uid: deps.uid, home: deps.home,
        defaultTmuxSocket: env.ANET_TMUX_SOCKET || `/tmp/tmux-${deps.uid}/default`, reproducibleEnv: env });
    }
    return proc;
  };
  const marker = join(identity.nodeDir, ".hub-stopped");
  const proc = verify();
  if (req.action === "stop") {
    if (!proc) {
      if (!entry.launch_evidence || !existsSync(marker)) throw Error("adopt_stop_evidence_missing");
      return { status: "stopped" };
    }
    const evidence = captureLaunchEvidence(identity, proc);
    writeAdoptedChild(deps.workDir, req.child_alias, { ...entry, launch_evidence: evidence });
    const again = verify();
    if (!again || again.pid !== proc.pid || again.birth !== proc.birth) throw Error("adopt_process_generation_changed");
    const stamp = processStamp(proc.pid);
    if (!stamp || stamp.birth !== proc.birth || stamp.uid !== deps.uid) throw Error("adopt_process_generation_changed");
    await stopVerifiedTree(stamp);
    if (verify()) throw Error("adopt_process_still_running");
    atomicWriteJson(marker, { request_id: req.request_id, node_id: entry.node_id, stopped: true });
    return { status: "stopped" };
  }
  if (proc) {
    captureLaunchEvidence(identity, proc); // Recheck tmux ownership on idempotent start too.
    return { status: "started", child_pid: proc.pid };
  }
  const evidence = entry.launch_evidence;
  if (!evidence || !["bare", "tmux"].includes(evidence.mode) || evidence.config_hash !== configHash(identity)) throw Error("adopt_start_evidence_missing");
  const anet = getAnetBinAbs();
  const launchEnv = minimalEnv({}, "linux", { HOME: deps.home, LANG: deps.daemonEnv.LANG });
  if (evidence.mode === "tmux") {
    if (!evidence.socket || !evidence.session) throw Error("adopt_start_evidence_missing");
    privateSocket(evidence.socket, deps.uid);
    launchEnv.ANET_TMUX_SOCKET = evidence.socket;
    // Existing session is ambiguous (possibly another node/user's shell): do not
    // inject keys or kill its pane. A stopped session may be recreated by name.
    const sessions = execTmux(["list-sessions", "-F", "#{session_name}"], { encoding: "utf8", timeout: 5000, env: launchEnv }).trim().split("\n");
    if (sessions.includes(evidence.session)) throw Error("adopt_tmux_session_still_exists");
  }
  if (existsSync(marker)) unlinkSync(marker); // Remove BEFORE launch, as boot/start contract requires.
  try {
    if (evidence.mode === "tmux") {
      const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
      const clean = Object.entries(launchEnv).filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${quote(value!)}`).join(" ");
      execTmux(["new-session", "-d", "-s", evidence.session!, "-c", identity.workdir,
        `exec env -i ${clean} TMUX="$TMUX" TMUX_PANE="$TMUX_PANE" ${quote(anet)} node start ${quote(req.child_alias)}`], { env: launchEnv, timeout: 5000 });
    } else {
      const child = spawn(anet, ["node", "start", req.child_alias], { cwd: identity.workdir, env: launchEnv, detached: true, stdio: "ignore" });
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      child.unref();
    }
    for (let i = 0; i < 180; i++) {
      await new Promise(resolve => setTimeout(resolve, 250));
      const started = verify();
      if (!started) continue;
      const actual = captureLaunchEvidence(identity, started);
      if (actual.mode !== evidence.mode || (actual.mode === "tmux" && actual.socket !== evidence.socket)) throw Error("adopt_launch_mode_mismatch");
      writeAdoptedChild(deps.workDir, req.child_alias, { ...entry, launch_evidence: actual });
      return { status: "started", child_pid: started.pid };
    }
    throw Error("adopt_start_timeout");
  } catch (e) {
    atomicWriteJson(marker, { node_id: entry.node_id, start_failed: true });
    throw e;
  }
}

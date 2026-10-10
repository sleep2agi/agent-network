import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AdoptDaemonDeps } from "./adopt-daemon.js";
import { assertCodexStopped, stopCodexStages } from "./adopt-codex-stop.js";
import { readCodexScope } from "./adopt-codex-scope.js";
import { collectCodexPanes } from "./adopt-codex-tmux.js";
import { assertAppsrvOwnsListen } from "./adopt-codex-listen.js";
import { codexStartInputs, type CodexStartInputs } from "./adopt-codex-start-inputs.js";
import type { CodexAdoptionScope } from "./adopt-codex-evidence.js";
import { codexRoleNames } from "./adopt-codex-evidence.js";
import { verifyAdoptionLocalIdentity, type AdoptionLocalIdentity } from "./adopt-local-identity.js";
import { getAnetBinAbs, minimalEnv } from "./create-node-daemon.js";
import { adoptedChild, refreshAdoptedChild, type AdoptedChild } from "./adopt-registry.js";

const LAUNCH_TIMEOUT_MS = 600_000;
const HEARTBEAT_MS = 20_000;
const VERIFY_WAIT_MS = 3_000;
const RETRYABLE = new Set([
  "adopt_codex_stage_missing", "adopt_codex_identity_unproven", "adopt_codex_port_unproven",
  "adopt_codex_topology_changed", "adopt_process_generation_changed", "adopt_codex_stage_ambiguous",
  "adopt_codex_target_ambiguous", "adopt_tmux_listing_failed", "adopt_proc_unreadable",
  "adopt_codex_untracked_process",
]);

export interface AdoptedCodexStart {
  req: { request_id: string; child_alias: string };
  entry: AdoptedChild;
  identity: AdoptionLocalIdentity;
  scope: CodexAdoptionScope;
  deps: AdoptDaemonDeps;
  stillCurrent: () => boolean;
}

/** Native layout only. The external-appserver launcher does not publish the
 * adoption marker, so calling it would leave unmarked sessions behind.
 * This invokes the pinned `anet node start` and acknowledges only after the
 * rotated marker, three stages, and loopback listen all match. It does not
 * prove the Codex binary version or rollout ordinal. */
export async function startAdoptedNativeCodex(input: AdoptedCodexStart): Promise<{ status: "started"; child_pid: number }> {
  const { req, entry, identity, scope, deps, stillCurrent } = input;
  const saved = entry.codex_v2?.start_inputs;
  if (!saved) throw Error("adopt_codex_start_evidence_missing");
  const markerPath = join(identity.nodeDir, "copresence-identity.json");
  const markerBefore = readFileSync(markerPath);
  const stoppedPath = join(identity.nodeDir, ".hub-stopped");
  const hadStop = existsSync(stoppedPath);
  const supersede = captureStoppedReceipt(identity.nodeDir, entry.node_id);
  let committed = false;
  try {
    if (!stillCurrent()) throw Error("adopt_binding_revoked_during_start");
    await assertBinding(deps, entry, req.child_alias);
    await launchTrustedAnetStart(req.child_alias, identity.workdir, scope.socket, deps, req.request_id);
    const proved = await verifyReady(identity, scope, entry, deps, saved);
    if (!stillCurrent()) throw Error("adopt_binding_revoked_during_start");
    await assertBinding(deps, entry, req.child_alias);
    const pulled = await deps.callCommHub("get_start_request", { request_id: req.request_id });
    if (!pulled?.ok) throw Error("adopt_codex_start_superseded");
    refreshAdoptedChild(deps.workDir, req.child_alias, {
      ...entry,
      codex_v2: {
        version: 1, layout: proved.scope.layout, socket: proved.scope.socket, marker: proved.scope.marker,
        config_hash: proved.inputs.config_hash, start_inputs: proved.inputs,
      },
    });
    if (hadStop) {
      supersede();
      if (!resumeMatches(identity.nodeDir, entry.node_id)) throw Error("adopt_stop_receipt_changed");
    }
    committed = true;
    return { status: "started", child_pid: proved.childPid };
  } catch (error) {
    if (!committed) {
      try {
        await rollback(markerBefore, scope, identity, deps);
        const current = adoptedChild(deps.workDir, req.child_alias);
        if (current?.request_id === entry.request_id && current.codex_v2?.marker !== entry.codex_v2?.marker)
          refreshAdoptedChild(deps.workDir, req.child_alias, entry);
      } catch (rollbackError) { throw rollbackError; }
    }
    throw error;
  }
}

async function assertBinding(deps: AdoptDaemonDeps, entry: AdoptedChild, alias: string): Promise<void> {
  const live = await deps.callCommHub("list_my_children", {});
  if (!live?.ok || !Array.isArray(live.children)) throw Error("adopt_binding_unavailable");
  const row = live.children.find((child: any) => child.managed === "adopted" && child.child_node_id === entry.node_id && child.alias === alias);
  if (!row) throw Error("adopt_binding_revoked_during_start");
  if (row.binding_request_id !== entry.request_id) throw Error("adopt_codex_binding_generation_unproven");
}

async function launchTrustedAnetStart(alias: string, cwd: string, socket: string, deps: AdoptDaemonDeps, requestId: string): Promise<void> {
  let anet: string;
  try { anet = getAnetBinAbs(); }
  catch { throw Error("adopt_codex_launch_failed"); }
  const env = minimalEnv({}, "linux", { HOME: deps.home, LANG: deps.daemonEnv.LANG });
  env.ANET_TMUX_SOCKET = socket;
  const beat = () => { deps.callCommHub("ack_start_request", { request_id: requestId, status: "starting" }).catch(() => {}); };
  beat();
  const heartbeat = setInterval(beat, HEARTBEAT_MS);
  heartbeat.unref?.();
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); fn(); };
      const child = spawn(anet, ["node", "start", alias], { cwd, env, stdio: "ignore" });
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish(() => reject(Error("adopt_codex_launch_timeout")));
      }, LAUNCH_TIMEOUT_MS);
      child.once("error", () => finish(() => reject(Error("adopt_codex_launch_failed"))));
      child.once("exit", (code, signal) => {
        if (code === 0 && signal == null) finish(resolve);
        else finish(() => reject(Error("adopt_codex_launch_failed")));
      });
    });
  } finally { clearInterval(heartbeat); }
}

interface ProvedStart { scope: CodexAdoptionScope; inputs: CodexStartInputs; childPid: number }

async function verifyReady(identity: AdoptionLocalIdentity, scope: CodexAdoptionScope, entry: AdoptedChild, deps: AdoptDaemonDeps, saved: CodexStartInputs): Promise<ProvedStart> {
  const deadline = Date.now() + VERIFY_WAIT_MS;
  for (;;) {
    try { return prove(identity, scope, entry, deps, saved); }
    catch (error: any) {
      if (!RETRYABLE.has(error?.message) || Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
}

function prove(identity: AdoptionLocalIdentity, scope: CodexAdoptionScope, entry: AdoptedChild, deps: AdoptDaemonDeps, saved: CodexStartInputs): ProvedStart {
  const nextIdentity = verifyAdoptionLocalIdentity(
    { node_id: entry.node_id, alias: identity.alias, network_id: deps.networkId, workdir: entry.workdir },
    { ...deps, allowCodexV2: true });
  if (nextIdentity.nodeDir !== identity.nodeDir) throw Error("adopt_registry_identity_mismatch");
  const nextScope = readCodexScope(nextIdentity, deps.uid);
  if (nextScope.layout !== "native" || nextScope.socket !== scope.socket || nextScope.codexHome !== scope.codexHome
      || nextScope.alias !== scope.alias || nextScope.workdir !== scope.workdir || nextScope.uid !== scope.uid)
    throw Error("adopt_codex_binding_changed");
  const panes = collectCodexPanes(nextScope);
  assertAppsrvOwnsListen(nextScope, saved.appserver_url, panes);
  const inputs = codexStartInputs(nextIdentity, nextScope, entry.request_id);
  if (inputs.thread_id !== saved.thread_id || inputs.appserver_url !== saved.appserver_url
      || inputs.project_dir !== saved.project_dir || inputs.node_id !== saved.node_id)
    throw Error("adopt_codex_start_evidence_changed");
  const appsrv = panes.find(pane => pane.sessionName === codexRoleNames(nextScope).appsrv);
  if (!appsrv?.rootPid) throw Error("adopt_codex_stage_missing");
  return { scope: nextScope, inputs, childPid: appsrv.rootPid };
}

async function rollback(markerBefore: Buffer, previous: CodexAdoptionScope, identity: AdoptionLocalIdentity, deps: AdoptDaemonDeps): Promise<void> {
  let current: CodexAdoptionScope | null = null;
  try { current = readCodexScope(identity, deps.uid); } catch { current = null; }
  if (!current) throw Error("adopt_codex_marker_unsafe");
  if (current.marker !== previous.marker) await stopCodexStages(current);
  else await stopIfRunning(previous);
  assertCodexStopped(current.marker === previous.marker ? previous : current);
  assertCodexStopped(previous);
  const path = join(identity.nodeDir, "copresence-identity.json");
  if (!readFileSync(path).equals(markerBefore)) {
    const tmp = `${path}.restore-${process.pid}`;
    writeFileSync(tmp, markerBefore, { mode: 0o600, flag: "wx" });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  }
}

async function stopIfRunning(scope: CodexAdoptionScope): Promise<void> {
  try { assertCodexStopped(scope); }
  catch (error: any) {
    if (error?.message !== "adopt_codex_stage_still_running") throw error;
    await stopCodexStages(scope);
  }
}

function fingerprint(path: string, nodeId: string): string | null {
  try {
    const st = lstatSync(path, { bigint: true });
    if (!st.isFile() || st.isSymbolicLink() || st.uid !== BigInt(process.getuid?.() ?? -1) || (st.mode & 0o022n)) return null;
    const raw = readFileSync(path, "utf8");
    const data = JSON.parse(raw);
    if (!nodeId || data?.node_id !== nodeId || data.stopped !== true) return null;
    return `${st.ino}:${st.ctimeNs}:${createHash("sha256").update(raw).digest("hex")}`;
  } catch (error: any) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

/** Same certificate as agent-network `stoppedReceiptAtStart`. Captured before launch. */
function captureStoppedReceipt(nodeDir: string, nodeId: string): () => void {
  const path = join(nodeDir, ".hub-stopped");
  const before = fingerprint(path, nodeId);
  return () => {
    if (before === null || fingerprint(path, nodeId) !== before) return;
    const file = join(nodeDir, ".hub-resumed");
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ version: 1, node_id: nodeId, receipt_fingerprint: before }), { mode: 0o600, flag: "wx" });
      renameSync(tmp, file);
    } finally {
      try { unlinkSync(tmp); } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
    }
  };
}

function resumeMatches(nodeDir: string, nodeId: string): boolean {
  const now = fingerprint(join(nodeDir, ".hub-stopped"), nodeId);
  if (!now) return false;
  try {
    const cert = JSON.parse(readFileSync(join(nodeDir, ".hub-resumed"), "utf8"));
    return cert?.version === 1 && cert.node_id === nodeId && cert.receipt_fingerprint === now;
  } catch { return false; }
}

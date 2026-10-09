// #819: a co-presence launcher is finite, unlike a foreground runtime. Its PID
// proves only that launch began. The CLI's readiness checks decide completion.
import { spawn } from "node:child_process";
import { getAnetBinAbs, loadAndVerifyAnetBin, minimalEnv } from "./create-node-daemon.js";
import { forgetSpawnedChildIfPid, recordSpawnedChild } from "./stop-daemon.js";
import type { StartDoorbellDeps } from "./start-daemon.js";
import { readCodexForkEvidence, type CodexForkEvidence } from "./codex-fork-result.js";
import { supportsCodexForkRecovery } from "./codex-fork-capability.js";

type Result = ({ status: "started"; child_pid: number } | { status: "start_failed"; error: string })
  & { fork_recovery?: CodexForkEvidence };
type Entry = { requestId: string; running: boolean; result: Promise<Result> };
// One latest result per child, including a failed/lost ack. A doorbell replay in
// this daemon lifetime must not launch a second generation. This is not durable
// recovery across daemon restarts, nor evidence of ongoing runtime health.
const launches = new Map<string, Entry>();

export async function completeCodexStart(
  requestId: string, nodeId: string, alias: string, dirName: string, cwd: string,
  deps: StartDoorbellDeps,
  recovery?: { nodeDir: string },
): Promise<void> {
  const key = `${deps.workDir}\0${nodeId}`;
  let entry = launches.get(key);
  if (entry && entry.requestId !== requestId && entry.running) {
    throw new Error("codex_start_already_running");
  }
  if (!entry || entry.requestId !== requestId) {
    entry = { requestId, running: true, result: launch().then(result => recovery
      ? { ...result, fork_recovery: readCodexForkEvidence(recovery.nodeDir, requestId) }
      : result) };
    launches.set(key, entry);
    const current = entry;
    current.result = current.result.finally(() => { current.running = false; });
  }
  const result = await entry.result;
  // Transport failures propagate so the doorbell caller can release its dedup
  // entry. Keep the actual outcome above for a same-request replay.
  const ack = await deps.callCommHub("ack_start_request", { request_id: requestId, ...result });
  if (!ack?.ok) throw new Error(`codex_start_ack_rejected:${ack?.error || "invalid_ack"}`);
  deps.log(`[start-daemon] codex launcher ${result.status} alias=${alias}`);

  async function launch(): Promise<Result> {
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    try {
      // Recovery must re-read the current pin and integrity checks, not the
      // ordinary launcher's process-lifetime cached installation path.
      const bin = (deps.anetBin ?? (recovery ? loadAndVerifyAnetBin : getAnetBinAbs))();
      if (recovery && !await (deps.probeCodexForkRecovery ?? supportsCodexForkRecovery)(bin, cwd)) {
        return { status: "start_failed", error: "codex_fork_cli_unsupported" };
      }
      const progress = () => deps.callCommHub("ack_start_request", { request_id: requestId, status: "starting" });
      const admitted = await progress();
      if (!admitted?.ok || admitted.status !== "starting") {
        return { status: "start_failed", error: "codex_start_progress_not_available" };
      }
      let refreshing = false;
      heartbeat = setInterval(() => {
        if (refreshing) return;
        refreshing = true;
        void progress().then(r => {
          if (!r?.ok) deps.warn("[start-daemon] codex start progress rejected");
        }).catch(() => deps.warn("[start-daemon] codex start progress unavailable"))
          .finally(() => { refreshing = false; });
      }, 20_000);
      heartbeat.unref();
      const args = ["node", "start", dirName];
      if (recovery) args.push("--fork-on-resume-failure", "--yes", "--fork-recovery-request-id", requestId);
      const child = (deps.spawnChild ?? spawn)(bin, args, {
        cwd, env: minimalEnv(), stdio: ["ignore", "ignore", "ignore"], detached: true,
      });
      return await new Promise<Result>(resolve => {
        const pid = child.pid;
        const finish = (result: Result) => {
          if (pid) forgetSpawnedChildIfPid(nodeId, pid);
          resolve(result);
        };
        child.once("error", () => finish({ status: "start_failed", error: "codex_launcher_spawn_failed" }));
        child.once("exit", (code, signal) => finish(code === 0 && pid
          ? { status: "started", child_pid: pid }
          : { status: "start_failed", error: `codex_launcher_exit:${signal || code}` }));
        if (!pid) { finish({ status: "start_failed", error: "codex_launcher_no_pid" }); return; }
        recordSpawnedChild(nodeId, alias, pid);
        child.unref();
      });
    } catch {
      return { status: "start_failed", error: "codex_launcher_spawn_failed" };
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }
}

// Finite V2 launcher: spawn is progress, never evidence that the runtime is ready.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { getAnetBinAbs, minimalEnv } from "./create-node-daemon.js";
import { forgetSpawnedChildIfPid, recordSpawnedChild } from "./stop-daemon.js";
import { waitForLaunchHealth } from "./opencode-copresence/launcher-health.js";
import type { StartDoorbellDeps } from "./start-daemon.js";

type Result = { status: "started"; child_pid: number } | { status: "start_failed"; error: string };
type Entry = { requestId: string; running: boolean; result: Promise<Result> };
// Bounded to the latest request per local child. Replay deduplication is scoped
// to this daemon lifetime; this is not durable recovery or ongoing health.
const launches = new Map<string, Entry>();

export async function completeOpenCodeStart(
  requestId: string, nodeId: string, alias: string, dirName: string,
  cwd: string, nodeDir: string, deps: StartDoorbellDeps,
): Promise<void> {
  const key = `${deps.workDir}\0${nodeId}`;
  let entry = launches.get(key);
  if (entry && entry.requestId !== requestId && entry.running) throw new Error("opencode_start_already_running");
  if (!entry || entry.requestId !== requestId) {
    entry = { requestId, running: true, result: launch() };
    launches.set(key, entry);
    const current = entry;
    current.result = current.result.finally(() => { current.running = false; });
  }
  const result = await entry.result;
  const ack = await deps.callCommHub("ack_start_request", { request_id: requestId, ...result });
  if (!ack?.ok || ack.status !== result.status) throw new Error(`opencode_start_ack_rejected:${ack?.error || ack?.status || "invalid_ack"}`);
  deps.log(`[start-daemon] OpenCode launcher ${result.status} alias=${alias}`);

  async function launch(): Promise<Result> {
    try {
      const bin = (deps.anetBin ?? getAnetBinAbs)();
      const admitted = await deps.callCommHub("ack_start_request", { request_id: requestId, status: "starting" });
      if (!admitted?.ok || admitted.status !== "starting") return { status: "start_failed", error: "opencode_start_progress_not_available" };
      const launchedAt = Date.now();
      const child = (deps.spawnChild ?? spawn)(bin, ["node", "start", dirName], {
        cwd, env: minimalEnv(), stdio: ["ignore", "ignore", "ignore"], detached: true,
      });
      return await new Promise<Result>(resolve => {
        const pid = child.pid;
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (result: Result) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (pid) forgetSpawnedChildIfPid(nodeId, pid);
          if (result.status === "started") recordSpawnedChild(nodeId, alias, result.child_pid);
          resolve(result);
        };
        child.once("error", () => finish({ status: "start_failed", error: "opencode_launcher_spawn_failed" }));
        child.once("exit", (code, signal) => {
          void (async () => {
            if (settled) return;
            if (code !== 0 || signal !== null || !pid) {
              finish({ status: "start_failed", error: `opencode_launcher_exit:${signal || code}` });
              return;
            }
            const deadline = launchedAt + (deps.opencodeStartTimeoutMs ?? 35_000);
            const health = deps.inspectOpenCodeStartHealth
              ? deps.inspectOpenCodeStartHealth(nodeDir, join(nodeDir, "config.json"), launchedAt)
              : await (deps.waitOpenCodeStartHealth ?? waitForLaunchHealth)(nodeDir, join(nodeDir, "config.json"), launchedAt, deadline);
            if (settled) return;
            const error = !health.ok && health.reason === "TUI session mismatch"
              ? "opencode_tui_session_mismatch"
              : `opencode_launch_health:${health.ok ? "unsuccessful" : health.reason}`;
            finish(health.ok ? { status: "started", child_pid: health.bridgePid }
              : { status: "start_failed", error });
          })();
        });
        if (!pid) { finish({ status: "start_failed", error: "opencode_launcher_no_pid" }); return; }
        recordSpawnedChild(nodeId, alias, pid);
        timer = setTimeout(() => {
          // Only this still-owned launcher. Never kill by name or a recovered PID.
          try { child.kill("SIGTERM"); } catch {}
          finish({ status: "start_failed", error: "opencode_launcher_timeout" });
        }, deps.opencodeStartTimeoutMs ?? 35_000);
        child.unref();
      });
    } catch {
      return { status: "start_failed", error: "opencode_launcher_spawn_failed" };
    }
  }
}

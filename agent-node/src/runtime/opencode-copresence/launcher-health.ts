// #829: a tmux launcher exits successfully while its runtime remains alive.
// Linux-only evidence for daemon create, not a general readiness/security API.
import { constants, openSync, closeSync, fstatSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const LAUNCH_HEALTH_FILE = "opencode-launch-health.json";
export interface LiveProcess { pid: number; ticks: string; parent: number; state: string }
export function readLiveProcess(pid: number): LiveProcess | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 1) return;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    if (!/^\d+$/.test(fields[19] ?? "") || ["Z", "X", "x"].includes(fields[0])) return;
    return { pid, ticks: fields[19], parent: Number(fields[1]), state: fields[0] };
  } catch { return; }
}
export interface LaunchHealth {
  version: 1; generation: string; writtenAt: number;
  bridge: LiveProcess; serve: LiveProcess;
}
function readRecord(path: string): any {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || (st.mode & 0o022) !== 0
      || (process.getuid && st.uid !== process.getuid()) || st.size > 16384) throw new Error("unsafe health record");
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally { closeSync(fd); }
}

/** No tokens/ports in this record. Stale records alone can never pass. */
export function publishLaunchHealth(dir: string, generation: string, servePid: number): () => void {
  if (process.platform !== "linux") return () => {};
  const bridge = readLiveProcess(process.pid), serve = readLiveProcess(servePid);
  if (!bridge || !serve || serve.parent !== bridge.pid) throw new Error("OpenCode launch process identity unavailable");
  const record: LaunchHealth = { version: 1, generation, writtenAt: Date.now(), bridge, serve };
  const path = join(dir, LAUNCH_HEALTH_FILE), tmp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(record), { flag: "wx", mode: 0o600 });
    renameSync(tmp, path);
  } finally { rmSync(tmp, { force: true }); }
  return () => {
    try {
      const current = readRecord(path);
      if (current.generation === generation && current.bridge?.pid === bridge.pid
        && current.bridge?.ticks === bridge.ticks) rmSync(path);
    } catch { /* gone, unsafe, or replaced: never remove another generation */ }
  };
}

export interface HealthProbe {
  process: (pid: number) => LiveProcess | undefined;
  argv: (pid: number) => string[];
}
export function successfulLauncherExit(exit: { code: number | null; signal: string | null } | null): boolean {
  return exit?.code === 0 && exit.signal === null;
}
const procProbe: HealthProbe = {
  process: readLiveProcess,
  argv: (pid) => readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean),
};
export function validateLaunchHealth(
  record: LaunchHealth, attach: any, configPath: string, launchedAt: number,
  probe: HealthProbe = procProbe,
): { ok: true; bridgePid: number } | { ok: false; reason: string } {
  try {
    if (record?.version !== 1 || !Number.isFinite(record.writtenAt) || record.writtenAt < launchedAt
      || !/^ses_[A-Za-z0-9]+$/.test(record.generation) || attach?.gen !== record.generation) throw new Error("stale or mismatched generation");
    const identities = [record.bridge, record.serve, { pid: attach.pid, ticks: String(attach.startTicks) }];
    if (new Set(identities.map(p => p.pid)).size !== 3) throw new Error("overlapping process identities");
    for (const expected of identities) {
      const live = probe.process(expected.pid);
      if (!live || !/^\d+$/.test(expected.ticks) || live.ticks !== expected.ticks) throw new Error("dead or reused process identity");
    }
    if (probe.process(record.serve.pid)?.parent !== record.bridge.pid) throw new Error("serve parent mismatch");
    const bridgeArgs = probe.argv(record.bridge.pid);
    if (!bridgeArgs.some((v, i) => v === "--config" && bridgeArgs[i + 1] === configPath)) throw new Error("bridge config mismatch");
    const tuiArgs = probe.argv(attach.pid);
    if (!tuiArgs.some((v, i) => v === "--session" && tuiArgs[i + 1] === record.generation)) throw new Error("TUI session mismatch");
    return { ok: true, bridgePid: record.bridge.pid };
  } catch (e) { return { ok: false, reason: e instanceof Error ? e.message : "health unavailable" }; }
}
export function inspectLaunchHealth(dir: string, configPath: string, launchedAt: number) {
  if (process.platform !== "linux") return { ok: false as const, reason: "daemon V2 launch health requires Linux process identity" };
  try {
    return validateLaunchHealth(readRecord(join(dir, LAUNCH_HEALTH_FILE)),
      readRecord(join(dir, "opencode-attach.json")), configPath, launchedAt);
  } catch { return { ok: false as const, reason: "missing or unsafe launch/attach record" }; }
}

/** The attach shell publishes its PID before exec. A zero-exit launcher can
 * therefore precede matching TUI argv. Recheck the SAME full guard only within
 * the caller's existing deadline; missing/foreign identities never pass. */
export async function waitForLaunchHealth(
  dir: string, configPath: string, launchedAt: number, deadline: number,
  deps: {
    inspect?: typeof inspectLaunchHealth;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
) {
  const inspect = deps.inspect ?? inspectLaunchHealth;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  let health = inspect(dir, configPath, launchedAt);
  while (!health.ok && now() < deadline) {
    await sleep(Math.min(50, deadline - now()));
    if (now() >= deadline) break;
    health = inspect(dir, configPath, launchedAt);
  }
  return health;
}

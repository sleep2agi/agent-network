import { readFileSync } from "fs";
import { execFileSync } from "node:child_process";

/**
 * 进程组身份 = pid + pgrp + 启动时刻。
 *
 * 🔴 `startTicks` 不是装饰:它是 **PID 复用的唯一防线**。
 * 原进程死掉、系统把同一个 pid 分给别人时,pid 和 pgrp 都可能对得上 ——
 * 只有启动时刻对不上。少了它,`process.kill(-pgrp, SIGKILL)` 会杀掉
 * 一整个不相干的进程组。
 *
 * Linux 从 `/proc/<pid>/stat` 读(字段 22,0-based index 19)。
 * macOS 没有 /proc,用 `ps -o pgid=,lstart=`;`lstart` 扮演同一个角色。
 */
export interface LinuxProcessGroupIdentity {
  pid: number;
  pgrp: number;
  startTicks: string;
}

/** 注入点:测试用假的 ps,生产用 execFileSync。 */
export type ProcessGroupProbe = (pid: number) => string | undefined;

const defaultDarwinProbe: ProcessGroupProbe = (pid) => {
  try {
    // 🔴 LC_ALL=C:lstart 的格式随 locale 变。不钉住它,同一台机器换个语言
    // 环境就会产出不同的字符串,而这个字符串正是身份比对的一部分 ——
    // 那会让「同一个进程」在两次读取之间看起来像是换了一个。
    return execFileSync("ps", ["-o", "pgid=,lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
};

function readLinuxIdentity(pid: number): LinuxProcessGroupIdentity | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return undefined;
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    const pgrp = Number(fields[2]);
    const startTicks = fields[19];
    if (!Number.isSafeInteger(pgrp) || pgrp <= 1 || !/^\d+$/.test(startTicks ?? "")) return undefined;
    return { pid, pgrp, startTicks };
  } catch {
    return undefined;
  }
}

/** `ps -o pgid=,lstart= -p N` 的一行 → 身份。导出只为可测。 */
export function parseDarwinProcessGroupLine(
  pid: number,
  raw: string | undefined,
): LinuxProcessGroupIdentity | undefined {
  if (!raw) return undefined;
  const line = raw.split("\n").map((l) => l.trim()).filter(Boolean)[0];
  if (!line) return undefined;
  const m = /^(\d+)\s+(.+)$/.exec(line);
  if (!m) return undefined;
  const pgrp = Number(m[1]);
  const startTicks = m[2].trim();
  // 与 Linux 分支同一组下界:pgrp 必须是真实进程组,启动时刻必须非空。
  if (!Number.isSafeInteger(pgrp) || pgrp <= 1 || startTicks.length === 0) return undefined;
  return { pid, pgrp, startTicks };
}

export function readProcessGroupIdentity(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  probe: ProcessGroupProbe = defaultDarwinProbe,
): LinuxProcessGroupIdentity | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 1) return undefined;
  if (platform === "linux") return readLinuxIdentity(pid);
  if (platform === "darwin") return parseDarwinProcessGroupLine(pid, probe(pid));
  return undefined;
}

/** 保留旧名,调用方无需改动。 */
export function readLinuxProcessGroupIdentity(pid: number): LinuxProcessGroupIdentity | undefined {
  return readProcessGroupIdentity(pid);
}

export function sameLinuxProcessGroupIdentity(
  expected: LinuxProcessGroupIdentity,
  current = readLinuxProcessGroupIdentity(expected.pid),
): boolean {
  return current !== undefined
    && current.pid === expected.pid
    && current.pgrp === expected.pgrp
    && current.startTicks === expected.startTicks;
}

export function signalExactLinuxProcessGroup(
  expected: LinuxProcessGroupIdentity,
  signal: NodeJS.Signals,
): boolean {
  if (!sameLinuxProcessGroupIdentity(expected)) return false;
  try {
    process.kill(-expected.pgrp, signal);
    return true;
  } catch (error: any) {
    if (error?.code === "ESRCH") return true;
    throw error;
  }
}

export function linuxProcessGroupIsGone(expected: LinuxProcessGroupIdentity): boolean {
  return !sameLinuxProcessGroupIdentity(expected);
}

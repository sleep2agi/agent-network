import { readFileSync } from "fs";

export interface LinuxProcessGroupIdentity {
  pid: number;
  pgrp: number;
  startTicks: string;
}

export function readLinuxProcessGroupIdentity(pid: number): LinuxProcessGroupIdentity | undefined {
  if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid <= 1) return undefined;
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

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";

export type ProcRow = { pid: number; ppid: number; start: string };

function procStat(pid: number): ProcRow | null {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const end = raw.lastIndexOf(")");
    const fields = raw.slice(end + 2).split(" ");
    return { pid, ppid: Number(fields[1]), start: fields[19] };
  } catch { return null; }
}

function descendants(rows: ProcRow[], rootPid: number): Set<number> {
  const ids = new Set([rootPid]);
  for (;;) {
    let changed = false;
    for (const row of rows) if (ids.has(row.ppid) && !ids.has(row.pid)) { ids.add(row.pid); changed = true; }
    if (!changed) return ids;
  }
}

export function ownedConnectionFromSnapshot(
  rootPid: number,
  beforeStart: string | null,
  afterStart: string | null,
  rows: ProcRow[],
  socketOwners: ReadonlyMap<number, ReadonlySet<string>>,
  establishedInodes: ReadonlySet<string>,
  unread = false,
): boolean {
  if (unread || !beforeStart || afterStart !== beforeStart) return false;
  const ids = descendants(rows, rootPid);
  for (const pid of ids) for (const inode of socketOwners.get(pid) ?? []) {
    if (establishedInodes.has(inode)) return true;
  }
  return false;
}

function linuxEstablishedInodes(port: number): Set<string> {
  const wanted = port.toString(16).toUpperCase().padStart(4, "0");
  const result = new Set<string>();
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    const lines = readFileSync(file, "utf8").trim().split("\n").slice(1);
    for (const line of lines) {
      const f = line.trim().split(/\s+/);
      const [address, remotePort] = f[2].split(":");
      const loopback = address === "0100007F" || address === "0000000000000000FFFF00000100007F";
      if (loopback && remotePort === wanted && f[3] === "01") result.add(f[9]);
    }
  }
  return result;
}

/** Fail-closed attribution of an exact loopback connection to a managed POSIX TUI tree. */
export function probePosixOwnedLoopbackConnection(rootPid: number, port: number, platform = process.platform): boolean {
  if (!Number.isInteger(rootPid) || rootPid <= 0 || !Number.isInteger(port) || port < 1 || port > 65535) return false;
  if (platform === "linux") {
    try {
      const before = procStat(rootPid);
      if (!before) return false;
      const rows = readdirSync("/proc").filter((x) => /^\d+$/.test(x)).map(Number).map(procStat);
      if (rows.some((x) => x === null)) return false;
      const ids = descendants(rows as ProcRow[], rootPid);
      const inodes = linuxEstablishedInodes(port);
      if (inodes.size === 0) return false;
      const owners = new Map<number, Set<string>>();
      for (const pid of ids) {
        const fds = readdirSync(`/proc/${pid}/fd`);
        const owned = new Set<string>();
        for (const fd of fds) {
          try { const inode = readlinkSync(`/proc/${pid}/fd/${fd}`).match(/^socket:\[(\d+)\]$/)?.[1]; if (inode) owned.add(inode); }
          catch (error) {
            // A descriptor can close between readdir and readlink; it was not
            // present for the completed snapshot. Permission/parse failures
            // are different and must remain fail-closed.
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
            return false;
          }
        }
        owners.set(pid, owned);
      }
      const after = procStat(rootPid);
      return ownedConnectionFromSnapshot(rootPid, before.start, after?.start ?? null, rows as ProcRow[], owners, inodes);
    } catch { return false; }
  }
  if (platform === "darwin") {
    try {
      const before = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(rootPid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (!before) return false;
      const table = execFileSync("/bin/ps", ["-axo", "pid=,ppid="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const rows = table.trim().split("\n").map((line) => line.trim().split(/\s+/).map(Number)).map(([pid, ppid]) => ({ pid, ppid, start: "" }));
      const ids = [...descendants(rows, rootPid)];
      const out = execFileSync("/usr/sbin/lsof", ["-nP", "-a", "-p", ids.join(","), `-iTCP@127.0.0.1:${port}`, "-sTCP:ESTABLISHED", "-Fp"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const after = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(rootPid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      return /^p\d+$/m.test(out) && after === before;
    } catch { return false; }
  }
  return false;
}

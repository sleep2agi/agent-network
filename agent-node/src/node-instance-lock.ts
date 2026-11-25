/**
 * Single-instance lock for an agent-node directory (`<nodeDir>/agent-node.lock`).
 *
 * Prevents accidentally launching two local `agent-node` processes against the
 * same node directory / alias on one machine (which causes SSE / inbox /
 * session-file races and duplicate replies).
 *
 * Mechanism (zero extra child processes, works identically on Linux, macOS,
 * and Windows):
 *  1. Atomic `O_CREAT | O_EXCL | O_RDWR | O_NOFOLLOW` (`0o600`) creates
 *     `agent-node.lock` and writes `{ version, pid, alias, node_id, hostname,
 *     started_at, token }`, keeping the fd open for the lifetime of the
 *     process (on Windows an open fd also prevents other processes from
 *     unlinking the lock while alive; kernel closes it on crash / SIGKILL).
 *  2. On `EEXIST`, inspect the existing lock (refusing symlinks) and check
 *     whether `holder.pid` is alive via `process.kill(pid, 0)`:
 *       - Alive → refuse immediately with a plain-Chinese message naming the
 *         running PID and pointing to `anet node stop`.
 *       - Dead (stale lock left by `kill -9` / crash / power loss) → verify
 *         inode unchanged, unlink, and atomically retry `O_EXCL` (bounded so
 *         concurrent reclaimers have exactly one winner).
 *  3. `release()` closes our fd and unlinks `agent-node.lock` ONLY if the file
 *     still holds our exact `token` and `pid` (never deletes a newer owner's
 *     lock).
 */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { hostname as osHostname } from "node:os";
import { join } from "node:path";

export const NODE_INSTANCE_LOCK_FILE = "agent-node.lock";

export interface NodeInstanceLockRecord {
  version: 1;
  pid: number;
  alias: string;
  node_id?: string | null;
  hostname: string;
  started_at: string;
  /** Linux `/proc/sys/kernel/random/boot_id` when available; mismatch after reboot proves stale PID reuse. */
  boot_id?: string | null;
  token: string;
}

export interface NodeInstanceLockHandle {
  lockPath: string;
  record: NodeInstanceLockRecord;
  release(): void;
}

export type AcquireNodeInstanceLockResult =
  | { ok: true; handle: NodeInstanceLockHandle; reclaimedStalePid?: number }
  | {
      ok: false;
      reason: "already_running" | "unsafe_lock_file" | "io_error";
      lockPath: string;
      holderPid?: number | null;
      holderAlias?: string | null;
      message: string;
    };

export interface AcquireNodeInstanceLockOptions {
  pid?: number;
  hostname?: string;
  bootId?: string | null;
  now?: () => Date;
  isPidAlive?: (pid: number) => boolean;
  /** Optional process command-line reader (defaults to Linux `/proc/<pid>/cmdline`) to detect PID reuse. */
  readPidCmdline?: (pid: number) => string | null;
  /** Max retries when competing to reclaim a stale lock or waiting for an in-progress write. */
  maxAttempts?: number;
  /** Short wait between retries when an existing lock file is freshly created and empty. */
  retryDelayMs?: number;
}

export function readLinuxBootId(): string | null {
  if (process.platform !== "linux") return null;
  try {
    const raw = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return raw || null;
  } catch {
    return null;
  }
}

export function defaultReadPidCmdline(pid: number): string | null {
  if (process.platform !== "linux" || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0+/g, " ").trim();
    return raw || null;
  } catch {
    return null;
  }
}

/** Returns false only when we have positive proof the PID belongs to an unrelated program. */
export function cmdlineLooksLikeAgentNode(cmdline: string | null): boolean {
  if (!cmdline) return true; // unreadable or non-Linux: stay conservative (do not falsely reclaim)
  return /\b(node|bun|agent-node|anet)(\.exe)?\b|agent-node|cli\.(ts|js)/i.test(cmdline);
}

export function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // EPERM means the process exists, just owned by another user.
    if (err?.code === "EPERM") return true;
    return false;
  }
}

export function formatDuplicateNodeMessage(holderPid?: number | null, alias?: string | null): string {
  const pidPart = holderPid && Number.isInteger(holderPid) && holderPid > 0 ? `（PID ${holderPid}）` : "";
  const stopCmd = alias && alias.trim() ? `anet node stop ${alias.trim()}` : "anet node stop";
  return `这个 AI 已经在这台机器上运行${pidPart}，不用再启动；要重启请先 ${stopCmd}`;
}

function parseLockRecord(raw: string): Partial<NodeInstanceLockRecord> | null {
  if (!raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Partial<NodeInstanceLockRecord>;
    }
  } catch {
    // Corrupt / truncated lock file — treat as unparseable.
  }
  return null;
}

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* fallback busy-wait for tiny ms */ }
  }
}

function readExistingLockSafe(lockPath: string):
  | { kind: "missing" }
  | { kind: "symlink" }
  | { kind: "ok"; raw: string; mtimeMs: number; dev: number; ino: number }
  | { kind: "error"; error: any } {
  let lst;
  try {
    lst = lstatSync(lockPath);
  } catch (err: any) {
    if (err?.code === "ENOENT") return { kind: "missing" };
    return { kind: "error", error: err };
  }
  if (lst.isSymbolicLink() || !lst.isFile()) return { kind: "symlink" };
  let fd: number | null = null;
  try {
    fd = openSync(lockPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const st = fstatSync(fd);
    if (!st.isFile()) return { kind: "symlink" };
    const raw = readFileSync(fd, "utf8");
    return { kind: "ok", raw, mtimeMs: st.mtimeMs, dev: st.dev, ino: st.ino };
  } catch (err: any) {
    if (err?.code === "ENOENT") return { kind: "missing" };
    if (err?.code === "ELOOP") return { kind: "symlink" };
    return { kind: "error", error: err };
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

export function acquireNodeInstanceLock(
  nodeDir: string,
  meta: { alias: string; nodeId?: string | null },
  options: AcquireNodeInstanceLockOptions = {},
): AcquireNodeInstanceLockResult {
  const lockPath = join(nodeDir, NODE_INSTANCE_LOCK_FILE);
  const myPid = options.pid ?? process.pid;
  const host = options.hostname ?? osHostname();
  const currentBootId = options.bootId !== undefined ? options.bootId : readLinuxBootId();
  const now = options.now ?? (() => new Date());
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  const readPidCmdline = options.readPidCmdline ?? defaultReadPidCmdline;
  const maxAttempts = Math.max(1, options.maxAttempts ?? 4);
  const retryDelayMs = options.retryDelayMs ?? 15;

  try {
    mkdirSync(nodeDir, { recursive: true, mode: 0o700 });
  } catch (err: any) {
    return {
      ok: false,
      reason: "io_error",
      lockPath,
      message: `无法创建节点锁目录（${nodeDir}）：${err?.message || err}`,
    };
  }

  let reclaimedStalePid: number | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Explicit pre-open lstat guard so symlinks/non-regular files are refused on Windows too
    // (where constants.O_NOFOLLOW is 0).
    try {
      const pre = lstatSync(lockPath);
      if (pre.isSymbolicLink() || !pre.isFile()) {
        return {
          ok: false,
          reason: "unsafe_lock_file",
          lockPath,
          message: `拒绝启动：节点锁文件不是普通文件（${lockPath}）`,
        };
      }
    } catch (preErr: any) {
      if (preErr?.code !== "ENOENT") {
        return {
          ok: false,
          reason: "io_error",
          lockPath,
          message: `无法检查节点运行锁（${lockPath}）：${preErr?.message || preErr}`,
        };
      }
    }

    const record: NodeInstanceLockRecord = {
      version: 1,
      pid: myPid,
      alias: meta.alias,
      ...(meta.nodeId ? { node_id: meta.nodeId } : {}),
      hostname: host,
      started_at: now().toISOString(),
      ...(currentBootId ? { boot_id: currentBootId } : {}),
      token: randomUUID(),
    };

    let fd: number | null = null;
    try {
      fd = openSync(
        lockPath,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0),
        0o600,
      );
      const payload = `${JSON.stringify(record)}\n`;
      writeSync(fd, payload, 0, "utf8");
      try { fsyncSync(fd); } catch { /* some virtual fs skip fsync */ }

      const heldFd = fd;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        try { closeSync(heldFd); } catch { /* already closed */ }
        // Only unlink if the file on disk still belongs to this exact lock instance.
        const current = readExistingLockSafe(lockPath);
        if (current.kind === "ok") {
          const parsed = parseLockRecord(current.raw);
          if (parsed?.token === record.token && parsed?.pid === record.pid) {
            try { unlinkSync(lockPath); } catch { /* ignore */ }
          }
        }
      };

      return {
        ok: true,
        handle: { lockPath, record, release },
        ...(reclaimedStalePid !== undefined ? { reclaimedStalePid } : {}),
      };
    } catch (err: any) {
      if (fd !== null) {
        try { closeSync(fd); } catch { /* ignore */ }
      }
      if (err?.code === "ELOOP") {
        return {
          ok: false,
          reason: "unsafe_lock_file",
          lockPath,
          message: `拒绝启动：节点锁文件不是普通文件（${lockPath}）`,
        };
      }
      if (err?.code !== "EEXIST") {
        return {
          ok: false,
          reason: "io_error",
          lockPath,
          message: `无法获取节点运行锁（${lockPath}）：${err?.message || err}`,
        };
      }
    }

    // Lock file exists — inspect holder and decide reject vs stale-reclaim.
    const existing = readExistingLockSafe(lockPath);
    if (existing.kind === "missing") {
      // Previous holder just exited; retry acquire immediately.
      continue;
    }
    if (existing.kind === "symlink") {
      return {
        ok: false,
        reason: "unsafe_lock_file",
        lockPath,
        message: `拒绝启动：节点锁文件不是普通文件（${lockPath}）`,
      };
    }
    if (existing.kind === "error") {
      // On Windows an actively held/locked file can report EPERM/EBUSY on read.
      if (existing.error?.code === "EPERM" || existing.error?.code === "EBUSY") {
        return {
          ok: false,
          reason: "already_running",
          lockPath,
          holderPid: null,
          holderAlias: meta.alias,
          message: formatDuplicateNodeMessage(null, meta.alias),
        };
      }
      return {
        ok: false,
        reason: "io_error",
        lockPath,
        message: `无法读取节点运行锁（${lockPath}）：${existing.error?.message || existing.error}`,
      };
    }

    const holder = parseLockRecord(existing.raw);
    const holderPid = typeof holder?.pid === "number" && Number.isInteger(holder.pid) && holder.pid > 0
      ? holder.pid
      : null;
    const holderAlias = typeof holder?.alias === "string" && holder.alias.trim()
      ? holder.alias.trim()
      : meta.alias;

    // Freshly created empty file (microsecond race between O_EXCL and writeSync).
    if (holderPid === null && !existing.raw.trim() && Date.now() - existing.mtimeMs < 2_000) {
      if (attempt + 1 < maxAttempts) {
        sleepSync(retryDelayMs);
        continue;
      }
      return {
        ok: false,
        reason: "already_running",
        lockPath,
        holderPid: null,
        holderAlias,
        message: formatDuplicateNodeMessage(null, holderAlias),
      };
    }

    const rebooted = !!(currentBootId && typeof holder?.boot_id === "string" && holder.boot_id && holder.boot_id !== currentBootId);
    const holderAlive = !rebooted
      && holderPid !== null
      && isPidAlive(holderPid)
      && cmdlineLooksLikeAgentNode(readPidCmdline(holderPid));

    if (holderAlive) {
      return {
        ok: false,
        reason: "already_running",
        lockPath,
        holderPid,
        holderAlias,
        message: formatDuplicateNodeMessage(holderPid, holderAlias),
      };
    }

    // Stale lock (dead PID or corrupt leftovers) — verify inode unchanged, then unlink & retry.
    try {
      const check = lstatSync(lockPath);
      if (check.isSymbolicLink() || !check.isFile()) {
        return {
          ok: false,
          reason: "unsafe_lock_file",
          lockPath,
          message: `拒绝启动：节点锁文件不是普通文件（${lockPath}）`,
        };
      }
      if (check.dev === existing.dev && check.ino === existing.ino) {
        unlinkSync(lockPath);
        if (holderPid !== null) reclaimedStalePid = holderPid;
      }
    } catch (unlinkErr: any) {
      if (unlinkErr?.code === "EPERM" || unlinkErr?.code === "EBUSY") {
        // Windows refuses unlink while another live process holds the fd open.
        return {
          ok: false,
          reason: "already_running",
          lockPath,
          holderPid,
          holderAlias,
          message: formatDuplicateNodeMessage(holderPid, holderAlias),
        };
      }
      if (unlinkErr?.code !== "ENOENT") {
        return {
          ok: false,
          reason: "io_error",
          lockPath,
          message: `清理过期节点锁失败（${lockPath}）：${unlinkErr?.message || unlinkErr}`,
        };
      }
    }
  }

  return {
    ok: false,
    reason: "already_running",
    lockPath,
    holderPid: null,
    holderAlias: meta.alias,
    message: formatDuplicateNodeMessage(null, meta.alias),
  };
}

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NODE_INSTANCE_LOCK_FILE,
  acquireNodeInstanceLock,
  formatDuplicateNodeMessage,
} from "./node-instance-lock.js";

const dirs: string[] = [];
const mkDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "anet-node-lock-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  while (dirs.length) {
    try { rmSync(dirs.pop()!, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("agent-node single-instance lock (agent-node.lock)", () => {
  test("acquires lock, writes PID metadata, and removes lock cleanly on release", () => {
    const dir = mkDir();
    const res = acquireNodeInstanceLock(dir, { alias: "神鸽", nodeId: "n_test" }, { pid: 42424 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const lockPath = join(dir, NODE_INSTANCE_LOCK_FILE);
    expect(existsSync(lockPath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(lockPath, "utf8"));
    expect(onDisk.pid).toBe(42424);
    expect(onDisk.alias).toBe("神鸽");
    expect(onDisk.node_id).toBe("n_test");
    expect(typeof onDisk.token).toBe("string");

    res.handle.release();
    expect(existsSync(lockPath)).toBe(false);
    // Idempotent release does not throw.
    res.handle.release();
  });

  test("refuses second start when holder PID is alive and prints plain-Chinese message", () => {
    const dir = mkDir();
    const lockPath = join(dir, NODE_INSTANCE_LOCK_FILE);
    const first = acquireNodeInstanceLock(dir, { alias: "神鸽" }, { pid: 55123, isPidAlive: () => true, readPidCmdline: () => null });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = acquireNodeInstanceLock(dir, { alias: "神鸽" }, { pid: 55999, isPidAlive: (p) => p === 55123, readPidCmdline: () => null });
    expect(second.ok).toBe(false);
    if (second.ok) return;

    expect(second.reason).toBe("already_running");
    expect(second.holderPid).toBe(55123);
    expect(second.message).toBe(`这个 AI 已经在这台机器上运行（PID 55123），不用再启动；要重启请先 anet node stop 神鸽；如果确认它没在运行，删除 ${lockPath} 后再启动`);

    first.handle.release();
    // After the first instance exits/releases, a fresh start succeeds.
    const third = acquireNodeInstanceLock(dir, { alias: "神鸽" }, { pid: 55999, isPidAlive: () => false, readPidCmdline: () => null });
    expect(third.ok).toBe(true);
    if (third.ok) third.handle.release();
  });

  test("reclaims stale lock left behind by a dead PID (e.g. kill -9 / crash)", () => {
    const dir = mkDir();
    const lockPath = join(dir, NODE_INSTANCE_LOCK_FILE);
    writeFileSync(
      lockPath,
      JSON.stringify({ version: 1, pid: 999991, alias: "神鸽", hostname: "host", started_at: "2026-11-25T00:00:00Z", token: "dead-tok" }),
      { mode: 0o600 },
    );

    const res = acquireNodeInstanceLock(dir, { alias: "神鸽" }, { pid: 77777, isPidAlive: () => false });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.reclaimedStalePid).toBe(999991);
    const onDisk = JSON.parse(readFileSync(lockPath, "utf8"));
    expect(onDisk.pid).toBe(77777);
    res.handle.release();
  });

  test("refuses symlinked agent-node.lock (fail-closed)", () => {
    const dir = mkDir();
    const targetDir = mkDir();
    const target = join(targetDir, "victim.txt");
    writeFileSync(target, "keep-me");
    symlinkSync(target, join(dir, NODE_INSTANCE_LOCK_FILE));

    const res = acquireNodeInstanceLock(dir, { alias: "神鸽" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("unsafe_lock_file");
    expect(readFileSync(target, "utf8")).toBe("keep-me");
  });

  test("refuses symlinked agent-node.lock even when O_NOFOLLOW is unavailable (Windows simulation)", () => {
    const dir = mkDir();
    const targetDir = mkDir();
    const existingTarget = join(targetDir, "victim.txt");
    writeFileSync(existingTarget, "untouched");
    symlinkSync(existingTarget, join(dir, NODE_INSTANCE_LOCK_FILE));

    const existingRes = acquireNodeInstanceLock(dir, { alias: "神鸽" }, { noFollowFlag: 0 });
    expect(existingRes.ok).toBe(false);
    if (!existingRes.ok) {
      expect(existingRes.reason).toBe("unsafe_lock_file");
    }
    expect(readFileSync(existingTarget, "utf8")).toBe("untouched");

    // Also verify a dangling symlink (target does not exist yet) is refused without creating the target.
    const danglingDir = mkDir();
    const missingTarget = join(targetDir, "should-not-be-created.txt");
    symlinkSync(missingTarget, join(danglingDir, NODE_INSTANCE_LOCK_FILE));

    const danglingRes = acquireNodeInstanceLock(danglingDir, { alias: "神鸽" }, { noFollowFlag: 0 });
    expect(danglingRes.ok).toBe(false);
    if (!danglingRes.ok) {
      expect(danglingRes.reason).toBe("unsafe_lock_file");
    }
    expect(existsSync(missingTarget)).toBe(false);
  });

  test("release() never unlinks a lock file owned by a different token/PID", () => {
    const dir = mkDir();
    const first = acquireNodeInstanceLock(dir, { alias: "神鸽" }, { pid: 10001 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Simulate another process having reclaimed the path with a new token.
    const lockPath = join(dir, NODE_INSTANCE_LOCK_FILE);
    writeFileSync(
      lockPath,
      JSON.stringify({ version: 1, pid: 20002, alias: "神鸽", hostname: "host", started_at: "2026-11-25T00:01:00Z", token: "new-owner-token" }),
    );
    first.handle.release();
    expect(existsSync(lockPath)).toBe(true);
    const remaining = JSON.parse(readFileSync(lockPath, "utf8"));
    expect(remaining.pid).toBe(20002);
  });

  test("formatDuplicateNodeMessage works with and without alias / PID", () => {
    const lockPath = "/tmp/anet-node-demo/agent-node.lock";
    expect(formatDuplicateNodeMessage(1234, "通信鸽", lockPath)).toBe(
      `这个 AI 已经在这台机器上运行（PID 1234），不用再启动；要重启请先 anet node stop 通信鸽；如果确认它没在运行，删除 ${lockPath} 后再启动`,
    );
    expect(formatDuplicateNodeMessage(1234, "", lockPath)).toBe(
      `这个 AI 已经在这台机器上运行（PID 1234），不用再启动；要重启请先 anet node stop；如果确认它没在运行，删除 ${lockPath} 后再启动`,
    );
    expect(formatDuplicateNodeMessage(null, "通信鸽", lockPath)).toBe(
      `这个 AI 已经在这台机器上运行，不用再启动；要重启请先 anet node stop 通信鸽；如果确认它没在运行，删除 ${lockPath} 后再启动`,
    );
  });

  test("cli.ts wires acquireNodeInstanceLock early and releases on exit + shutdown", () => {
    const cli = readFileSync(new URL("./cli.ts", import.meta.url), "utf8");
    expect(cli).toContain("acquireNodeInstanceLock");
    expect(cli).toContain("instanceLock?.release()");
    expect(cli).toContain('process.on("exit", () => instanceLock?.release())');
  });

  test("reclaims lock when boot_id changed after reboot even if PID number was reused", () => {
    const dir = mkDir();
    const lockPath = join(dir, NODE_INSTANCE_LOCK_FILE);
    writeFileSync(
      lockPath,
      JSON.stringify({ version: 1, pid: 1234, alias: "神鸽", hostname: "host", boot_id: "boot-old", started_at: "2026-11-24T00:00:00Z", token: "old-tok" }),
      { mode: 0o600 },
    );

    const res = acquireNodeInstanceLock(dir, { alias: "神鸽" }, {
      pid: 9999,
      bootId: "boot-new",
      isPidAlive: () => true,
      readPidCmdline: () => "bun /app/agent-node/dist/cli.js",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.reclaimedStalePid).toBe(1234);
    res.handle.release();
  });

  test("reclaims lock when live PID belongs to an unrelated binary (Linux PID reuse)", () => {
    const dir = mkDir();
    const lockPath = join(dir, NODE_INSTANCE_LOCK_FILE);
    writeFileSync(
      lockPath,
      JSON.stringify({ version: 1, pid: 4321, alias: "神鸽", hostname: "host", boot_id: "boot-same", started_at: "2026-11-25T00:00:00Z", token: "stale-tok" }),
      { mode: 0o600 },
    );

    const res = acquireNodeInstanceLock(dir, { alias: "神鸽" }, {
      pid: 8888,
      bootId: "boot-same",
      isPidAlive: () => true,
      readPidCmdline: () => "/usr/sbin/sshd -D",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.reclaimedStalePid).toBe(4321);
    res.handle.release();
  });
});

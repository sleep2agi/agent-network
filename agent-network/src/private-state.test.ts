import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { atomicWritePrivateFile, atomicWritePrivateJson, repairPrivateFilePermissions } from "./private-state";

const roots: string[] = [];
const mode = (path: string) => lstatSync(path).mode & 0o777;
function root(): string {
  const path = join(tmpdir(), `anet-private-state-${process.pid}-${roots.length}`);
  mkdirSync(path, { mode: 0o777 });
  roots.push(path);
  return path;
}
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe("#472 private state writer", () => {
  for (const mask of [0o000, 0o002, 0o022, 0o077]) {
    test(`publishes 0600 files and 0700 parent under umask ${mask.toString(8)}`, () => {
      const dir = root();
      const path = join(dir, "config.json");
      const previous = process.umask(mask);
      try { atomicWritePrivateJson(path, { token: "ntok_synthetic" }); }
      finally { process.umask(previous); }
      expect(mode(path)).toBe(0o600);
      expect(mode(dir)).toBe(0o700);
    });
  }

  test("atomically replaces a legacy 0664 target with a 0600 inode", () => {
    const dir = root();
    const path = join(dir, "config.json");
    writeFileSync(path, "legacy", { mode: 0o666 });
    chmodSync(path, 0o664);
    const oldIno = lstatSync(path).ino;
    atomicWritePrivateFile(path, "secret");
    expect(readFileSync(path, "utf8")).toBe("secret");
    expect(mode(path)).toBe(0o600);
    expect(lstatSync(path).ino).not.toBe(oldIno);
  });

  test("replaces a leaf symlink instead of writing through it", () => {
    const dir = root();
    const victim = join(dir, "victim");
    const path = join(dir, "config.json");
    writeFileSync(victim, "unchanged", { mode: 0o600 });
    symlinkSync(victim, path);
    atomicWritePrivateFile(path, "secret");
    expect(readFileSync(victim, "utf8")).toBe("unchanged");
    expect(lstatSync(path).isSymbolicLink()).toBe(false);
    expect(mode(path)).toBe(0o600);
  });

  test("repairs a legacy file and parent before reading", () => {
    const dir = root();
    const path = join(dir, "config.json");
    writeFileSync(path, "secret");
    chmodSync(dir, 0o775);
    chmodSync(path, 0o664);
    repairPrivateFilePermissions(path);
    expect(mode(dir)).toBe(0o700);
    expect(mode(path)).toBe(0o600);
  });

  test("read repair refuses a symlink instead of chmod-following it", () => {
    const dir = root();
    const victim = join(dir, "victim");
    const path = join(dir, "config.json");
    writeFileSync(victim, "unchanged", { mode: 0o644 });
    symlinkSync(victim, path);
    expect(() => repairPrivateFilePermissions(path)).toThrow(/linked path/);
    expect(mode(victim)).toBe(0o644);
  });
});

describe("#2222 Windows rename EPERM is retried, not swallowed", () => {
  const eperm = () => Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });

  test("win32: EPERM/EBUSY/EACCES are retried with bounded backoff, then the rename succeeds", async () => {
    const { renamePrivateStateSync } = await import("./private-state");
    const calls: string[] = [], sleeps: number[] = [];
    let failures = 3;
    renamePrivateStateSync("t.tmp", "t.json", (from, to) => {
      calls.push(`${from}->${to}`);
      if (failures-- > 0) throw eperm();
    }, (ms) => sleeps.push(ms), "win32");
    expect(calls.length).toBe(4);              // 3 次失败 + 1 次成功
    expect(sleeps).toEqual([10, 25, 50]);      // 退避序列,不是死循环
  });

  test("win32: exhausting the backoff still throws（不吞错）", async () => {
    const { renamePrivateStateSync } = await import("./private-state");
    let calls = 0;
    expect(() => renamePrivateStateSync("t.tmp", "t.json", () => { calls++; throw eperm(); }, () => {}, "win32")).toThrow("EPERM");
    expect(calls).toBe(5);                     // 上限是 5 次,不会无限重试
  });

  test("posix: EPERM is NOT retried (Linux 上 rename 覆盖已打开文件本该成功,重试只会掩盖真问题)", async () => {
    const { renamePrivateStateSync } = await import("./private-state");
    let calls = 0;
    expect(() => renamePrivateStateSync("t.tmp", "t.json", () => { calls++; throw eperm(); }, () => {}, "linux")).toThrow("EPERM");
    expect(calls).toBe(1);
  });

  test("win32: a non-transient error is thrown immediately, without backoff", async () => {
    const { renamePrivateStateSync } = await import("./private-state");
    let calls = 0, sleeps = 0;
    expect(() => renamePrivateStateSync("t.tmp", "t.json", () => {
      calls++; throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
    }, () => { sleeps++; }, "win32")).toThrow("ENOENT");
    expect([calls, sleeps]).toEqual([1, 0]);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { atomicWritePrivateFile, atomicWritePrivateJson } from "./private-state";

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
});

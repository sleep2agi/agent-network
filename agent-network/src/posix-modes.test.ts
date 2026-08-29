import { describe, expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fsyncDirectoryIfSupported, modeIsJudgeable, posixFileModes } from "./posix-modes";

describe("where POSIX modes exist", () => {
  test("everywhere except windows", () => {
    for (const p of ["linux", "darwin", "freebsd", "aix"] as const) expect(posixFileModes(p)).toBe(true);
    expect(posixFileModes("win32")).toBe(false);
  });

  test("mode judgements are only meaningful where modes exist", () => {
    // Windows synthesises mode bits, so a POSIX-shaped check there returns the
    // same answer for every file — which is not a check.
    expect(modeIsJudgeable("win32")).toBe(false);
    expect(modeIsJudgeable("linux")).toBe(true);
  });

  test("🔴 the two must agree — a platform cannot have modes but not judge them", () => {
    for (const p of ["linux", "darwin", "win32", "freebsd"] as const) {
      expect(modeIsJudgeable(p)).toBe(posixFileModes(p));
    }
  });
});

describe("the directory fsync barrier", () => {
  test("skipped only on windows", () => {
    // The file fsync before the rename still runs everywhere — it carries the
    // bytes. Only the parent-directory barrier is skipped, and only where the
    // OS cannot perform it at all.
    expect(posixFileModes("win32")).toBe(false);
    expect(posixFileModes("linux")).toBe(true);
  });

  test("fsyncing a real directory handle works here, so the guard is not hiding a bug on this platform", () => {
    const dir = mkdtempSync(join(tmpdir(), "posix-modes-"));
    const fd = openSync(dir, 0);
    try { expect(() => fsyncDirectoryIfSupported(fd)).not.toThrow(); }
    finally { closeSync(fd); rmSync(dir, { recursive: true, force: true }); }
  });
});

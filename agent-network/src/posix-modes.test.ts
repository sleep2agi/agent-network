import { describe, expect, test } from "bun:test";
import { modeIsJudgeable, posixFileModes } from "./posix-modes";

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

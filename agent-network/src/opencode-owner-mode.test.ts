import { describe, expect, test } from "bun:test";
import { opencodeOwnedPathModeIsSafe } from "./opencode-owner-mode";

describe("OpenCode owner/mode policy", () => {
  test("accepts umask-0002 modes only for a non-root uid=gid layout", () => {
    expect(opencodeOwnedPathModeIsSafe(
      { uid: 1000, gid: 1000, mode: 0o775 }, 1000, 1000,
    )).toBe(true);
    expect(opencodeOwnedPathModeIsSafe(
      { uid: 1000, gid: 1000, mode: 0o664 }, 1000, 1000,
    )).toBe(true);
    expect(opencodeOwnedPathModeIsSafe(
      { uid: 1000, gid: 1001, mode: 0o775 }, 1000, 1000,
    )).toBe(false);
  });

  test("always rejects world write and keeps root/foreign ownership strict", () => {
    expect(opencodeOwnedPathModeIsSafe(
      { uid: 1000, gid: 1000, mode: 0o777 }, 1000, 1000,
    )).toBe(false);
    expect(opencodeOwnedPathModeIsSafe(
      { uid: 0, gid: 0, mode: 0o770 }, 1000, 1000,
    )).toBe(false);
    expect(opencodeOwnedPathModeIsSafe(
      { uid: 2000, gid: 2000, mode: 0o755 }, 1000, 1000,
    )).toBe(false);
    expect(opencodeOwnedPathModeIsSafe(
      { uid: 0, gid: 0, mode: 0o770 }, 0, 0,
    )).toBe(false);
  });
});

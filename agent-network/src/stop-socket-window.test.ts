// #1385 — pin the stop socket-residual window. cli.ts is a side-effecting
// entrypoint, so the invariant is pinned against source text: the window
// constant exists at 10s and the deadline is derived from it (not a bare
// 3_000 that quietly reverts).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

describe("#1385 stop socket residual window", () => {
  const src = readFileSync(join(import.meta.dir, "..", "bin", "cli.ts"), "utf8");

  test("window constant is 10s and feeds the deadline", () => {
    expect(src).toContain("const SOCKET_RESIDUAL_WINDOW_MS = 10_000;");
    expect(src).toContain("Date.now() + SOCKET_RESIDUAL_WINDOW_MS");
    // the old hard-coded window must be gone from the stop path
    const stopIdx = src.indexOf("SOCKET_RESIDUAL_WINDOW_MS");
    const tail = src.slice(stopIdx, stopIdx + 2000);
    expect(tail).not.toContain("Date.now() + 3_000");
  });

  test("residual line carries the age diagnostic (slow-teardown vs leak)", () => {
    expect(src).toContain("an old-mtime socket that outlives the window is a real leak");
  });
});

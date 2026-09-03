import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACTIVE_NETWORK_TASK_FILE,
  activeNetworkTaskMarkerPath,
  clearActiveNetworkTaskMarker,
  writeActiveNetworkTaskMarker,
} from "./active-network-task-marker.js";

let dir = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "anet-marker-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("active network task marker", () => {
  test("path lives next to node-server's .env under <cwd>/.anet", () => {
    expect(activeNetworkTaskMarkerPath("/work/p")).toBe(join("/work/p", ".anet", ACTIVE_NETWORK_TASK_FILE));
  });
  test("write creates the directory, is 0600 and round-trips the three fields", () => {
    const path = activeNetworkTaskMarkerPath(dir);
    writeActiveNetworkTaskMarker(path, { taskId: "5844f347", from: "通信龙", startedAt: 123 });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ taskId: "5844f347", from: "通信龙", startedAt: 123 });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(existsSync(`${path}.${process.pid}.tmp`)).toBe(false);
  });
  test("a second write replaces the first (one active task at a time)", () => {
    const path = activeNetworkTaskMarkerPath(dir);
    writeActiveNetworkTaskMarker(path, { taskId: "a", from: "x", startedAt: 1 });
    writeActiveNetworkTaskMarker(path, { taskId: "b", from: "y", startedAt: 2 });
    expect(JSON.parse(readFileSync(path, "utf8")).taskId).toBe("b");
  });
  test("clear is idempotent", () => {
    const path = activeNetworkTaskMarkerPath(dir);
    clearActiveNetworkTaskMarker(path);
    writeActiveNetworkTaskMarker(path, { taskId: "a", from: "x", startedAt: 1 });
    clearActiveNetworkTaskMarker(path);
    clearActiveNetworkTaskMarker(path);
    expect(existsSync(path)).toBe(false);
  });
});

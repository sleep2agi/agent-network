import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { ownedConnectionFromSnapshot, probePosixOwnedLoopbackConnection } from "./posix-codex-copresence";

const closers: Array<() => void> = [];
afterEach(() => { while (closers.length) closers.pop()?.(); });

describe("POSIX Codex TUI socket attribution", () => {
  test("Linux accepts only an established exact-port socket owned by the root tree", async () => {
    if (process.platform !== "linux") return;
    const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    closers.push(() => server.stop(true));
    const socket = await Bun.connect({ hostname: "127.0.0.1", port: server.port, socket: { data() {} } });
    closers.push(() => socket.end());
    expect(probePosixOwnedLoopbackConnection(process.pid, server.port)).toBe(true);
    expect(probePosixOwnedLoopbackConnection(process.pid, server.port + 1)).toBe(false);
    expect(probePosixOwnedLoopbackConnection(999_999_999, server.port)).toBe(false);
    const unrelated = spawn("sleep", ["30"], { stdio: "ignore" });
    closers.push(() => unrelated.kill("SIGKILL"));
    expect(unrelated.pid).toBeNumber();
    // This leaf process owns no socket and is not an ancestor of the client.
    expect(probePosixOwnedLoopbackConnection(unrelated.pid!, server.port)).toBe(false);
  });

  test("unsupported platforms and invalid endpoints fail closed", () => {
    expect(probePosixOwnedLoopbackConnection(process.pid, 443, "freebsd")).toBe(false);
    expect(probePosixOwnedLoopbackConnection(-1, 443, "linux")).toBe(false);
    expect(probePosixOwnedLoopbackConnection(process.pid, 0, "linux")).toBe(false);
  });

  test("snapshot rejects sibling ownership, gone/reused root and unread fds", () => {
    const rows = [{ pid: 10, ppid: 1, start: "old" }, { pid: 11, ppid: 10, start: "child" }, { pid: 20, ppid: 1, start: "other" }];
    const owners = new Map([[11, new Set(["owned"])], [20, new Set(["other"])]]);
    expect(ownedConnectionFromSnapshot(10, "old", "old", rows, owners, new Set(["owned"]))).toBe(true);
    expect(ownedConnectionFromSnapshot(10, "old", "old", rows, owners, new Set(["other"]))).toBe(false);
    expect(ownedConnectionFromSnapshot(10, "old", null, rows, owners, new Set(["owned"]))).toBe(false);
    expect(ownedConnectionFromSnapshot(10, "old", "reused", rows, owners, new Set(["owned"]))).toBe(false);
    expect(ownedConnectionFromSnapshot(10, "old", "old", rows, owners, new Set(["owned"]), true)).toBe(false);
  });

  test("both POSIX native branches are fail-closed and launcher creates no health turn", () => {
    const source = readFileSync(new URL("./posix-codex-copresence.ts", import.meta.url), "utf8");
    expect(source).toContain('if (platform === "linux")');
    expect(source).toContain('if (platform === "darwin")');
    expect(source).toContain('"/usr/sbin/lsof"');
    const cli = readFileSync(new URL("../bin/cli.ts", import.meta.url), "utf8");
    expect(cli).not.toContain("ANET_TUI_HEALTH");
    expect(cli).not.toContain("createTuiHealthChallenge");
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ownedConnectionFromSnapshot, POSIX_TUI_ATTRIBUTION_MS, probePosixOwnedLoopbackConnection, waitForPosixOwnedLoopbackConnection } from "./posix-codex-copresence";

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

describe("waitForPosixOwnedLoopbackConnection (#2255: paint before connect)", () => {
  const fakeClock = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => { t += ms; } };
  };

  test("connects on a later probe: keeps polling instead of failing on the first miss", async () => {
    const c = fakeClock();
    let calls = 0;
    const r = await waitForPosixOwnedLoopbackConnection({ rootPid: 1, port: 2, deadlineMs: 5_000, intervalMs: 250, alive: () => true, probe: () => ++calls >= 3, ...c });
    expect(r).toEqual({ outcome: "connected", probes: 3, waitedMs: 500 });
  });

  test("TUI exits while waiting → tui-exited, without waiting out the deadline", async () => {
    const c = fakeClock();
    let alive = 3;
    const r = await waitForPosixOwnedLoopbackConnection({ rootPid: 1, port: 2, deadlineMs: 25_000, intervalMs: 250, alive: () => --alive > 0, probe: () => false, ...c });
    expect(r.outcome).toBe("tui-exited");
    expect(r.waitedMs).toBeLessThan(1_000);
  });

  test("never connects → deadline, after probing for the whole budget", async () => {
    const c = fakeClock();
    const r = await waitForPosixOwnedLoopbackConnection({ rootPid: 1, port: 2, deadlineMs: 2_000, intervalMs: 250, alive: () => true, probe: () => false, ...c });
    expect(r.outcome).toBe("deadline");
    expect(r.waitedMs).toBeGreaterThanOrEqual(2_000);
    expect(r.probes).toBe(9);
  });

  test("budget matches the Windows path (TUI_HEALTH_MS = 25 s)", () => {
    expect(POSIX_TUI_ATTRIBUTION_MS).toBe(25_000);
    const cli = readFileSync(join(import.meta.dir, "..", "bin", "cli.ts"), "utf8");
    expect(cli).toContain("const TUI_HEALTH_MS = 25_000;");
  });

  test("real sockets: a TUI that connects 400 ms after it is checked is attributed", async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
    // A child that waits, then holds a connection to the server (a TUI that paints first, connects later).
    const child = spawn(process.execPath, ["-e", `await Bun.sleep(400); const s = await Bun.connect({ hostname: "127.0.0.1", port: ${server.port}, socket: { data() {} } }); await Bun.sleep(5000);`], { stdio: "ignore" });
    try {
      expect(probePosixOwnedLoopbackConnection(child.pid, server.port)).toBe(false); // the old single shot misses it
      const r = await waitForPosixOwnedLoopbackConnection({ rootPid: child.pid, port: server.port, deadlineMs: 5_000, intervalMs: 100, alive: () => child.exitCode === null });
      expect(r.outcome).toBe("connected");
      expect(r.probes).toBeGreaterThan(1);
    } finally {
      child.kill("SIGKILL");
      server.stop(true);
    }
  });
});

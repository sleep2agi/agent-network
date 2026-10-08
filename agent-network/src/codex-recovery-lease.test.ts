// Board #762 — a codex co-presence launcher that stays in the foreground after
// "③ TUI … ready to attach" must not keep the host-wide recovery lane (cap 1).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForCodexRecoveryResources } from "./codex-recovery-resource-gate";
import { createRecoveryLeaseHolder, launchCopresencePiecesReleasingRecovery } from "./codex-recovery-lease";

const HEARTBEAT_MS = 40;
const MEM = "MemTotal: 33554432 kB\nMemAvailable: 16777216 kB\n";
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function slotsDir(): string {
  const root = mkdtempSync(join(tmpdir(), "anet-762-"));
  roots.push(root);
  return join(root, "codex-recovery-slots");
}

/** Real recovery gate (locking, lease file, heartbeat), with a healthy /proc. */
function acquire(dir: string, nodeId: string, sleepImpl: (ms: number) => Promise<void> = sleep) {
  return waitForCodexRecoveryResources(nodeId, null, {
    platform: "linux",
    slotsDir: dir,
    env: { ANET_START_GATE_MAX_WAIT_SEC: "600", ANET_START_MAX_LOAD_PER_CPU: "999" },
    leaseTtlMs: 600_000,
    leaseHeartbeatMs: HEARTBEAT_MS,
    recheckMs: 10,
    jitterMs: 0,
    readFile: (p) => p === "/proc/meminfo" ? MEM : p === "/proc/loadavg" ? "0.01 0 0 1/1 1\n" : null,
    sleep: sleepImpl,
    log: () => {},
    warn: () => {},
  });
}

const leaseFiles = (dir: string) => {
  try { return readdirSync(dir).filter((f) => !f.startsWith(".")); } catch { return []; }
};

/** Track the heartbeat interval the gate starts, and whether it was cleared. */
function spyHeartbeat() {
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  const heartbeats = new Set<unknown>();
  const cleared = new Set<unknown>();
  (globalThis as any).setInterval = (fn: any, ms?: number, ...rest: any[]) => {
    const h = realSet(fn, ms, ...rest);
    if (ms === HEARTBEAT_MS) heartbeats.add(h);
    return h;
  };
  (globalThis as any).clearInterval = (h: any) => { cleared.add(h); return realClear(h); };
  return {
    running: () => [...heartbeats].filter((h) => !cleared.has(h)).length,
    started: () => heartbeats.size,
    restore: () => { (globalThis as any).setInterval = realSet; (globalThis as any).clearInterval = realClear; },
  };
}

describe("codex recovery lease is released once the bridge and TUI are ready (#762)", () => {
  test.skipIf(process.platform !== "linux")("a foreground launcher that keeps running frees the lane right after ready", async () => {
    const dir = slotsDir();
    const spy = spyHeartbeat();
    try {
      const exitHooks: Array<() => void> = [];
      const holder = createRecoveryLeaseHolder({ onProcessExit: (fn) => { exitHooks.push(fn); return () => { exitHooks.splice(exitHooks.indexOf(fn), 1); }; } });
      holder.hold(await acquire(dir, "node_first"));
      expect(leaseFiles(dir)).toHaveLength(1);
      expect(spy.running()).toBe(1);

      const order: string[] = [];
      await launchCopresencePiecesReleasingRecovery({
        tuiFirst: false,
        launchBridge: async () => { order.push("bridge"); expect(holder.held).toBe(true); },
        launchTui: () => { order.push("tui"); },
        afterLaunch: () => { order.push("after"); },
        requireTuiPainted: async () => { order.push("painted"); expect(holder.held).toBe(true); },
        requireTuiConnected: async () => { order.push("connected"); expect(holder.held).toBe(true); },
        lease: holder,
      });
      expect(order).toEqual(["bridge", "tui", "after", "painted", "connected"]);

      // The launcher stays in the foreground (as the bridge host would), for
      // several heartbeat periods. Nothing may renew or recreate the lease.
      await sleep(HEARTBEAT_MS * 5);
      expect(holder.held).toBe(false);
      expect(leaseFiles(dir)).toEqual([]);
      expect(spy.running()).toBe(0);
      expect(exitHooks).toHaveLength(0);

      // A later recovery on the host gets the single lane at once.
      let waits = 0;
      const second = await acquire(dir, "node_second", async (ms) => { waits++; await sleep(ms); });
      expect(second.outcome).toBe("ok");
      expect(waits).toBe(0);
      second.release();
    } finally {
      spy.restore();
    }
  });

  test.skipIf(process.platform !== "linux")("--tui-first order also releases after both pieces are ready", async () => {
    const dir = slotsDir();
    const holder = createRecoveryLeaseHolder({ onProcessExit: () => () => {} });
    holder.hold(await acquire(dir, "node_tf"));
    const order: string[] = [];
    await launchCopresencePiecesReleasingRecovery({
      tuiFirst: true,
      launchTui: () => { order.push("tui"); },
      requireTuiPainted: async () => { order.push("painted"); },
      announceTuiFirst: () => { order.push("announce"); },
      launchBridge: async () => { order.push("bridge"); expect(holder.held).toBe(true); },
      afterLaunch: () => { order.push("after"); },
      requireTuiConnected: async () => { order.push("connected"); expect(holder.held).toBe(true); },
      lease: holder,
    });
    expect(order).toEqual(["tui", "painted", "announce", "bridge", "after", "connected"]);
    expect(leaseFiles(dir)).toEqual([]);
  });

  test.skipIf(process.platform !== "linux")("a failure before ready releases the lease too", async () => {
    const dir = slotsDir();
    const spy = spyHeartbeat();
    try {
      const holder = createRecoveryLeaseHolder({ onProcessExit: () => () => {} });
      holder.hold(await acquire(dir, "node_fail"));
      await expect(launchCopresencePiecesReleasingRecovery({
        tuiFirst: false,
        launchBridge: async () => { throw new Error("bridge never reported READY"); },
        launchTui: () => { throw new Error("must not launch the TUI"); },
        requireTuiPainted: async () => {},
        requireTuiConnected: async () => {},
        lease: holder,
      })).rejects.toThrow("bridge never reported READY");
      expect(leaseFiles(dir)).toEqual([]);
      expect(spy.running()).toBe(0);
      const second = await acquire(dir, "node_after_fail");
      expect(second.outcome).toBe("ok");
      second.release();
    } finally {
      spy.restore();
    }
  });

  test.skipIf(process.platform !== "linux")("a process.exit failure path releases through the exit hook", async () => {
    const dir = slotsDir();
    const exitHooks: Array<() => void> = [];
    const holder = createRecoveryLeaseHolder({ onProcessExit: (fn) => { exitHooks.push(fn); return () => {}; } });
    holder.hold(await acquire(dir, "node_exit"));
    expect(exitHooks).toHaveLength(1);
    exitHooks[0]();
    expect(holder.held).toBe(false);
    expect(leaseFiles(dir)).toEqual([]);
  });

  test.skipIf(process.platform !== "linux")("paint without an attributed connection cannot admit the next recovery", async () => {
    const dir = slotsDir();
    const holder = createRecoveryLeaseHolder({ onProcessExit: () => () => {} });
    holder.hold(await acquire(dir, "node_connecting"));
    let connect!: () => void;
    const connection = new Promise<void>((resolve) => { connect = resolve; });
    let painted = false;
    const launch = launchCopresencePiecesReleasingRecovery({
      tuiFirst: false,
      launchBridge: async () => {},
      launchTui: () => {},
      requireTuiPainted: async () => { painted = true; },
      requireTuiConnected: () => connection,
      lease: holder,
    });
    let waits = 0;
    let admitted = false;
    const next = acquire(dir, "node_waiting", async (ms) => { waits++; await sleep(ms); })
      .then((lease) => { admitted = true; return lease; });
    try {
      await sleep(HEARTBEAT_MS * 3);
      expect(painted).toBe(true);
      expect(holder.held).toBe(true);
      expect(leaseFiles(dir)).toHaveLength(1);
      expect(waits).toBeGreaterThan(0);
      expect(admitted).toBe(false);
      connect();
      await launch;
      const second = await next;
      expect(holder.held).toBe(false);
      expect(second.outcome).toBe("waited");
    } finally {
      connect();
      await launch;
      holder.release();
      (await next).release();
    }
  });

  test.skipIf(process.platform !== "linux")("failed connection attribution releases without reporting success", async () => {
    const dir = slotsDir();
    const holder = createRecoveryLeaseHolder({ onProcessExit: () => () => {} });
    holder.hold(await acquire(dir, "node_no_connection"));
    await expect(launchCopresencePiecesReleasingRecovery({
      tuiFirst: false,
      launchBridge: async () => {},
      launchTui: () => {},
      requireTuiPainted: async () => {},
      requireTuiConnected: async () => { throw new Error("TUI connection attribution failed"); },
      lease: holder,
    })).rejects.toThrow("TUI connection attribution failed");
    expect(holder.held).toBe(false);
    expect(leaseFiles(dir)).toEqual([]);
  });

  test("release is idempotent and calls the underlying lease once", () => {
    let releases = 0;
    let unregistered = 0;
    const holder = createRecoveryLeaseHolder({ onProcessExit: () => () => { unregistered++; } });
    holder.release(); // nothing held yet: harmless
    holder.hold({ release: () => { releases++; } });
    holder.release();
    holder.release();
    holder.release("again");
    expect(releases).toBe(1);
    expect(unregistered).toBe(1);
    expect(holder.held).toBe(false);
  });

  test("a throwing lease release does not escape", () => {
    const holder = createRecoveryLeaseHolder({ onProcessExit: () => () => {} });
    holder.hold({ release: () => { throw new Error("lock busy"); } });
    expect(() => holder.release()).not.toThrow();
    expect(holder.held).toBe(false);
  });
});

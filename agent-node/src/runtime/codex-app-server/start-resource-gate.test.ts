// #612 — memory/load gate plus the host start lease.
// All host readings are injected; nothing here reads the real /proc.
// slotsDir is a temp directory: an admit must not write ~/.anet.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  START_GATE_SINGLE_LANE_STATUS,
  START_GATE_WAITING_STATUS,
  defaultStartMinMemMb,
  parseLoad1,
  parseMemAvailableMb,
  waitForStartResources,
  withHeavyStartAdmission,
  type StartGateDeps,
} from "./start-resource-gate";
import { openCodexAppServerRuntime } from "./runtime";

const GiB_KB = 1024 * 1024;
const HOLDER = 4242;

function meminfo(availableKb: number, totalKb = 65642000): string {
  return `MemTotal:       ${totalKb} kB\nMemFree:          300000 kB\nMemAvailable:   ${availableKb} kB\nBuffers:           10000 kB\n`;
}
function loadavg(load1: number): string {
  return `${load1.toFixed(2)} 120.00 80.00 3/2000 12345\n`;
}

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

/** A fake host whose readings advance one step per sample. */
function fakeHost(steps: Array<{ memKb: number; load1: number }>, extra: Partial<StartGateDeps> = {}) {
  let i = 0;
  let clock = 0;
  const sleeps: number[] = [];
  const logs: string[] = [];
  const warns: string[] = [];
  const reports: string[] = [];
  let reads = 0;
  const slotsDir = mkdtempSync(join(tmpdir(), "anet-612-slots-"));
  roots.push(slotsDir);
  const deps: StartGateDeps = {
    env: {},
    platform: "linux",
    cpuCount: () => 16,
    readFile: (p) => {
      reads++;
      const s = steps[Math.min(i, steps.length - 1)];
      if (p === "/proc/meminfo") return meminfo(s.memKb);
      if (p === "/proc/loadavg") { i++; return loadavg(s.load1); }
      return null;
    },
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    now: () => clock,
    random: () => 0.5,
    log: (m) => logs.push(m),
    warn: (m) => warns.push(m),
    report: (text) => reports.push(text),
    slotsDir,
    holderPid: HOLDER,
    isPidAlive: (pid) => pid === HOLDER,
    nodeId: "n-test",
    ...extra,
  };
  return { deps, sleeps, logs, warns, reports, reads: () => reads, slotsDir: deps.slotsDir ?? slotsDir };
}

function slotNames(dir: string): string[] {
  return readdirSync(dir).filter((name) => name !== ".lock" && !name.startsWith("."));
}

const HEALTHY = { memKb: 20 * GiB_KB, load1: 4 };
const FROZEN = { memKb: Math.round(0.3 * GiB_KB), load1: 146 }; // the 10-06 incident shape on a 16-core host

describe("#612 parsers", () => {
  test("MemAvailable and load1 parse from /proc text", () => {
    expect(parseMemAvailableMb(meminfo(4 * GiB_KB))).toBe(4096);
    expect(parseMemAvailableMb("MemTotal: 1 kB\n")).toBeNull();
    expect(parseLoad1(loadavg(146))).toBe(146);
    expect(parseLoad1("")).toBeNull();
  });

  test("default floor is min(4096, 15% of MemTotal); missing total stays 4096", () => {
    expect(defaultStartMinMemMb(0)).toBe(4096);
    expect(defaultStartMinMemMb(Number.NaN)).toBe(4096);
    expect(defaultStartMinMemMb(64 * 1024)).toBe(4096);
    const small = defaultStartMinMemMb(8 * 1024);
    expect(small).toBeLessThan(4096);
    expect(small).toBeGreaterThan(1000);
    expect(small).toBeLessThan(2000);
  });
});

describe("#612 waitForStartResources", () => {
  test("pass: healthy host starts immediately without waiting or logging", async () => {
    const h = fakeHost([HEALTHY]);
    const r = await waitForStartResources("codex app-server", h.deps);
    expect(r.outcome).toBe("ok");
    expect(h.sleeps).toEqual([]);
    expect(h.logs).toEqual([]);
    expect(h.warns).toEqual([]);
    expect(h.reports).toEqual([]);
    expect(slotNames(h.slotsDir)).toEqual(["n-test"]);
    r.release();
    r.release();
    expect(slotNames(h.slotsDir)).toEqual([]);
  });

  test("wait-then-pass: low memory + high load waits, re-checks every ~15 s with jitter, then starts", async () => {
    const h = fakeHost([FROZEN, FROZEN, HEALTHY]);
    const r = await waitForStartResources("codex app-server", h.deps);
    expect(r.outcome).toBe("waited");
    expect(r.checks).toBe(3);
    expect(h.sleeps.length).toBe(2);
    for (const ms of h.sleeps) { expect(ms).toBeGreaterThanOrEqual(15_000); expect(ms).toBeLessThan(20_000); }
    expect(h.sleeps[0]).toBe(17_500); // 15 s + random(0.5) * 5 s jitter
    const first = h.logs[0];
    expect(first).toContain("waiting before start");
    expect(first).toContain("MemAvailable 307 MiB < 4096 MiB");
    expect(first).toContain("load1 146.00 > 32 (2 x 16 CPUs");
    expect(h.logs.at(-1)).toContain("host has headroom after 35s");
    expect(h.warns).toEqual([]);
    expect(h.reports).toEqual([START_GATE_WAITING_STATUS]);
    r.release();
  });

  test("load alone over 2 x CPUs is enough to wait", async () => {
    const h = fakeHost([{ memKb: 20 * GiB_KB, load1: 33 }, HEALTHY]);
    const r = await waitForStartResources("x", h.deps);
    expect(r.outcome).toBe("waited");
    expect(h.logs[0]).toContain("load1 33.00 > 32");
    expect(h.logs[0]).not.toContain("MemAvailable");
    r.release();
  });

  test("timeout then single-lane: never gets headroom → one admit after the max wait, not a stampede", async () => {
    const h = fakeHost([FROZEN]);
    const r = await waitForStartResources("codex app-server", h.deps);
    expect(r.outcome).toBe("single-lane");
    expect(r.waitedMs).toBe(600_000);
    expect(h.warns.length).toBe(1);
    expect(h.warns[0]).toContain(START_GATE_SINGLE_LANE_STATUS);
    expect(h.warns[0]).toContain("MemAvailable 307 MiB");
    expect(h.warns[0]).not.toContain("giving up waiting and starting anyway");
    expect(h.reports).toEqual([START_GATE_WAITING_STATUS, START_GATE_SINGLE_LANE_STATUS]);
    // progress is logged at most about once a minute, not every re-check
    expect(h.logs.length).toBeLessThanOrEqual(12);
    expect(slotNames(h.slotsDir)).toEqual(["n-test"]);
    r.release();
  });

  test("env overrides thresholds and max wait; a set floor replaces the 15% calculation", async () => {
    const h = fakeHost([{ memKb: 3 * GiB_KB, load1: 1 }], {
      env: { ANET_START_MIN_MEM_MB: "2048", ANET_START_MAX_LOAD_PER_CPU: "4", ANET_START_GATE_MAX_WAIT_SEC: "30" },
    });
    const ok = await waitForStartResources("x", h.deps);
    expect(ok.outcome).toBe("ok");
    ok.release();

    const t = fakeHost([FROZEN], { env: { ANET_START_GATE_MAX_WAIT_SEC: "30" } });
    const r = await waitForStartResources("x", t.deps);
    expect(r.outcome).toBe("single-lane");
    expect(r.waitedMs).toBe(30_000);
    r.release();
  });

  test("disabled: ANET_START_MEM_GATE=0 never reads /proc and takes no lease", async () => {
    const h = fakeHost([FROZEN], { env: { ANET_START_MEM_GATE: "0" } });
    const r = await waitForStartResources("x", h.deps);
    expect(r.outcome).toBe("disabled");
    expect(h.reads()).toBe(0);
    expect(h.sleeps).toEqual([]);
    expect(slotNames(h.slotsDir)).toEqual([]);
    r.release();
  });

  test("non-Linux: no-op, never reads /proc, no lease", async () => {
    const h = fakeHost([FROZEN], { platform: "darwin" });
    const r = await waitForStartResources("x", h.deps);
    expect(r.outcome).toBe("unsupported");
    expect(h.reads()).toBe(0);
    expect(h.sleeps).toEqual([]);
    expect(slotNames(h.slotsDir)).toEqual([]);
  });

  test("Linux without readable /proc waits, then single-lane — it does not start immediately", async () => {
    const h = fakeHost([FROZEN], { readFile: () => null });
    const r = await waitForStartResources("x", h.deps);
    expect(r.outcome).toBe("single-lane");
    expect(r.waitedMs).toBe(600_000);
    expect(h.sleeps.length).toBeGreaterThan(0);
    expect(h.warns.join("\n")).toContain(START_GATE_SINGLE_LANE_STATUS);
    expect(h.reports).toEqual([START_GATE_WAITING_STATUS, START_GATE_SINGLE_LANE_STATUS]);
    r.release();
  });

  test("mid-wait unreadable keeps waiting until single-lane instead of starting the herd", async () => {
    let samples = 0;
    const h = fakeHost([FROZEN], {
      readFile: (p) => {
        if (p !== "/proc/meminfo" && p !== "/proc/loadavg") return null;
        if (p === "/proc/loadavg") samples++;
        if (samples >= 1 && p === "/proc/meminfo") return null;
        if (p === "/proc/meminfo") return meminfo(FROZEN.memKb);
        return loadavg(FROZEN.load1);
      },
    });
    const r = await waitForStartResources("x", h.deps);
    expect(r.outcome).toBe("single-lane");
    expect(r.waitedMs).toBe(600_000);
    r.release();
  });

  test("small host: free memory between 15% of MemTotal and 4 GiB is enough", async () => {
    const totalKb = 8 * GiB_KB;
    const rawFloor = defaultStartMinMemMb(8 * 1024);
    const floor = String(Math.round(rawFloor * 10) / 10);
    const pass = fakeHost([HEALTHY], {
      readFile: (p) => {
        if (p === "/proc/meminfo") return meminfo(2000 * 1024, totalKb);
        if (p === "/proc/loadavg") return loadavg(0.2);
        return null;
      },
    });
    const ok = await waitForStartResources("x", pass.deps);
    expect(ok.outcome).toBe("ok");
    ok.release();

    const low = fakeHost([HEALTHY], {
      readFile: (p) => {
        if (p === "/proc/meminfo") return meminfo(1000 * 1024, totalKb);
        if (p === "/proc/loadavg") return loadavg(0.2);
        return null;
      },
      env: { ANET_START_GATE_MAX_WAIT_SEC: "0.02" },
      recheckMs: 5,
      jitterMs: 0,
    });
    const blocked = await waitForStartResources("x", low.deps);
    expect(blocked.outcome).toBe("single-lane");
    expect(low.logs[0]).toContain(`MemAvailable 1000 MiB < ${floor} MiB`);
    expect(low.logs[0]).not.toContain("4096");
    expect(rawFloor).toBeLessThan(4096);
    blocked.release();
  });

  test("missing MemTotal falls back to the 4096 MiB floor", async () => {
    const h = fakeHost([HEALTHY], {
      readFile: (p) => {
        if (p === "/proc/meminfo") return "MemAvailable:   3072000 kB\n";
        if (p === "/proc/loadavg") return loadavg(0.1);
        return null;
      },
      env: { ANET_START_GATE_MAX_WAIT_SEC: "0.02" },
      recheckMs: 5,
      jitterMs: 0,
    });
    const r = await waitForStartResources("x", h.deps);
    expect(r.outcome).toBe("single-lane");
    expect(h.logs[0]).toContain("3000 MiB < 4096 MiB");
    r.release();
  });

  test("cgroup free tighter than MemAvailable waits even when /proc looks fine", async () => {
    let sample = 0;
    const h = fakeHost([HEALTHY], {
      readFile: (p) => {
        if (p === "/proc/meminfo") return meminfo(20 * GiB_KB);
        if (p === "/proc/loadavg") { sample++; return loadavg(1); }
        if (p === "/proc/self/cgroup") return "0::/docker/abc\n";
        const tight = sample <= 1;
        if (p === "/sys/fs/cgroup/docker/abc/memory.max") return tight ? String(800 * 1024 * 1024) : "max";
        if (p === "/sys/fs/cgroup/docker/abc/memory.current") return tight ? String(700 * 1024 * 1024) : "0";
        return null;
      },
    });
    const r = await waitForStartResources("x", h.deps);
    expect(r.outcome).toBe("waited");
    expect(h.logs[0]).toContain("100 MiB");
    expect(h.logs[0]).toContain("cgroup");
    expect(h.reports).toEqual([START_GATE_WAITING_STATUS]);
    r.release();
  });

  test("cgroup v1 limit is honored; an unlimited max is ignored", async () => {
    const v1 = fakeHost([HEALTHY], {
      readFile: (p) => {
        if (p === "/proc/meminfo") return meminfo(20 * GiB_KB);
        if (p === "/proc/loadavg") return loadavg(1);
        if (p === "/proc/self/cgroup") return "5:memory:/docker/abc\n";
        if (p === "/sys/fs/cgroup/memory/docker/abc/memory.limit_in_bytes") return String(800 * 1024 * 1024);
        if (p === "/sys/fs/cgroup/memory/docker/abc/memory.usage_in_bytes") return String(700 * 1024 * 1024);
        return null;
      },
      env: { ANET_START_GATE_MAX_WAIT_SEC: "0.02" },
      recheckMs: 5,
      jitterMs: 0,
    });
    const waited = await waitForStartResources("x", v1.deps);
    expect(waited.outcome).toBe("single-lane");
    expect(v1.logs[0]).toContain("cgroup");
    waited.release();

    const open = fakeHost([HEALTHY], {
      readFile: (p) => {
        if (p === "/proc/meminfo") return meminfo(20 * GiB_KB);
        if (p === "/proc/loadavg") return loadavg(1);
        if (p === "/proc/self/cgroup") return "0::/docker/abc\n";
        if (p === "/sys/fs/cgroup/docker/abc/memory.max") return "max";
        if (p === "/sys/fs/cgroup/docker/abc/memory.current") return "0";
        return null;
      },
    });
    const ok = await waitForStartResources("x", open.deps);
    expect(ok.outcome).toBe("ok");
    ok.release();
  });

  test("a dead holder's lease is reaped and does not block the next start", async () => {
    const h = fakeHost([HEALTHY], { env: { ANET_START_MAX_CONCURRENT: "1" }, nodeId: "n-new" });
    writeFileSync(join(h.slotsDir, "n-dead"), "77777\n", { mode: 0o600 });
    const r = await waitForStartResources("x", h.deps);
    expect(r.outcome).toBe("ok");
    expect(existsSync(join(h.slotsDir, "n-dead"))).toBe(false);
    expect(slotNames(h.slotsDir)).toEqual(["n-new"]);
    r.release();
    expect(slotNames(h.slotsDir)).toEqual([]);
  });

  test("same node id and live pid is reentrant and does not drop the owner's lease", async () => {
    const h = fakeHost([HEALTHY], { env: { ANET_START_MAX_CONCURRENT: "1" }, nodeId: "n-same" });
    const first = await waitForStartResources("x", h.deps);
    const second = await waitForStartResources("x", h.deps);
    expect(first.outcome).toBe("ok");
    expect(second.outcome).toBe("ok");
    expect(h.sleeps).toEqual([]);
    second.release();
    expect(slotNames(h.slotsDir)).toEqual(["n-same"]);
    first.release();
    expect(slotNames(h.slotsDir)).toEqual([]);
  });

  test("withHeavyStartAdmission releases the lease when the start fails", async () => {
    const h = fakeHost([HEALTHY]);
    await expect(withHeavyStartAdmission("x", h.deps, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(slotNames(h.slotsDir)).toEqual([]);
  });

  test("healthy host admits at most 2 until one releases; a full slot is not 「等待内存」", async () => {
    const slotsDir = mkdtempSync(join(tmpdir(), "anet-612-cap-"));
    roots.push(slotsDir);
    let inFlight = 0;
    let maxInFlight = 0;
    const logs: string[] = [];
    const reports: string[] = [];
    const startOne = async (nodeId: string) => {
      const h = fakeHost([HEALTHY], {
        slotsDir,
        nodeId,
        recheckMs: 20,
        jitterMs: 0,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        now: () => Date.now(),
        log: (m) => logs.push(m),
        report: (text) => reports.push(text),
        env: { ANET_START_GATE_MAX_WAIT_SEC: "30" },
      });
      const r = await waitForStartResources("x", h.deps);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((res) => setTimeout(res, 50));
      inFlight--;
      r.release();
      return r;
    };
    const results = await Promise.all([startOne("n-a"), startOne("n-b"), startOne("n-c")]);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBe(2);
    expect(results.some((r) => r.outcome === "waited")).toBe(true);
    expect(results.every((r) => r.outcome === "ok" || r.outcome === "waited")).toBe(true);
    expect(logs.some((line) => line.includes("waiting for a start slot"))).toBe(true);
    expect(reports).not.toContain(START_GATE_WAITING_STATUS);
    expect(logs.join("\n")).not.toContain(START_GATE_WAITING_STATUS);
  }, 15_000);

  test("14 starts, memory never recovers: after timeout at most one is starting, and all eventually start", async () => {
    const slotsDir = mkdtempSync(join(tmpdir(), "anet-612-lane-"));
    roots.push(slotsDir);
    let starting = 0;
    let maxStarting = 0;
    const reports: string[] = [];
    const one = async (i: number) => {
      const h = fakeHost([FROZEN], {
        slotsDir,
        nodeId: `n_${i}`,
        recheckMs: 5,
        jitterMs: 0,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        now: () => Date.now(),
        random: () => 0,
        report: (text) => reports.push(text),
        env: { ANET_START_GATE_MAX_WAIT_SEC: "0.03" },
      });
      const r = await waitForStartResources("codex app-server", h.deps);
      starting++;
      maxStarting = Math.max(maxStarting, starting);
      try {
        expect(slotNames(slotsDir).length).toBeLessThanOrEqual(1);
        await new Promise((res) => setTimeout(res, 30));
        return r;
      } finally {
        starting--;
        r.release();
      }
    };
    const results = await Promise.all(Array.from({ length: 14 }, (_, i) => one(i)));
    expect(results).toHaveLength(14);
    expect(maxStarting).toBeLessThanOrEqual(1);
    expect(maxStarting).toBe(1);
    for (const r of results) expect(r.outcome).toBe("single-lane");
    expect(reports.filter((text) => text === START_GATE_SINGLE_LANE_STATUS)).toHaveLength(14);
    expect(reports.filter((text) => text === START_GATE_WAITING_STATUS)).toHaveLength(14);
    expect(slotNames(slotsDir)).toEqual([]);
  }, 20_000);
});

// Wiring: the gate must run BEFORE the owned app-server is spawned.
describe.skipIf(process.platform !== "linux")("#612 openCodexAppServerRuntime gates the owned spawn", () => {
  test("a busy host holds the spawn: the fake codex binary is never executed while the gate waits", async () => {
    const root = mkdtempSync(join(tmpdir(), "anet-612-gate-"));
    roots.push(root);
    const marker = join(root, "spawned");
    const bin = join(root, "codex");
    writeFileSync(bin, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    chmodSync(bin, 0o755);

    const h = fakeHost([FROZEN], {
      // stop the test at the first wait instead of sleeping
      sleep: async () => { throw new Error("gate-held"); },
    });
    let err: Error | null = null;
    try {
      await openCodexAppServerRuntime({ binary: bin, startGate: h.deps, log: () => {}, warn: () => {} });
    } catch (e: any) { err = e; }
    expect(err?.message).toBe("gate-held");
    expect(h.logs[0]).toContain("[start-gate] codex app-server: waiting before start");
    await new Promise((r) => setTimeout(r, 200));
    expect(existsSync(marker)).toBe(false);
    expect(slotNames(h.slotsDir)).toEqual([]);
  });
});

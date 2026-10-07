// #612 — memory/load gate plus the host start lease.
// All host readings are injected; nothing here reads the real /proc.
// slotsDir is a temp directory: an admit must not write ~/.anet.
import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  START_GATE_DEFAULT_MAX_LOAD_PER_CPU,
  START_GATE_SINGLE_LANE_STATUS,
  START_GATE_TAKEOVER_STATUS,
  START_GATE_WAITING_BOTH_STATUS,
  START_GATE_WAITING_LOAD_STATUS,
  START_GATE_WAITING_PROBE_STATUS,
  START_GATE_WAITING_STATUS,
  cgroupFreeMb,
  cgroupLimitMb,
  defaultStartMinMemMb,
  parseLoad1,
  parseMemAvailableMb,
  parseProcStartTicks,
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
  test("agent-node and anet ship the byte-identical gate", () => {
    const nodeGate = readFileSync(join(import.meta.dir, "start-resource-gate.ts"));
    const anetGate = readFileSync(join(import.meta.dir, "../../../../agent-network/src/start-resource-gate.ts"));
    expect(anetGate.equals(nodeGate)).toBe(true);
  });

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
    const capped = defaultStartMinMemMb(64 * 1024, 512);
    expect(capped).toBeLessThan(100);
    expect(capped).toBe(Math.min(4096, 512 * 0.15));
    expect(cgroupLimitMb(String(512 * 1024 * 1024), 64 * 1024)).toBe(512);
  });

  test("cgroup free subtracts inactive_file; v1 prefers total_inactive_file", () => {
    const MiB = 1024 * 1024;
    const free = cgroupFreeMb(String(512 * MiB), String(373 * MiB), 64 * 1024, `inactive_file ${350 * MiB}\n`, false);
    expect(free).not.toBeNull();
    expect(Math.round(free!)).toBe(489);
    const v1 = cgroupFreeMb(
      String(512 * MiB),
      String(373 * MiB),
      64 * 1024,
      `inactive_file 0\ntotal_inactive_file ${350 * MiB}\n`,
      true,
    );
    expect(Math.round(v1!)).toBe(489);
    expect(Math.round(cgroupFreeMb(String(512 * MiB), String(373 * MiB), 64 * 1024)!)).toBe(139);
  });

  test("proc start ticks are field 22, after a comm that contains spaces", () => {
    const line = "123 (my proc) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 22222\n";
    expect(parseProcStartTicks(line)).toBe("22222");
    expect(parseProcStartTicks("no-paren")).toBeNull();
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
    expect(first).toContain("load1 146.00 > 64 (4 x 16 CPUs");
    expect(h.logs.at(-1)).toContain("host has headroom after 35s");
    expect(h.warns).toEqual([]);
    expect(h.reports).toEqual([START_GATE_WAITING_BOTH_STATUS]);
    r.release();
  });

  test("load alone over 4 x CPUs is enough to wait and reports load", async () => {
    const h = fakeHost([{ memKb: 20 * GiB_KB, load1: 65 }, HEALTHY]);
    const r = await waitForStartResources("x", h.deps);
    expect(r.outcome).toBe("waited");
    expect(h.logs[0]).toContain("load1 65.00 > 64");
    expect(h.logs[0]).not.toContain("MemAvailable");
    expect(h.reports).toEqual([START_GATE_WAITING_LOAD_STATUS]);
    r.release();
  });

  test("the 4 x default admits the CI and DEV high-load shapes when memory is ample", async () => {
    expect(START_GATE_DEFAULT_MAX_LOAD_PER_CPU).toBe(4);
    for (const [cpuCount, load1] of [[4, 9.81], [8, 24]] as const) {
      const h = fakeHost([{ memKb: 20 * GiB_KB, load1 }], { cpuCount: () => cpuCount });
      const r = await waitForStartResources("x", h.deps);
      expect(r.outcome).toBe("ok");
      expect(h.reports).toEqual([]);
      r.release();
    }
  });

  test("blocked status follows the actual shortage as it changes", async () => {
    const h = fakeHost([
      { memKb: Math.round(0.3 * GiB_KB), load1: 146 },
      { memKb: 20 * GiB_KB, load1: 146 },
      HEALTHY,
    ]);
    const r = await waitForStartResources("x", h.deps);
    expect(r.outcome).toBe("waited");
    expect(h.reports).toEqual([START_GATE_WAITING_BOTH_STATUS, START_GATE_WAITING_LOAD_STATUS]);
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
    expect(h.reports).toEqual([START_GATE_WAITING_BOTH_STATUS, START_GATE_SINGLE_LANE_STATUS]);
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
    expect(h.reports).toEqual([START_GATE_WAITING_PROBE_STATUS, START_GATE_SINGLE_LANE_STATUS]);
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
    expect(h.logs[0]).not.toContain("4096");
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
    const warns: string[] = [];
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
        warn: (m) => warns.push(m),
        // This used to bypass the lease. A short cap must still keep the lane at one.
        env: { ANET_START_GATE_MAX_WAIT_SEC: "0.03", ANET_START_SINGLE_LANE_MAX_WAIT_SEC: "0.001" },
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
    expect(reports.filter((text) => text === START_GATE_WAITING_BOTH_STATUS)).toHaveLength(14);
    expect(warns.join("\n")).not.toContain("放行本次启动");
    expect(warns.join("\n")).not.toContain(START_GATE_TAKEOVER_STATUS);
    expect(slotNames(slotsDir)).toEqual([]);
  }, 20_000);

  test("a fresh empty lock is not stolen, and waiting does not skip the lease", async () => {
    const h = fakeHost([HEALTHY], {
      env: { ANET_START_GATE_MAX_WAIT_SEC: "0.02", ANET_START_SINGLE_LANE_MAX_WAIT_SEC: "0.001" },
      recheckMs: 5,
      jitterMs: 0,
      sleep: async () => { throw new Error("still-held"); },
    });
    writeFileSync(join(h.slotsDir, ".lock"), "", { mode: 0o600 });
    await expect(waitForStartResources("x", h.deps)).rejects.toThrow("still-held");
    expect(readFileSync(join(h.slotsDir, ".lock"), "utf8")).toBe("");
    expect(h.warns.join("\n")).not.toContain("放行本次启动");
    expect(slotNames(h.slotsDir)).toEqual([]);
  });

  test("a stuck lease is taken over by one waiter and does not wedge the lane", async () => {
    const slotsDir = mkdtempSync(join(tmpdir(), "anet-612-takeover-"));
    roots.push(slotsDir);
    writeFileSync(join(slotsDir, "stuck"), "77777 111 9999999999999\n", { mode: 0o600 });
    let starting = 0;
    let maxStarting = 0;
    const warns: string[] = [];
    const one = async (nodeId: string) => {
      const h = fakeHost([FROZEN], {
        slotsDir,
        nodeId,
        recheckMs: 5,
        jitterMs: 0,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        now: () => Date.now(),
        random: () => 0,
        warn: (m) => warns.push(m),
        isPidAlive: () => true,
        readProcessStartTicks: () => "222",
        env: {
          ANET_START_GATE_MAX_WAIT_SEC: "0.03",
          ANET_START_MAX_CONCURRENT: "2",
          ANET_START_SINGLE_LANE_MAX_WAIT_SEC: "0.001",
        },
      });
      const r = await waitForStartResources("x", h.deps);
      starting++;
      maxStarting = Math.max(maxStarting, starting);
      try {
        await new Promise((res) => setTimeout(res, 20));
        return r;
      } finally {
        starting--;
        r.release();
      }
    };
    const results = await Promise.all([one("n-a"), one("n-b")]);
    expect(maxStarting).toBe(1);
    expect(results.map((r) => r.outcome)).toEqual(["single-lane", "single-lane"]);
    expect(existsSync(join(slotsDir, "stuck"))).toBe(false);
    expect(warns.join("\n")).toContain(START_GATE_TAKEOVER_STATUS);
    expect(warns.join("\n")).not.toContain("放行本次启动");
    expect(slotNames(slotsDir)).toEqual([]);
  }, 15_000);

  test("a live matching pid keeps a fresh lock; an old one is reclaimed as an orphan", async () => {
    const fresh = fakeHost([HEALTHY], {
      now: () => Date.now(),
      isPidAlive: () => true,
      readProcessStartTicks: () => "111",
      nodeId: "n-fresh",
      sleep: async () => { throw new Error("still-held"); },
    });
    const freshLock = join(fresh.slotsDir, ".lock");
    writeFileSync(freshLock, "88888 111\n", { mode: 0o600 });
    await expect(waitForStartResources("x", fresh.deps)).rejects.toThrow("still-held");
    expect(readFileSync(freshLock, "utf8")).toBe("88888 111\n");
    expect(fresh.warns.join("\n")).not.toContain("孤儿锁");

    const stale = fakeHost([HEALTHY], {
      now: () => Date.now(),
      isPidAlive: () => true,
      readProcessStartTicks: () => "111",
      nodeId: "n-stale",
    });
    const staleLock = join(stale.slotsDir, ".lock");
    writeFileSync(staleLock, "88888 111\n", { mode: 0o600 });
    const old = (Date.now() - 120_000) / 1000;
    utimesSync(staleLock, old, old);
    const r = await waitForStartResources("x", stale.deps);
    expect(r.outcome).toBe("ok");
    expect(stale.warns.join("\n")).toContain("回收被活进程占住的孤儿锁 pid=88888 start=111");
    r.release();
    expect(slotNames(stale.slotsDir)).toEqual([]);
  });

  test("a wall-clock jump does not orphan a lock stamped with a fresh monotonic time", async () => {
    const h = fakeHost([HEALTHY], {
      now: () => Date.now(),
      isPidAlive: () => true,
      readProcessStartTicks: () => "111",
      nodeId: "n-jump",
      sleep: async () => { throw new Error("still-held"); },
      ...({ monotonicNow: () => 5_000 } as object),
    });
    const lockPath = join(h.slotsDir, ".lock");
    writeFileSync(lockPath, "88888 111 t:abc m:5000\n", { mode: 0o600 });
    const old = (Date.now() - 120_000) / 1000;
    utimesSync(lockPath, old, old);
    await expect(waitForStartResources("x", h.deps)).rejects.toThrow("still-held");
    expect(readFileSync(lockPath, "utf8")).toBe("88888 111 t:abc m:5000\n");
    expect(h.warns.join("\n")).not.toContain("孤儿锁");
  });

  test("a stall inside the slot count does not leave two holders after the lock is reclaimed", async () => {
    const slotsDir = mkdtempSync(join(tmpdir(), "anet-612-orphan-"));
    const sideDir = mkdtempSync(join(tmpdir(), "anet-612-orphan-side-"));
    roots.push(slotsDir, sideDir);
    const yPid = 99999;
    writeFileSync(join(slotsDir, "nodeY"), `${yPid} - ${Date.now() + 600_000}\n`, { mode: 0o600 });
    const releaseFlag = join(sideDir, "release-b");
    const holdingFlag = join(sideDir, "b-holding");
    const gateHref = pathToFileURL(join(import.meta.dir, "start-resource-gate.ts")).href;
    const scriptPath = join(sideDir, "racer.mjs");
    writeFileSync(scriptPath, `
      import { waitForStartResources } from ${JSON.stringify(gateHref)};
      import { existsSync, writeFileSync } from "fs";
      import { join } from "path";
      const slots = process.argv[2];
      const releaseFlag = process.argv[3];
      const holdingFlag = process.argv[4];
      const deadline = Date.now() + 8000;
      while (!existsSync(join(slots, ".lock"))) {
        if (Date.now() > deadline) { console.error("NO_LOCK"); process.exit(2); }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
      const mem = "MemTotal:       65642000 kB\\nMemAvailable:   20971520 kB\\n";
      const r = await waitForStartResources("b", {
        env: { ANET_START_MAX_CONCURRENT: "1", ANET_START_GATE_MAX_WAIT_SEC: "8" },
        platform: "linux",
        cpuCount: () => 16,
        readFile: (p) => p === "/proc/meminfo" ? mem : p === "/proc/loadavg" ? "1.00 1.00 1.00 1/1 1\\n" : null,
        sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
        now: () => Date.now(),
        random: () => 0,
        slotsDir: slots,
        nodeId: "nodeB",
        holderPid: 4343,
        isPidAlive: (pid) => pid === 4242 || pid === 4343,
        readProcessStartTicks: () => null,
        lockOrphanMs: 300,
        recheckMs: 50,
        jitterMs: 0,
        log: () => {},
        warn: (m) => console.error(m),
      });
      writeFileSync(holdingFlag, "1");
      const end = Date.now() + 8000;
      while (!existsSync(releaseFlag)) {
        if (Date.now() > end) break;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
      r.release();
      console.log("B_DONE");
    `);
    const childErr: string[] = [];
    const child = spawn(process.execPath, [scriptPath, slotsDir, releaseFlag, holdingFlag], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr.on("data", (buf) => childErr.push(String(buf)));
    child.stdout.on("data", () => {});
    let checks = 0;
    let gateResult: Awaited<ReturnType<typeof waitForStartResources>> | null = null;
    const started = Date.now();
    const gateP = waitForStartResources("a", fakeHost([HEALTHY], {
      slotsDir,
      nodeId: "nodeA",
      holderPid: HOLDER,
      now: () => Date.now(),
      readProcessStartTicks: () => null,
      recheckMs: 30,
      jitterMs: 0,
      sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
      env: { ANET_START_MAX_CONCURRENT: "1", ANET_START_GATE_MAX_WAIT_SEC: "8" },
      isPidAlive: (pid) => {
        if (pid === yPid) {
          checks++;
          if (checks === 1) return true;
          if (checks === 2) {
            const until = Date.now() + 2500;
            while (Date.now() < until) { /* countLiveSlots is inside the lock */ }
            return false;
          }
          return false;
        }
        return pid === HOLDER || pid === 4343;
      },
    }).deps).then((r) => {
      gateResult = r;
      return r;
    });
    try {
      const deadline = started + 7000;
      while (Date.now() - started < 3200 || !existsSync(holdingFlag)) {
        if (Date.now() > deadline) break;
        await new Promise((res) => setTimeout(res, 30));
      }
      const names = slotNames(slotsDir);
      expect(existsSync(holdingFlag), `child did not admit; stderr=${childErr.join("")}`).toBe(true);
      expect(names, `leases=${names.join(",")}`).not.toContain("nodeA");
      expect(names).toContain("nodeB");
      writeFileSync(releaseFlag, "1");
      const admitted = await gateP;
      expect(admitted.outcome === "ok" || admitted.outcome === "waited").toBe(true);
      expect(slotNames(slotsDir)).toEqual(["nodeA"]);
      admitted.release();
    } finally {
      try { writeFileSync(releaseFlag, "1"); } catch { /* already gone */ }
      if (!gateResult) {
        await Promise.race([
          gateP.then((r) => { gateResult = r; }),
          new Promise((res) => setTimeout(res, 3000)),
        ]);
      }
      gateResult?.release();
      child.kill("SIGKILL");
    }
  }, 20_000);

  test("a live pid whose start time does not match does not keep the lock", async () => {
    const h = fakeHost([HEALTHY], {
      now: () => Date.now(),
      isPidAlive: () => true,
      readProcessStartTicks: () => "222",
      nodeId: "n-new",
    });
    writeFileSync(join(h.slotsDir, ".lock"), "88888 111\n", { mode: 0o600 });
    const r = await waitForStartResources("x", h.deps);
    expect(r.outcome).toBe("ok");
    expect(h.warns.join("\n")).not.toContain("孤儿锁");
    expect(slotNames(h.slotsDir)).toEqual(["n-new"]);
    r.release();
  });

  test("an expired lease is reaped even while its pid is still alive", async () => {
    const h = fakeHost([HEALTHY], {
      env: { ANET_START_MAX_CONCURRENT: "1" },
      nodeId: "n-new",
      now: () => 10_000,
      isPidAlive: () => true,
    });
    writeFileSync(join(h.slotsDir, "n-old"), "77777 - 1\n", { mode: 0o600 });
    const r = await waitForStartResources("x", h.deps);
    expect(r.outcome).toBe("ok");
    expect(existsSync(join(h.slotsDir, "n-old"))).toBe(false);
    expect(h.warns.join("\n")).toContain("reaped expired start lease n-old");
    expect(slotNames(h.slotsDir)).toEqual(["n-new"]);
    r.release();
  });

  test("a reused pid with a different start time does not keep the slot", async () => {
    const h = fakeHost([HEALTHY], {
      env: { ANET_START_MAX_CONCURRENT: "1" },
      nodeId: "n-new",
      now: () => 10_000,
      isPidAlive: () => true,
      readProcessStartTicks: () => "222",
    });
    writeFileSync(join(h.slotsDir, "n-old"), "77777 111 1000000000\n", { mode: 0o600 });
    const r = await waitForStartResources("x", h.deps);
    expect(r.outcome).toBe("ok");
    expect(existsSync(join(h.slotsDir, "n-old"))).toBe(false);
    expect(h.warns.join("\n")).not.toContain("reaped expired");
    r.release();
  });

  test("a busy lock retries the release instead of leaking the lease", async () => {
    const h = fakeHost([HEALTHY], {
      nodeId: "n-test",
      isPidAlive: (pid) => pid === HOLDER || pid === 88888,
      readProcessStartTicks: () => null,
    });
    const r = await waitForStartResources("x", h.deps);
    expect(slotNames(h.slotsDir)).toEqual(["n-test"]);
    writeFileSync(join(h.slotsDir, ".lock"), "88888 111\n", { mode: 0o600 });
    r.release();
    expect(slotNames(h.slotsDir)).toEqual(["n-test"]);
    expect(h.warns.join("\n")).toContain("lock busy; retrying");
    unlinkSync(join(h.slotsDir, ".lock"));
    await new Promise((res) => setTimeout(res, 1500));
    expect(slotNames(h.slotsDir)).toEqual([]);
  }, 10_000);

  test("same node released onto a busy lock, then started again, still excludes a third party", async () => {
    const slotsDir = mkdtempSync(join(tmpdir(), "anet-612-reentry-"));
    roots.push(slotsDir);
    const warns: string[] = [];
    const common = {
      slotsDir,
      now: () => Date.now(),
      readProcessStartTicks: () => null as string | null,
      recheckMs: 40,
      jitterMs: 0,
      sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
      warn: (m: string) => warns.push(m),
      log: () => {},
      env: { ANET_START_MAX_CONCURRENT: "1", ANET_START_GATE_MAX_WAIT_SEC: "30" },
    };
    const a1 = fakeHost([HEALTHY], {
      ...common,
      nodeId: "nodeA",
      holderPid: HOLDER,
      isPidAlive: (pid) => pid === HOLDER || pid === 88888 || pid === 4343,
    });
    const first = await waitForStartResources("a", a1.deps);
    expect(slotNames(slotsDir)).toEqual(["nodeA"]);
    const lockPath = join(slotsDir, ".lock");
    writeFileSync(lockPath, "88888 111\n", { mode: 0o600 });
    first.release();
    expect(slotNames(slotsDir)).toEqual(["nodeA"]);
    expect(warns.join("\n")).toContain("lock busy; retrying");
    unlinkSync(lockPath);
    const a2 = fakeHost([HEALTHY], {
      ...common,
      nodeId: "nodeA",
      holderPid: HOLDER,
      isPidAlive: (pid) => pid === HOLDER || pid === 88888 || pid === 4343,
    });
    const second = await waitForStartResources("a", a2.deps);
    expect(second.outcome).toBe("ok");
    expect(a2.sleeps).toEqual([]);
    expect(slotNames(slotsDir)).toEqual(["nodeA"]);
    let third: Awaited<ReturnType<typeof waitForStartResources>> | null = null;
    const b = fakeHost([HEALTHY], {
      ...common,
      nodeId: "nodeB",
      holderPid: 4343,
      isPidAlive: (pid) => pid === HOLDER || pid === 4343,
    });
    const thirdTask = waitForStartResources("b", b.deps).then((r) => {
      third = r;
      return r;
    });
    await new Promise((res) => setTimeout(res, 700));
    expect(slotNames(slotsDir)).toEqual(["nodeA"]);
    expect(third).toBeNull();
    second.release();
    const admitted = await thirdTask;
    expect(admitted.outcome === "ok" || admitted.outcome === "waited").toBe(true);
    expect(slotNames(slotsDir)).toEqual(["nodeB"]);
    admitted.release();
    expect(slotNames(slotsDir)).toEqual([]);
  }, 15_000);

  test("a 512 MiB cgroup on a large host is admitted when the container itself has headroom", async () => {
    const MiB = 1024 * 1024;
    const h = fakeHost([HEALTHY], {
      readFile: (p) => {
        if (p === "/proc/meminfo") return meminfo(20 * GiB_KB);
        if (p === "/proc/loadavg") return loadavg(1);
        if (p === "/proc/self/cgroup") return "0::/docker/abc\n";
        if (p === "/sys/fs/cgroup/docker/abc/memory.max") return String(512 * MiB);
        if (p === "/sys/fs/cgroup/docker/abc/memory.current") return String(20 * MiB);
        return null;
      },
    });
    const r = await waitForStartResources("x", h.deps);
    expect(r.outcome).toBe("ok");
    expect(h.sleeps).toEqual([]);
    r.release();
  });

  test("inactive_file is not counted as cgroup usage", async () => {
    const MiB = 1024 * 1024;
    const h = fakeHost([HEALTHY], {
      env: { ANET_START_MIN_MEM_MB: "300" },
      readFile: (p) => {
        if (p === "/proc/meminfo") return meminfo(20 * GiB_KB);
        if (p === "/proc/loadavg") return loadavg(0.2);
        if (p === "/proc/self/cgroup") return "0::/docker/abc\n";
        if (p === "/sys/fs/cgroup/docker/abc/memory.max") return String(512 * MiB);
        if (p === "/sys/fs/cgroup/docker/abc/memory.current") return String(373 * MiB);
        if (p === "/sys/fs/cgroup/docker/abc/memory.stat") return `inactive_file ${350 * MiB}\n`;
        return null;
      },
    });
    const r = await waitForStartResources("x", h.deps);
    expect(r.outcome).toBe("ok");
    expect(h.sleeps).toEqual([]);
    r.release();
  });

  test("copresence watchdog relaunch of -appsrv goes through the start gate", () => {
    const cli = readFileSync(new URL("../../cli.ts", import.meta.url), "utf8");
    const call = "appsrvSnapshot = await relaunchAppServer(";
    const at = cli.indexOf(call);
    expect(at).toBeGreaterThan(0);
    expect(cli.indexOf(call, at + call.length)).toBe(-1);
    const before = cli.slice(Math.max(0, at - 700), at);
    const after = cli.slice(at, at + 500);
    expect(before).toContain('waitForStartResources("codex app-server relaunch"');
    expect(before).toContain("try {");
    expect(after).toContain("finally");
    expect(after).toContain("gate.release()");
  });
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

// #612 step 1 — memory/load gate before an owned codex app-server is spawned.
// All host readings are injected; nothing here reads the real /proc.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseLoad1,
  parseMemAvailableMb,
  waitForStartResources,
  type StartGateDeps,
} from "./start-resource-gate";
import { openCodexAppServerRuntime } from "./runtime";

const GiB_KB = 1024 * 1024;

function meminfo(availableKb: number): string {
  return `MemTotal:       65642000 kB\nMemFree:          300000 kB\nMemAvailable:   ${availableKb} kB\nBuffers:           10000 kB\n`;
}
function loadavg(load1: number): string {
  return `${load1.toFixed(2)} 120.00 80.00 3/2000 12345\n`;
}

/** A fake host whose readings advance one step per sample. */
function fakeHost(steps: Array<{ memKb: number; load1: number }>, extra: Partial<StartGateDeps> = {}) {
  let i = 0;
  let clock = 0;
  const sleeps: number[] = [];
  const logs: string[] = [];
  const warns: string[] = [];
  let reads = 0;
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
    ...extra,
  };
  return { deps, sleeps, logs, warns, reads: () => reads };
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
});

describe("#612 waitForStartResources", () => {
  test("pass: healthy host starts immediately without waiting or logging", async () => {
    const h = fakeHost([HEALTHY]);
    const r = await waitForStartResources("codex app-server", h.deps);
    expect(r.outcome).toBe("ok");
    expect(h.sleeps).toEqual([]);
    expect(h.logs).toEqual([]);
    expect(h.warns).toEqual([]);
  });

  test("wait-then-pass: low memory + high load waits, re-checks every ~15 s with jitter, then starts", async () => {
    const h = fakeHost([FROZEN, FROZEN, HEALTHY]);
    const r = await waitForStartResources("codex app-server", h.deps);
    expect(r.outcome).toBe("waited");
    expect(r.checks).toBe(3);
    expect(h.sleeps.length).toBe(2);
    for (const ms of h.sleeps) { expect(ms).toBeGreaterThanOrEqual(15_000); expect(ms).toBeLessThan(20_000); }
    expect(h.sleeps[0]).toBe(17_500); // 15 s + random(0.5) * 5 s jitter
    // one clear line with the measured values and the reason
    const first = h.logs[0];
    expect(first).toContain("waiting before start");
    expect(first).toContain("MemAvailable 307 MiB < 4096 MiB");
    expect(first).toContain("load1 146.00 > 32 (2 x 16 CPUs");
    expect(h.logs.at(-1)).toContain("host has headroom after 35s");
    expect(h.warns).toEqual([]);
  });

  test("load alone over 2 x CPUs is enough to wait", async () => {
    const h = fakeHost([{ memKb: 20 * GiB_KB, load1: 33 }, HEALTHY]);
    const r = await waitForStartResources("x", h.deps);
    expect(r.outcome).toBe("waited");
    expect(h.logs[0]).toContain("load1 33.00 > 32");
    expect(h.logs[0]).not.toContain("MemAvailable");
  });

  test("timeout-then-proceed: never gets headroom → gives up after the max wait with a warning", async () => {
    const h = fakeHost([FROZEN]);
    const r = await waitForStartResources("codex app-server", h.deps);
    expect(r.outcome).toBe("timeout");
    expect(r.waitedMs).toBe(600_000);
    expect(h.warns.length).toBe(1);
    expect(h.warns[0]).toContain("giving up waiting and starting anyway");
    expect(h.warns[0]).toContain("MemAvailable 307 MiB");
    // progress is logged at most about once a minute, not every re-check
    expect(h.logs.length).toBeLessThanOrEqual(12);
  });

  test("env overrides thresholds and max wait", async () => {
    const h = fakeHost([{ memKb: 3 * GiB_KB, load1: 1 }], {
      env: { ANET_START_MIN_MEM_MB: "2048", ANET_START_MAX_LOAD_PER_CPU: "4", ANET_START_GATE_MAX_WAIT_SEC: "30" },
    });
    expect((await waitForStartResources("x", h.deps)).outcome).toBe("ok");

    const t = fakeHost([FROZEN], { env: { ANET_START_GATE_MAX_WAIT_SEC: "30" } });
    const r = await waitForStartResources("x", t.deps);
    expect(r.outcome).toBe("timeout");
    expect(r.waitedMs).toBe(30_000);
  });

  test("disabled: ANET_START_MEM_GATE=0 never reads /proc", async () => {
    const h = fakeHost([FROZEN], { env: { ANET_START_MEM_GATE: "0" } });
    const r = await waitForStartResources("x", h.deps);
    expect(r.outcome).toBe("disabled");
    expect(h.reads()).toBe(0);
    expect(h.sleeps).toEqual([]);
  });

  test("non-Linux: no-op, never reads /proc", async () => {
    const h = fakeHost([FROZEN], { platform: "darwin" });
    const r = await waitForStartResources("x", h.deps);
    expect(r.outcome).toBe("unsupported");
    expect(h.reads()).toBe(0);
    expect(h.sleeps).toEqual([]);
  });

  test("Linux without readable /proc: no-op", async () => {
    const h = fakeHost([FROZEN], { readFile: () => null });
    const r = await waitForStartResources("x", h.deps);
    expect(r.outcome).toBe("unsupported");
    expect(h.sleeps).toEqual([]);
  });
});

// Wiring: the gate must run BEFORE the owned app-server is spawned.
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

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
  });
});

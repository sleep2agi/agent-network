import { describe, expect, test } from "bun:test";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import type { AddressInfo } from "node:net";

import {
  createAppServerWatchdog,
  DEFAULT_FAILURES_BEFORE_RESTART,
  DEFAULT_MAX_RESTARTS,
  DEFAULT_HUNG_KILL_GRACE_MS,
  DEFAULT_HUNG_PROBES_BEFORE_KILL,
  DEFAULT_RESTART_WINDOW_MS,
  hungKillGraceFromEnv,
  watchdogLimitsFromEnv,
} from "./codex-appserver-watchdog";
import { createCodexHealthMonitor, healthSignature, ModelAuthTracker, type AppServerHealth } from "./codex-health";

const down: AppServerHealth = { ok: false, rtt_ms: null, last_error: "closed before open (code=1006)" };
const up: AppServerHealth = { ok: true, rtt_ms: 3, last_error: null };
const settle = () => new Promise((r) => setTimeout(r, 0));

function harness(opts: { fail?: boolean; blocked?: string | null; max?: number; windowMs?: number } = {}) {
  let t = 1_000_000;
  const calls: string[] = [];
  let settled = 0;
  const wd = createAppServerWatchdog({
    maxRestarts: opts.max ?? 3,
    windowMs: opts.windowMs ?? 600_000,
    now: () => t,
    canRestart: () => opts.blocked ?? null,
    restart: async (cause) => { calls.push(cause); if (opts.fail) throw new Error("bind timeout"); },
    onSettled: () => { settled++; },
  });
  return { wd, calls, settled: () => settled, advance: (ms: number) => { t += ms; } };
}

describe("app-server watchdog (#461)", () => {
  test("defaults: 3 restarts per 10 min, 2 failed probes before acting", () => {
    expect(DEFAULT_MAX_RESTARTS).toBe(3);
    expect(DEFAULT_RESTART_WINDOW_MS).toBe(600_000);
    expect(DEFAULT_FAILURES_BEFORE_RESTART).toBe(2);
  });

  test("a single failed probe does not restart; the second one does", async () => {
    const h = harness();
    expect(h.wd.observe(down)).toEqual(down);
    expect(h.calls).toHaveLength(0);
    const r = h.wd.observe(down);
    expect(r.ok).toBe(false);
    expect(r.last_error).toMatch(/^restarting app-server \(attempt 1\/3\)/);
    await settle(); await settle();
    expect(h.calls).toHaveLength(1);
    expect(h.settled()).toBe(1);
    expect(h.wd.state().phase).toBe("watching");
  });

  test("a known exit restarts on the next failed probe without waiting for confirmation", async () => {
    const h = harness();
    h.wd.noteExit();
    expect(h.wd.observe(down).last_error).toMatch(/^restarting app-server \(attempt 1\/3\): process exited/);
    await settle(); await settle();
    expect(h.calls).toHaveLength(1);
  });

  test("while restarting, probes report the restart instead of starting another", async () => {
    let release!: () => void;
    const calls: string[] = [];
    const wd = createAppServerWatchdog({ restart: (c) => { calls.push(c); return new Promise<void>((r) => { release = r; }); } });
    wd.observe(down); wd.observe(down);
    expect(wd.state().phase).toBe("restarting");
    for (let i = 0; i < 5; i++) expect(wd.observe(down).last_error).toMatch(/^restarting app-server \(attempt 1\/3\)/);
    await settle();
    expect(calls).toHaveLength(1);
    release();
  });

  test("health goes back to ok as soon as the probe answers", async () => {
    const h = harness();
    h.wd.observe(down); h.wd.observe(down);
    await settle(); await settle();
    expect(h.wd.observe(up)).toEqual(up);
    expect(h.wd.state().consecutiveFailures).toBe(0);
  });

  test("gives up after N restarts inside the window and stays degraded with the reason", async () => {
    const h = harness({ fail: true });
    for (let i = 0; i < 3; i++) {
      h.wd.observe(down); h.wd.observe(down);
      await settle(); await settle();
      h.advance(10_000);
    }
    expect(h.calls).toHaveLength(3);
    h.wd.observe(down);
    const r = h.wd.observe(down);
    expect(r.ok).toBe(false);
    expect(r.last_error).toMatch(/auto-restart gave up: 3 restarts in 10 min \(last: bind timeout\)/);
    expect(r.last_error).toMatch(/anet node restart/);
    expect(h.wd.state().phase).toBe("gave_up");
    // Sticky: later failures keep the reason and never restart again.
    h.advance(3_600_000);
    for (let i = 0; i < 4; i++) expect(h.wd.observe(down).last_error).toMatch(/gave up/);
    expect(h.calls).toHaveLength(3);
  });

  test("restarts older than the window do not count", async () => {
    const h = harness({ fail: true, max: 2, windowMs: 60_000 });
    for (let i = 0; i < 2; i++) { h.wd.observe(down); h.wd.observe(down); await settle(); await settle(); }
    h.advance(61_000);
    h.wd.observe(down);
    expect(h.wd.observe(down).last_error).toMatch(/^restarting app-server/);
    await settle(); await settle();
    expect(h.calls).toHaveLength(3);
  });

  test("a probe that answers again after giving up (fixed by hand) clears the give-up", async () => {
    const h = harness({ fail: true, max: 1 });
    h.wd.observe(down); h.wd.observe(down); await settle(); await settle();
    h.wd.observe(down); h.wd.observe(down);
    expect(h.wd.state().phase).toBe("gave_up");
    expect(h.wd.observe(up)).toEqual(up);
    expect(h.wd.state().phase).toBe("watching");
  });

  test("a blocked restart is reported, not attempted, and does not use the budget", () => {
    const h = harness({ blocked: "app-server process 42 is still alive but not answering; not killing a live process" });
    h.wd.observe(down);
    const r = h.wd.observe(down);
    expect(r.last_error).toMatch(/not restarting: app-server process 42 is still alive/);
    expect(h.calls).toHaveLength(0);
    expect(h.wd.state().restarts).toHaveLength(0);
  });

  test("env limits: valid integers win, junk falls back", () => {
    expect(watchdogLimitsFromEnv({ ANET_CODEX_APPSERVER_RESTART_MAX: "2", ANET_CODEX_APPSERVER_RESTART_WINDOW_MS: "5000" } as any)).toEqual({ maxRestarts: 2, windowMs: 5000, hungProbesBeforeKill: 4 });
    expect(watchdogLimitsFromEnv({ ANET_CODEX_APPSERVER_RESTART_MAX: "0", ANET_CODEX_APPSERVER_RESTART_WINDOW_MS: "abc" } as any)).toEqual({ maxRestarts: 3, windowMs: 600_000, hungProbesBeforeKill: 4 });
  });
});

describe("health monitor + watchdog", () => {
  test("restart start and give-up are signature flips (reported at once, not at the next heartbeat)", () => {
    const base = { bridge: "ok" as const, model_auth: "unknown" as const };
    const plainDown = healthSignature({ ...base, app_server: down });
    const restarting = healthSignature({ ...base, app_server: { ...down, last_error: "restarting app-server (attempt 1/3): x" } });
    const gaveUp = healthSignature({ ...base, app_server: { ...down, last_error: "app-server auto-restart gave up: 3 restarts in 10 min" } });
    expect(new Set([plainDown, restarting, gaveUp]).size).toBe(3);
  });

  test("a blocked restart is a signature flip too: the reason reaches the Hub at once, not at the next heartbeat", async () => {
    // The probe error stays byte-identical ("Connection ended"); only the watchdog's verdict changes on the 2nd probe.
    const reports: string[] = [];
    const wd = createAppServerWatchdog({
      canRestart: () => "tmux session x-appsrv still has a live pane; not replacing it",
      restart: async () => { throw new Error("must not restart"); },
    });
    const mon = createCodexHealthMonitor({
      appServerUrl: () => "ws://127.0.0.1:1",
      modelAuth: new ModelAuthTracker(),
      probeAppServer: async () => down,
      onAppServerProbe: (h) => wd.observe(h),
      onChange: (r) => reports.push(r.app_server?.last_error ?? ""),
    });
    await mon.tick(); // 1st failure: below the threshold, the raw probe error
    expect(reports).toEqual([down.last_error]);
    await mon.tick(); // 2nd failure: the watchdog looks, and declines
    expect(reports).toHaveLength(2);
    expect(reports[1]).toMatch(/; not restarting: tmux session x-appsrv still has a live pane/);
    await mon.tick();
    expect(reports).toHaveLength(2); // stable verdict: no report on every tick
  });

  test("end to end: server dies → degraded+restarting → restart rebinds → ok, each flip reported", async () => {
    // A bare TCP server that answers the ws upgrade; "dying" = closing it, "restart" = listening again on the same port.
    let srv: NetServer | null = null;
    const listen = (port = 0) => new Promise<number>((resolve) => {
      srv = createNetServer((sock) => {
        sock.on("error", () => {});
        sock.once("data", (d) => {
          const key = /Sec-WebSocket-Key: (.+)\r\n/i.exec(d.toString("latin1"))?.[1]?.trim() ?? "";
          const accept = require("node:crypto").createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
          sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        });
      }).listen(port, "127.0.0.1", () => resolve((srv!.address() as AddressInfo).port));
    });
    const port = await listen();
    const url = `ws://127.0.0.1:${port}`;
    const reports: string[] = [];
    let restarts = 0;
    const wd = createAppServerWatchdog({
      failuresBeforeRestart: 1,
      restart: async () => { restarts++; await listen(port); },
    });
    const { probeAppServerWs } = await import("./codex-health");
    const mon = createCodexHealthMonitor({
      appServerUrl: () => url,
      modelAuth: new ModelAuthTracker(),
      probeAppServer: (u) => probeAppServerWs(u, { wsCtor: WebSocket, timeoutMs: 1_000 }),
      onAppServerProbe: (h) => wd.observe(h),
      onChange: (r) => reports.push(`${r.app_server?.ok}:${(r.app_server?.last_error ?? "").slice(0, 20)}`),
    });
    expect((await mon.tick()).app_server?.ok).toBe(true);
    await new Promise<void>((r) => srv!.close(() => r()));
    const degraded = await mon.tick();
    expect(degraded.app_server?.ok).toBe(false);
    expect(degraded.app_server?.last_error).toMatch(/^restarting app-server \(attempt 1\/3\)/);
    await new Promise((r) => setTimeout(r, 50));
    const healed = await mon.tick();
    expect(healed.app_server?.ok).toBe(true);
    expect(restarts).toBe(1);
    expect(reports).toEqual(["false:restarting app-serve", "true:"]);
    await new Promise<void>((r) => srv!.close(() => r()));
  });
});

describe("hung app-server: alive but not answering (#465)", () => {
  const hung: AppServerHealth = { ok: false, rtt_ms: null, last_error: "no ws handshake within 5000ms" };
  function hungHarness(opts: { veto?: string | null; alive?: boolean; m?: number } = {}) {
    const calls: Array<{ cause: string; killHung: boolean }> = [];
    const wd = createAppServerWatchdog({
      maxRestarts: 3,
      hungProbesBeforeKill: opts.m ?? 4,
      canRestart: () => "app-server process 42 is still alive but not answering; not killing a live process",
      appServerAlive: () => opts.alive ?? true,
      canKillHung: () => opts.veto ?? null,
      restart: async (cause, o) => { calls.push({ cause, killHung: !!o?.killHung }); },
    });
    return { wd, calls };
  }

  test("defaults: 4 failed probes before killing, 10 s SIGTERM grace; env can tune both", () => {
    expect(DEFAULT_HUNG_PROBES_BEFORE_KILL).toBe(4);
    expect(DEFAULT_HUNG_KILL_GRACE_MS).toBe(10_000);
    expect(watchdogLimitsFromEnv({ ANET_CODEX_APPSERVER_HUNG_PROBES: "2" } as any).hungProbesBeforeKill).toBe(2);
    expect(watchdogLimitsFromEnv({ ANET_CODEX_APPSERVER_HUNG_PROBES: "0" } as any).hungProbesBeforeKill).toBe(4);
    expect(hungKillGraceFromEnv({ ANET_CODEX_APPSERVER_KILL_GRACE_MS: "1500" } as any)).toBe(1500);
    expect(hungKillGraceFromEnv({ ANET_CODEX_APPSERVER_KILL_GRACE_MS: "x" } as any)).toBe(10_000);
    expect(hungKillGraceFromEnv({} as any)).toBe(10_000);
  });

  test("M-1 failed probes only report (with the count); the Mth kills + relaunches", async () => {
    const h = hungHarness();
    expect(h.wd.observe(hung).last_error).toBe(hung.last_error); // 1st: below the dead-process threshold too
    for (let i = 2; i <= 3; i++) {
      expect(h.wd.observe(hung).last_error).toContain(`app-server is alive but not answering (${i}/4 failed probes`);
    }
    expect(h.calls).toHaveLength(0);
    const r = h.wd.observe(hung);
    expect(r.last_error).toMatch(/^restarting app-server \(attempt 1\/3\): hung \(alive, 4 failed probes\)/);
    await settle(); await settle();
    expect(h.calls).toEqual([{ cause: expect.stringContaining("hung (alive, 4 failed probes)"), killHung: true }]);
  });

  test("a ws close (noteExit) does not shortcut the hung count: a live process still needs M probes", async () => {
    const h = hungHarness();
    h.wd.noteExit();
    for (let i = 1; i <= 3; i++) h.wd.observe(hung);
    expect(h.calls).toHaveLength(0);
    h.wd.observe(hung);
    await settle(); await settle();
    expect(h.calls.map((c) => c.killHung)).toEqual([true]);
  });

  test("identity veto → reported, never killed, no budget used", async () => {
    const h = hungHarness({ veto: "pid 42 carries another identity marker" });
    let last: AppServerHealth = hung;
    for (let i = 0; i < 10; i++) last = h.wd.observe(hung);
    await settle();
    expect(h.calls).toHaveLength(0);
    expect(last.last_error).toContain("not killing it: pid 42 carries another identity marker");
    expect(h.wd.state().restarts).toHaveLength(0);
  });

  test("no hung support wired (macOS/Windows: appServerAlive false) → the old report-only path", async () => {
    const h = hungHarness({ alive: false });
    let last: AppServerHealth = hung;
    for (let i = 0; i < 10; i++) last = h.wd.observe(hung);
    await settle();
    expect(h.calls).toHaveLength(0);
    expect(last.last_error).toContain("not restarting: app-server process 42 is still alive");
  });

  test("the hung kill shares the restart budget (3 per window) and then gives up", async () => {
    const h = hungHarness({ m: 2 });
    for (let i = 0; i < 6; i++) { h.wd.observe(hung); await settle(); await settle(); }
    expect(h.calls).toHaveLength(3);
    expect(h.calls.every((c) => c.killHung)).toBe(true);
    h.wd.observe(hung);
    expect(h.wd.observe(hung).last_error).toMatch(/auto-restart gave up: 3 restarts/);
    await settle();
    expect(h.calls).toHaveLength(3);
  });

  test("entering the hung state is a signature flip (the Hub hears it at once); the counter ticking is not", () => {
    const base = { model_auth: "unknown" as const };
    const plain = healthSignature({ ...base, app_server: hung });
    const hung2 = healthSignature({ ...base, app_server: { ...hung, last_error: `${hung.last_error}; app-server is alive but not answering (2/4 failed probes before restarting it)` } });
    const hung3 = healthSignature({ ...base, app_server: { ...hung, last_error: `${hung.last_error}; app-server is alive but not answering (3/4 failed probes before restarting it)` } });
    const vetoed = healthSignature({ ...base, app_server: { ...hung, last_error: `${hung.last_error}; app-server is alive but not answering; not killing it: x` } });
    expect(hung2).not.toBe(plain);
    expect(hung3).toBe(hung2);
    expect(vetoed).toBe(hung2);
  });

  test("an answering probe resets the hung count", () => {
    const h = hungHarness();
    for (let i = 0; i < 3; i++) h.wd.observe(hung);
    h.wd.observe(up);
    for (let i = 0; i < 3; i++) h.wd.observe(hung);
    expect(h.calls).toHaveLength(0);
  });
});

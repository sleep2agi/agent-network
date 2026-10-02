import { describe, expect, test } from "bun:test";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import type { AddressInfo } from "node:net";

import {
  createAppServerWatchdog,
  DEFAULT_FAILURES_BEFORE_RESTART,
  DEFAULT_MAX_RESTARTS,
  DEFAULT_RESTART_WINDOW_MS,
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
    expect(watchdogLimitsFromEnv({ ANET_CODEX_APPSERVER_RESTART_MAX: "2", ANET_CODEX_APPSERVER_RESTART_WINDOW_MS: "5000" } as any)).toEqual({ maxRestarts: 2, windowMs: 5000 });
    expect(watchdogLimitsFromEnv({ ANET_CODEX_APPSERVER_RESTART_MAX: "0", ANET_CODEX_APPSERVER_RESTART_WINDOW_MS: "abc" } as any)).toEqual({ maxRestarts: 3, windowMs: 600_000 });
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

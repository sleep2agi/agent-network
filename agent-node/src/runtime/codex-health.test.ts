import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";

import {
  classifyModelAuthError,
  classifyTuiPane,
  createCodexHealthMonitor,
  describeModelAuthBlock,
  gateStatusOnModelAuth,
  modelAuthBlocksWork,
  isLoopbackWsUrl,
  ModelAuthTracker,
  parseTmuxPanes,
  probeAppServerWs,
  type TuiHealth,
} from "./codex-health";

const servers: Array<Server | NetServer> = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

/** 最小 ws 握手服务器(裸 TCP,Bun/Node 通用):只回 101,不说 JSON-RPC —— 探针也只该需要这么多。 */
async function wsHandshakeServer(): Promise<number> {
  const srv = createNetServer((sock) => {
    let buf = "";
    sock.on("error", () => {});
    sock.on("data", (d) => {
      buf += d.toString("latin1");
      if (!buf.includes("\r\n\r\n")) return;
      const key = /sec-websocket-key:\s*(\S+)/i.exec(buf)?.[1] ?? "";
      const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    });
  });
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return (srv.address() as AddressInfo).port;
}
async function closedPort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

describe("#448 model_auth classification", () => {
  test.each([
    ["Failed to refresh token: 401 Unauthorized: refresh token was already used", "revoked"],
    ["Your access token could not be refreshed because your refresh token was revoked. Please log in again.", "revoked"],
    ["refresh_token_reused", "revoked"],
    ["{\"error\":\"invalid_grant\"}", "revoked"],
    ["Your access token could not be refreshed because your refresh token has expired.", "expired"],
    ["unexpected status 401 Unauthorized", "expired"],
    ["error: token_expired", "expired"],
  ])("%s → %s", (text, want) => {
    expect(classifyModelAuthError(text)).toBe(want as any);
  });

  test.each([
    "turn timed out after 600000ms",
    "tool call failed: ENOENT",
    "stream disconnected before completion",
    "",
  ])("not a login error: %s → null", (text) => {
    expect(classifyModelAuthError(text)).toBeNull();
  });

  test("tracker: unknown → ok on success; unrelated failures do not move it; login failures do", () => {
    const t = new ModelAuthTracker();
    expect(t.get()).toBe("unknown");
    t.noteSuccess();
    expect(t.get()).toBe("ok");
    t.noteError("turn timed out");
    expect(t.get()).toBe("ok");
    t.noteError("refresh token was already used");
    expect(t.get()).toBe("revoked");
    t.noteSuccess();
    expect(t.get()).toBe("ok");
  });
});

describe("#448 app_server ws probe", () => {
  const wsCtor = (globalThis as any).WebSocket;

  test("listener present → ok with rtt", async () => {
    const port = await wsHandshakeServer();
    const r = await probeAppServerWs(`ws://127.0.0.1:${port}`, { wsCtor, timeoutMs: 3_000 });
    expect(r.ok).toBe(true);
    expect(typeof r.rtt_ms).toBe("number");
    expect(r.last_error).toBeNull();
  });

  test("no listener (the field failure) → ok:false with an error, never hangs", async () => {
    const port = await closedPort();
    const r = await probeAppServerWs(`ws://127.0.0.1:${port}`, { wsCtor, timeoutMs: 3_000 });
    expect(r.ok).toBe(false);
    expect(r.rtt_ms).toBeNull();
    expect(r.last_error).toBeTruthy();
  });

  test("non-loopback url is refused without connecting", async () => {
    let constructed = 0;
    const r = await probeAppServerWs("ws://10.0.0.1:1", { wsCtor: function () { constructed++; }, timeoutMs: 100 });
    expect(r).toEqual({ ok: false, rtt_ms: null, last_error: "not a loopback ws url" });
    expect(constructed).toBe(0);
    expect(isLoopbackWsUrl("ws://localhost:9")).toBe(true);
  });
});

describe("#448 tui pane classification", () => {
  const out = [
    "甲节点\t100\t0\tnode",
    "甲节点-appsrv\t101\t0\tcodex",
    "乙节点\t200\t0\tsleep",
    "丙节点\t300\t1\tcodex",
    "丁节点\t400\t0\tbash",
  ].join("\n") + "\n";
  const rows = parseTmuxPanes(out);
  const cmdline = (pid: number) => (pid === 400 ? "sleep\0infinity\0" : "codex\0resume\0");

  test.each([
    ["甲节点", { ok: true, reason: "running" }],
    ["乙节点", { ok: false, reason: "sleep-placeholder" }],
    ["丁节点", { ok: false, reason: "sleep-placeholder" }], // pane_current_command 是 bash,但进程本身是 sleep infinity
    ["丙节点", { ok: false, reason: "pane-dead" }],
    ["不存在", { ok: false, reason: "session-missing" }],
  ] as Array<[string, TuiHealth]>)("%s", (session, want) => {
    expect(classifyTuiPane(rows, session, cmdline)).toEqual(want);
  });

  test("exact name match: a prefix-sharing -appsrv session does not count as the TUI", () => {
    const onlyAppsrv = parseTmuxPanes("甲节点-appsrv\t101\t0\tcodex\n");
    expect(classifyTuiPane(onlyAppsrv, "甲节点", () => null)).toEqual({ ok: false, reason: "session-missing" });
  });
  test("tmux unavailable", () => {
    expect(classifyTuiPane(null, "x", () => null)).toEqual({ ok: false, reason: "tmux-unavailable" });
  });
});

describe("#448 health monitor", () => {
  test("snapshot shape; onChange fires on a flip, not on every tick", async () => {
    const modelAuth = new ModelAuthTracker();
    let up = true;
    const changes: any[] = [];
    const m = createCodexHealthMonitor({
      appServerUrl: () => "ws://127.0.0.1:1",
      tuiSession: "t",
      modelAuth,
      probeAppServer: async () => (up ? { ok: true, rtt_ms: 3, last_error: null } : { ok: false, rtt_ms: null, last_error: "refused" }),
      probeTui: () => ({ ok: true, reason: "running" }),
      onChange: (r) => changes.push(r),
    });
    expect(await m.tick()).toEqual({
      bridge: "ok",
      app_server: { ok: true, rtt_ms: 3, last_error: null },
      tui: { ok: true, reason: "running" },
      model_auth: "unknown",
    });
    await m.tick();
    expect(changes.length).toBe(0);
    up = false;
    await m.tick();
    expect(changes.length).toBe(1);
    expect(changes[0].app_server.ok).toBe(false);
    modelAuth.noteError("refresh token was already used");
    m.noteModelAuthMaybeChanged();
    expect(changes.length).toBe(2);
    expect(changes[1].model_auth).toBe("revoked");
  });

  test("no url and no tui session → only bridge + model_auth (subset for non-copresence)", async () => {
    const m = createCodexHealthMonitor({
      appServerUrl: () => undefined,
      modelAuth: new ModelAuthTracker(),
      probeAppServer: async () => { throw new Error("must not be called"); },
    });
    expect(await m.tick()).toEqual({ bridge: "ok", model_auth: "unknown" });
  });

  test("a probe that throws is reported, not propagated", async () => {
    const m = createCodexHealthMonitor({
      appServerUrl: () => "ws://127.0.0.1:1",
      modelAuth: new ModelAuthTracker(),
      probeAppServer: async () => { throw new Error("boom"); },
    });
    const r = await m.tick();
    expect(r.app_server).toEqual({ ok: false, rtt_ms: null, last_error: "boom" });
  });
});

describe("#448 owner constraint: a node whose own login is revoked/expired reports it cannot take work", () => {
  const HOME_DIR = "/w/.anet/nodes/mine/codex-home";

  test("revoked / expired block work; ok / unknown do not", () => {
    expect(modelAuthBlocksWork("revoked")).toBe(true);
    expect(modelAuthBlocksWork("expired")).toBe(true);
    expect(modelAuthBlocksWork("ok")).toBe(false);
    expect(modelAuthBlocksWork("unknown")).toBe(false);
  });

  test("idle is reported as error with a message naming THIS node's CODEX_HOME", () => {
    const g = gateStatusOnModelAuth("idle", undefined, "revoked", HOME_DIR);
    expect(g.status).toBe("error");
    expect(g.task).toContain(`this node's CODEX_HOME (${HOME_DIR}) needs a fresh login`);
    expect(g.task).toContain(`CODEX_HOME=${HOME_DIR} codex login`);
  });

  test("a running turn is not relabelled; a healthy login leaves idle alone", () => {
    expect(gateStatusOnModelAuth("working", "t", "expired", HOME_DIR)).toEqual({ status: "working", task: "t" });
    expect(gateStatusOnModelAuth("idle", undefined, "ok", HOME_DIR)).toEqual({ status: "idle", task: undefined });
    expect(gateStatusOnModelAuth("idle", undefined, "unknown", HOME_DIR)).toEqual({ status: "idle", task: undefined });
  });

  test("the remedy is a fresh login on this node — never copying/switching credentials, never a fixed period", () => {
    const msg = describeModelAuthBlock("revoked", HOME_DIR);
    expect(msg).toContain("do not copy another node's auth.json");
    for (const bad of [/switch/i, /\b7[- ]?day/i, /\bweek/i, /stage/i]) expect(msg).not.toMatch(bad);
    // 正控:上面的反向断言确实能抓到东西
    expect("re-stage the token").toMatch(/stage/i);
  });

  test("re-login on this node (auth.json rewritten after the failure) lifts the block; an older file does not", () => {
    let t = 1_000;
    const tr = new ModelAuthTracker(() => t);
    tr.noteError("refresh token was already used");
    expect(tr.get()).toBe("revoked");
    expect(tr.reconsiderAfterLogin(900)).toBe(false);
    expect(tr.reconsiderAfterLogin(null)).toBe(false);
    expect(tr.get()).toBe("revoked");
    expect(tr.reconsiderAfterLogin(1_500)).toBe(true);
    expect(tr.get()).toBe("unknown");
  });

  test("monitor: re-login is noticed on the next tick and flips the report", async () => {
    let t = 1_000;
    let mtime = 500;
    const tr = new ModelAuthTracker(() => t);
    const changes: any[] = [];
    const m = createCodexHealthMonitor({
      appServerUrl: () => undefined, modelAuth: tr,
      probeAppServer: async () => ({ ok: true, rtt_ms: 1, last_error: null }),
      authFileMtimeMs: () => mtime,
      onChange: (r) => changes.push(r),
    });
    await m.tick();
    tr.noteError("Your refresh token has expired");
    m.noteModelAuthMaybeChanged();
    expect(changes.at(-1).model_auth).toBe("expired");
    await m.tick();
    expect(tr.get()).toBe("expired");
    mtime = 2_000;
    await m.tick();
    expect(changes.at(-1).model_auth).toBe("unknown");
  });
});

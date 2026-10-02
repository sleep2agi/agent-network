import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appsrvSessionFor,
  buildRelaunchScript,
  captureAppServerLaunch,
  hungKillVeto,
  markerStillOurs,
  relaunchAppServer,
  relaunchBlocker,
  terminateHungAppServer,
  writeAppServerTokenFile,
  type ProcView,
  type RelaunchDeps,
} from "./codex-appserver-relaunch";

const URL_ = "ws://127.0.0.1:24555";
const MARKER = "11111111-2222-4333-8444-555555555555";
const ARGV = ["/opt/codex/bin/codex", "app-server", "-c", "approval_policy=never", "-c", "sandbox_mode=read-only", "-c", "model=gpt-x", "-c", 'mcp_servers.commhub.url="http://127.0.0.1:19999/mcp"', "--listen", URL_];

type Proc = { cmdline: string[]; cwd: string; env: Record<string, string>; alive: boolean };
function fakeProc(procs: Record<number, Proc>): ProcView {
  return {
    cmdline: (pid) => procs[pid] ? procs[pid].cmdline.join("\0") + "\0" : null,
    cwd: (pid) => procs[pid]?.cwd ?? null,
    environ: (pid) => procs[pid] ? Object.entries(procs[pid].env).map(([k, v]) => `${k}=${v}`).join("\0") + "\0" : null,
    alive: (pid) => !!procs[pid]?.alive,
  };
}
const pane = (session: string, pid: number, dead = false) => `${session}\t${pid}\t${dead ? 1 : 0}\tcodex\n`;

describe("launch snapshot (#461)", () => {
  test("session name follows the launcher's convention", () => {
    expect(appsrvSessionFor("示例节点")).toBe("示例节点-appsrv");
  });

  test("captures argv + cwd of the exact app-server pane", () => {
    const proc = fakeProc({ 100: { cmdline: ARGV, cwd: "/work/demo", env: { ANET_NODE_MARKER: MARKER }, alive: true } });
    const r = captureAppServerLaunch({ session: "demo-appsrv", url: URL_, marker: MARKER, panes: pane("demo-appsrv-x", 99) + pane("demo-appsrv", 100), proc });
    expect(r).toEqual({ ok: true, snapshot: { session: "demo-appsrv", url: URL_, argv: ARGV, cwd: "/work/demo", pid: 100 } });
  });

  test("refuses another node's marker, a different --listen, a prefix-matching session, a dead pane", () => {
    const other = fakeProc({ 100: { cmdline: ARGV, cwd: "/w", env: { ANET_NODE_MARKER: "other" }, alive: true } });
    expect(captureAppServerLaunch({ session: "demo-appsrv", url: URL_, marker: MARKER, panes: pane("demo-appsrv", 100), proc: other }).ok).toBe(false);
    const otherUrl = fakeProc({ 100: { cmdline: [...ARGV.slice(0, -1), "ws://127.0.0.1:1"], cwd: "/w", env: { ANET_NODE_MARKER: MARKER }, alive: true } });
    expect(captureAppServerLaunch({ session: "demo-appsrv", url: URL_, marker: MARKER, panes: pane("demo-appsrv", 100), proc: otherUrl }).ok).toBe(false);
    const ok = fakeProc({ 100: { cmdline: ARGV, cwd: "/w", env: { ANET_NODE_MARKER: MARKER }, alive: true } });
    expect(captureAppServerLaunch({ session: "demo", url: URL_, marker: MARKER, panes: pane("demo-appsrv", 100), proc: ok }).ok).toBe(false);
    expect(captureAppServerLaunch({ session: "demo-appsrv", url: URL_, marker: MARKER, panes: pane("demo-appsrv", 100, true), proc: ok }).ok).toBe(false);
    expect(captureAppServerLaunch({ session: "demo-appsrv", url: URL_, marker: MARKER, panes: null, proc: ok })).toEqual({ ok: false, reason: "tmux unavailable" });
  });

  test("relaunch script: same shape as the launcher, token only via the sourced-then-removed file", () => {
    const script = buildRelaunchScript({ session: "s", url: URL_, argv: ARGV, cwd: "/w", pid: 1 }, "/n/codex-home", "/n/codex-home/.anet-copresence.env");
    expect(script).toBe([
      "export CODEX_HOME='/n/codex-home'",
      ". '/n/codex-home/.anet-copresence.env'",
      "rm -f '/n/codex-home/.anet-copresence.env'",
      `exec ${ARGV.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ")}`,
    ].join(" ; "));
    expect(script).not.toContain("ntok_");
  });

  test("token file: 0600, replaces a planted symlink instead of following it", () => {
    const dir = mkdtempSync(join(tmpdir(), "t461-"));
    const target = join(dir, "victim");
    writeFileSync(target, "untouched\n");
    symlinkSync(target, join(dir, ".anet-copresence.env"));
    const p = writeAppServerTokenFile(dir, "ntok_abc'def");
    expect(readFileSync(target, "utf8")).toBe("untouched\n");
    expect(readFileSync(p, "utf8")).toBe("export ANET_CODEX_COMMHUB_TOKEN='ntok_abc'\\''def'\n");
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  test("marker file: ours / replaced / gone", () => {
    const dir = mkdtempSync(join(tmpdir(), "t461m-"));
    const f = join(dir, "copresence-identity.json");
    writeFileSync(f, JSON.stringify({ marker: MARKER }));
    expect(markerStillOurs(f, MARKER)).toBe(true);
    writeFileSync(f, JSON.stringify({ marker: "next-generation" }));
    expect(markerStillOurs(f, MARKER)).toBe(false);
    expect(markerStillOurs(join(dir, "missing.json"), MARKER)).toBe(false);
  });
});

describe("relaunch (#461)", () => {
  const snap = { session: "demo-appsrv", url: URL_, argv: ARGV, cwd: "/work/demo", pid: 100 };

  function deps(state: { procs: Record<number, Proc>; panes: string; bound?: boolean; homeOk?: boolean }) {
    const tmuxCalls: string[][] = [];
    const d: RelaunchDeps = {
      codexHome: "/n/codex-home",
      marker: MARKER,
      token: "ntok_node",
      panes: () => state.panes,
      proc: fakeProc(state.procs),
      tmux: (args) => {
        tmuxCalls.push(args);
        if (args[0] === "new-session") {
          state.procs[200] = { cmdline: ARGV, cwd: "/work/demo", env: { ANET_NODE_MARKER: MARKER, CODEX_HOME: "/n/codex-home" }, alive: true };
          state.panes = pane("demo-appsrv", 200);
        }
        if (args[0] === "kill-session") state.panes = "";
      },
      sessionId: (name) => (state.panes.includes(`${name}\t`) ? "$7" : null),
      waitPort: async () => state.bound ?? true,
      writeTokenFile: () => "/n/codex-home/.anet-copresence.env",
      verifyHome: () => (state.homeOk ?? true) ? { ok: true } : { ok: false, message: "pid 200 runs with CODEX_HOME=/other" },
    };
    return { d, tmuxCalls };
  }

  test("process gone → new tmux session with the same name, cwd, marker, CODEX_HOME and argv; new pid", async () => {
    const { d, tmuxCalls } = deps({ procs: {}, panes: "" });
    const next = await relaunchAppServer(snap, d);
    // #465: the relaunched snapshot records the new session id, so a later hung check compares against it.
    expect(next).toEqual({ ...snap, pid: 200, sessionId: "$7" });
    expect(tmuxCalls).toHaveLength(1);
    const [cmd] = tmuxCalls;
    expect(cmd.slice(0, 8)).toEqual(["new-session", "-d", "-s", "demo-appsrv", "-c", "/work/demo", "-e", `ANET_NODE_MARKER=${MARKER}`]);
    expect(cmd.slice(8, 10)).toEqual(["-e", "CODEX_HOME=/n/codex-home"]);
    expect(cmd.slice(10, 12)).toEqual(["bash", "-lc"]);
    expect(cmd[12]).toContain(`'--listen' '${URL_}'`);
    expect(cmd.join(" ")).not.toContain("ntok_");
  });

  test("a dead-pane remnant of the session is cleared first", async () => {
    const { d, tmuxCalls } = deps({ procs: {}, panes: pane("demo-appsrv", 100, true) });
    await relaunchAppServer(snap, d);
    expect(tmuxCalls.map((c) => c[0])).toEqual(["kill-session", "new-session"]);
    expect(tmuxCalls[0]).toEqual(["kill-session", "-t", "$7"]);
  });

  test("never replaces a live app-server (hung is not dead)", async () => {
    const { d, tmuxCalls } = deps({ procs: { 100: { cmdline: ARGV, cwd: "/w", env: { ANET_NODE_MARKER: MARKER }, alive: true } }, panes: pane("demo-appsrv", 100) });
    await expect(relaunchAppServer(snap, d)).rejects.toThrow(/still alive but not answering/);
    expect(tmuxCalls).toHaveLength(0);
  });

  test("pid reused by an unrelated process does not block (marker differs)", () => {
    const { d } = deps({ procs: { 100: { cmdline: ["sleep", "9"], cwd: "/", env: {}, alive: true } }, panes: "" });
    expect(relaunchBlocker(snap, d)).toBeNull();
  });

  test("no snapshot / not an ntok → blocked with a reason", () => {
    const { d } = deps({ procs: {}, panes: "" });
    expect(relaunchBlocker(null, d)).toMatch(/no launch snapshot/);
    expect(relaunchBlocker(snap, { ...d, token: "utok_user" })).toMatch(/not an ntok_/);
  });

  test("did not bind → fails (counts as a failed restart)", async () => {
    const { d } = deps({ procs: {}, panes: "", bound: false });
    await expect(relaunchAppServer(snap, { ...d, bindTimeoutMs: 10 })).rejects.toThrow(/did not bind/);
  });

  test("wrong CODEX_HOME on the relaunched process → killed, fails closed", async () => {
    const { d, tmuxCalls } = deps({ procs: {}, panes: "", homeOk: false });
    await expect(relaunchAppServer(snap, d)).rejects.toThrow(/refusing the relaunched app-server: pid 200 runs with CODEX_HOME=\/other/);
    expect(tmuxCalls.at(-1)).toEqual(["kill-session", "-t", "$7"]);
  });

  test("tmux new-session failure removes the token file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "t461t-"));
    const { d } = deps({ procs: {}, panes: "" });
    const p = join(dir, ".anet-copresence.env");
    await expect(relaunchAppServer(snap, {
      ...d,
      writeTokenFile: () => { writeFileSync(p, "x", { mode: 0o600 }); return p; },
      tmux: () => { throw new Error("no server"); },
    })).rejects.toThrow(/tmux new-session demo-appsrv failed/);
    expect(existsSync(p)).toBe(false);
  });
});

describe("hung app-server: strict identity check + terminate (#465)", () => {
  const HOME = "/n/codex-home";
  const ours = (): Proc => ({ cmdline: ARGV, cwd: "/work/demo", env: { ANET_NODE_MARKER: MARKER, CODEX_HOME: HOME }, alive: true });
  const snap = { session: "demo-appsrv", url: URL_, argv: ARGV, cwd: "/work/demo", pid: 100, sessionId: "$3" };
  const base = (procs: Record<number, Proc>, over: Partial<Parameters<typeof hungKillVeto>[1]> = {}) => ({
    marker: MARKER, codexHome: HOME, panes: () => pane("demo-appsrv", 100), proc: fakeProc(procs), sessionId: () => "$3", ...over,
  });

  test("all four checks pass → may kill", () => {
    expect(hungKillVeto(snap, base({ 100: ours() }))).toBeNull();
    expect(hungKillVeto(snap, base({ 100: { ...ours(), env: { ANET_NODE_MARKER: MARKER, CODEX_HOME: `${HOME}/` } } }))).toBeNull();
  });

  test("each identity mismatch vetoes the kill", () => {
    const veto = (procs: Record<number, Proc>, over = {}, s: any = snap) => hungKillVeto(s, base(procs, over));
    // 1. tmux session replaced (same name, new id) / gone
    expect(veto({ 100: ours() }, { sessionId: () => "$9" })).toContain("is not the one this node started");
    expect(veto({ 100: ours() }, { sessionId: () => null })).toContain("is not the one this node started");
    // pid is no longer that session's live pane
    expect(veto({ 100: ours() }, { panes: () => pane("demo-appsrv", 101) })).toContain("no longer the live pane");
    expect(veto({ 100: ours() }, { panes: () => pane("demo-appsrv", 100, true) })).toContain("no longer the live pane");
    // 2. argv: not app-server / another --listen
    expect(veto({ 100: { ...ours(), cmdline: ["/bin/sleep", "100"] } })).toContain("is not `app-server --listen");
    expect(veto({ 100: { ...ours(), cmdline: [...ARGV.slice(0, -1), "ws://127.0.0.1:1"] } })).toContain("is not `app-server --listen");
    // 3. foreign / missing node marker
    expect(veto({ 100: { ...ours(), env: { ANET_NODE_MARKER: "other", CODEX_HOME: HOME } } })).toContain("another identity marker");
    expect(veto({ 100: { ...ours(), env: { CODEX_HOME: HOME } } })).toContain("another identity marker");
    // 4. another CODEX_HOME / none
    expect(veto({ 100: { ...ours(), env: { ANET_NODE_MARKER: MARKER, CODEX_HOME: "/other/codex-home" } } })).toContain("another CODEX_HOME");
    expect(veto({ 100: { ...ours(), env: { ANET_NODE_MARKER: MARKER } } })).toContain("another CODEX_HOME");
    // and the preconditions
    expect(veto({ 100: ours() }, { marker: undefined })).toContain("no identity marker");
    expect(veto({ 100: ours() }, {}, { ...snap, sessionId: undefined })).toContain("no tmux session id");
    expect(veto({ 100: ours() }, {}, null)).toBe("no launch snapshot");
    expect(veto({ 100: ours() }, { panes: () => null })).toBe("tmux unavailable");
  });

  test("snapshot records the tmux session id when given", () => {
    const r = captureAppServerLaunch({ session: "demo-appsrv", url: URL_, marker: MARKER, panes: pane("demo-appsrv", 100), proc: fakeProc({ 100: ours() }), sessionId: "$3" });
    expect(r.ok && r.snapshot.sessionId).toBe("$3");
  });

  function killWorld(opts: { ignoresTerm?: boolean; dieAfterKill?: boolean; groupLeader?: boolean; swapMarkerDuringGrace?: boolean } = {}) {
    const procs: Record<number, Proc> = { 100: ours() };
    let panes = pane("demo-appsrv", 100);
    const signals: Array<[number, string | number]> = [];
    let clock = 0;
    const deps = {
      marker: MARKER, codexHome: HOME, panes: () => panes, proc: fakeProc(procs), sessionId: () => "$3",
      pgid: () => (opts.groupLeader === false ? 1 : 100),
      signal: (target: number, sig: NodeJS.Signals | 0) => {
        if (sig === 0) { if (!procs[100]?.alive) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" }); return; }
        signals.push([target, sig]);
        if (sig === "SIGTERM" && !opts.ignoresTerm) { procs[100].alive = false; panes = ""; }
        if (sig === "SIGKILL" && opts.dieAfterKill !== false) { procs[100].alive = false; panes = ""; }
      },
      sleep: async (ms: number) => {
        clock += ms;
        if (opts.swapMarkerDuringGrace && clock >= 400) procs[100].env = { ANET_NODE_MARKER: "other", CODEX_HOME: HOME };
      },
      graceMs: 2_000,
    };
    return { deps, signals, clock: () => clock };
  }

  test("SIGTERM to the process group; exits within the grace → no SIGKILL", async () => {
    const w = killWorld();
    expect(await terminateHungAppServer(snap, w.deps)).toBe("SIGTERM");
    expect(w.signals).toEqual([[-100, "SIGTERM"]]);
  });

  test("ignores SIGTERM → SIGKILL after the grace (process group)", async () => {
    const w = killWorld({ ignoresTerm: true });
    expect(await terminateHungAppServer(snap, w.deps)).toBe("SIGKILL");
    expect(w.signals).toEqual([[-100, "SIGTERM"], [-100, "SIGKILL"]]);
    expect(w.clock()).toBeGreaterThanOrEqual(2_000);
  });

  test("not a group leader → signals only the pid", async () => {
    const w = killWorld({ groupLeader: false });
    await terminateHungAppServer(snap, w.deps);
    expect(w.signals).toEqual([[100, "SIGTERM"]]);
  });

  test("identity changes during the grace → no SIGKILL, fails", async () => {
    const w = killWorld({ ignoresTerm: true, swapMarkerDuringGrace: true });
    await expect(terminateHungAppServer(snap, w.deps)).rejects.toThrow("changed identity during the grace period");
    expect(w.signals).toEqual([[-100, "SIGTERM"]]);
  });

  test("survives SIGKILL → fails (counts as a failed restart)", async () => {
    const w = killWorld({ ignoresTerm: true, dieAfterKill: false });
    await expect(terminateHungAppServer(snap, w.deps)).rejects.toThrow("survived SIGKILL");
  });

  test("a foreign process is never signalled", async () => {
    const w = killWorld();
    w.deps.proc = fakeProc({ 100: { ...ours(), env: { ANET_NODE_MARKER: "other", CODEX_HOME: HOME } } });
    await expect(terminateHungAppServer(snap, w.deps)).rejects.toThrow("not killing the hung app-server: pid 100 carries another identity marker");
    expect(w.signals).toEqual([]);
  });
});

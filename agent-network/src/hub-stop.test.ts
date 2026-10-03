// #515(#502 anet CLI 审计)—— `anet hub stop` 找 hub 进程不依赖 lsof,只杀核实过的 commhub-server。
//
// 上半部分全部是注入探针:不读真实 /proc、不发任何信号(kill 是记录器)。
// 最后一组 describe 会起一个**假的 commhub-server 进程**并用真 CLI 去停它 ——
// 只在 Docker 里跑(/.dockerenv),宿主机上跳过。🔴 宿主机上有生产 hub,绝不在这里停任何东西。
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type HubPidRecord, type HubStopProbes, type ProbeName, type SocketProbeResult,
  isCommhubServerCmdline, parseNetstatDarwin, parseNetstatWindows, parseProcNetTcp, parseSsOutput,
  probeOrder, procNetListeners, resolveHubListener, stopHub,
} from "./hub-stop";

const PROD_CMDLINE = "/home/u/.nvm/versions/node/v24.19.0/bin/bun /home/u/.commhub/runtime-v86-preview97/node_modules/@sleep2agi/commhub-server/bin/commhub.ts";
const BUNX_CMDLINE = "bunx --bun @sleep2agi/commhub-server@0.9.0-preview.47";
const BUNX_CHILD = "bun /tmp/bunx-1000-@sleep2agi/commhub-server@0.9.0-preview.47/node_modules/.bin/commhub-server";
const PY = "python3 -m http.server 9200";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

describe("isCommhubServerCmdline", () => {
  const yes = [PROD_CMDLINE, BUNX_CMDLINE, BUNX_CHILD, "bun /repo/server/bin/commhub.ts", "C:\\Users\\u\\.bun\\bin\\bun.exe C:\\x\\node_modules\\@sleep2agi\\commhub-server\\bin\\commhub.ts"];
  const no = [PY, "node /srv/app.js", "vim commhub-server.md", "bun run src/index.ts", "", "nginx: master process"];
  for (const c of yes) test(`yes: ${c.slice(0, 60)}`, () => expect(isCommhubServerCmdline(c)).toBe(true));
  for (const c of no) test(`no: ${JSON.stringify(c).slice(0, 60)}`, () => expect(isCommhubServerCmdline(c)).toBe(false));
  test("null → false", () => expect(isCommhubServerCmdline(null)).toBe(false));
});

describe("parsers", () => {
  test("/proc/net/tcp: only LISTEN (0A) rows on the port", () => {
    const text = [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 0100007F:23F0 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 111 1 0 100 0 0 10 0",
      "   1: 0100007F:23F0 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 222 1 0 20 4 30 10 -1",
      "   2: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 333 1 0 100 0 0 10 0",
    ].join("\n");
    expect(parseProcNetTcp(text, 9200)).toEqual(["111"]);
    expect(parseProcNetTcp(text, 8080)).toEqual(["333"]);
    expect(parseProcNetTcp(text, 1234)).toEqual([]);
  });
  test("/proc/net/tcp6", () => {
    const t = "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n" +
      "   0: 00000000000000000000000000000000:23F0 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 444 1 0 100 0 0 10 0";
    expect(parseProcNetTcp(t, 9200)).toEqual(["444"]);
  });
  test("ss -Hltnp: pid from users:(…); a row with no users = unresolved", () => {
    expect(parseSsOutput(`LISTEN 0      512          0.0.0.0:9200       0.0.0.0:*    users:(("bun",pid=2664599,fd=11))`, 9200))
      .toEqual({ pids: [2664599], unresolved: 0 });
    expect(parseSsOutput(`LISTEN 0 512 0.0.0.0:9200 0.0.0.0:*`, 9200)).toEqual({ pids: [], unresolved: 1 });
    expect(parseSsOutput(`LISTEN 0 512 0.0.0.0:19200 0.0.0.0:* users:(("x",pid=5,fd=1))`, 9200)).toEqual({ pids: [], unresolved: 0 });
  });
  test("windows netstat -ano", () => {
    const t = "\r\nActive Connections\r\n\r\n  Proto  Local Address          Foreign Address        State           PID\r\n" +
      "  TCP    127.0.0.1:9200         0.0.0.0:0              LISTENING       4321\r\n" +
      "  TCP    127.0.0.1:9200         127.0.0.1:50000        ESTABLISHED     4321\r\n" +
      "  TCP    0.0.0.0:19200          0.0.0.0:0              LISTENING       77\r\n";
    expect(parseNetstatWindows(t, 9200)).toEqual({ pids: [4321] });
  });
  test("macOS netstat -anv: pid column located from the header", () => {
    const t = "Active Internet connections (including servers)\n" +
      "Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)      rhiwat  shiwat    pid   epid state  options\n" +
      "tcp4       0      0  127.0.0.1.9200         *.*                    LISTEN       131072  131072   5150      0 0x0100 0x00000006\n" +
      "tcp4       0      0  127.0.0.1.19200        *.*                    LISTEN       131072  131072   6000      0 0x0100 0x00000006\n";
    expect(parseNetstatDarwin(t, 9200)).toEqual({ pids: [5150], unresolved: 0 });
  });
  test("procNetListeners walks a fake /proc: inode → owning pid", () => {
    const root = mkdtempSync(join(tmpdir(), "anet-515-proc-"));
    temps.push(root);
    mkdirSync(join(root, "net"));
    writeFileSync(join(root, "net", "tcp"),
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n" +
      "   0: 0100007F:23F0 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 999 1 0 100 0 0 10 0\n");
    mkdirSync(join(root, "4242", "fd"), { recursive: true });
    symlinkSync("socket:[999]", join(root, "4242", "fd", "11"));
    symlinkSync("/dev/null", join(root, "4242", "fd", "0"));
    mkdirSync(join(root, "77", "fd"), { recursive: true });
    symlinkSync("socket:[123]", join(root, "77", "fd", "3"));
    expect(procNetListeners(9200, root)).toEqual({ pids: [4242], unresolved: 0 });
    expect(procNetListeners(9300, root)).toEqual({ pids: [] });
    expect(procNetListeners(9200, join(root, "missing"))).toBeNull();
  });
});

// ── injected-probe world ──

type World = {
  platform?: NodeJS.Platform;
  socket?: Partial<Record<ProbeName, SocketProbeResult | null>>;
  pidfile?: HubPidRecord | null;
  procs: Record<number, string | null>; // pid → cmdline (null = unreadable)
  healthUp?: boolean;
  /** pids that ignore SIGTERM */
  stubborn?: number[];
  /** pids that ignore SIGKILL too */
  immortal?: number[];
};

function harness(w: World) {
  const live = new Map<number, string | null>(Object.entries(w.procs).map(([k, v]) => [Number(k), v]));
  const signals: string[] = [];
  const probes: HubStopProbes = {
    platform: w.platform ?? "linux",
    socket: Object.fromEntries(Object.entries(w.socket ?? {}).map(([k, v]) => [k, () => v ?? null])) as HubStopProbes["socket"],
    readPidFile: () => w.pidfile ?? null,
    cmdline: (pid) => (live.has(pid) ? live.get(pid)! : null),
    alive: (pid) => live.has(pid),
  };
  const lines: string[] = [];
  let health = w.healthUp ?? false;
  const deps = {
    probes,
    kill: (pid: number, sig: "SIGTERM" | "SIGKILL") => {
      signals.push(`${sig} ${pid}`);
      if (!live.has(pid)) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      if (w.immortal?.includes(pid)) return;
      if (sig === "SIGTERM" && w.stubborn?.includes(pid)) return;
      live.delete(pid);
      if (![...live.values()].some(c => isCommhubServerCmdline(c))) health = false;
    },
    sleep: async () => {},
    healthy: async () => health,
    log: (l: string) => lines.push(l),
    error: (l: string) => lines.push(l),
  };
  return { deps, signals, lines, live };
}

const NONE = { proc: null, ss: null, lsof: null, netstat: null } as const;

describe("resolveHubListener / stopHub with injected probes", () => {
  test("probe order per platform — lsof is never first on Linux and absent on Windows", () => {
    expect(probeOrder("linux")).toEqual(["proc", "ss", "lsof", "netstat"]);
    expect(probeOrder("darwin")).toEqual(["lsof", "netstat"]);
    expect(probeOrder("win32")).toEqual(["netstat"]);
  });

  test("no lsof: /proc finds the commhub listener → SIGTERM it, exit 0", async () => {
    const h = harness({ socket: { proc: { pids: [500] }, lsof: null }, procs: { 500: PROD_CMDLINE }, healthUp: true });
    const r = await stopHub(9200, h.deps);
    expect(r).toMatchObject({ code: 0, killed: [500] });
    expect(h.signals).toEqual(["SIGTERM 500"]);
    expect(h.lines.join("\n")).toContain("proc=pid 500");
  });

  test("proc unavailable → falls to ss (still no lsof needed)", async () => {
    const h = harness({ socket: { proc: null, ss: { pids: [600] }, lsof: null }, procs: { 600: BUNX_CHILD }, healthUp: true });
    const r = await stopHub(9200, h.deps);
    expect(r.code).toBe(0);
    expect(h.signals).toEqual(["SIGTERM 600"]);
    expect(resolveHubListener(9200, h.deps.probes).tried[0]).toEqual({ probe: "proc", outcome: "unavailable" });
  });

  test("windows: netstat -ano is the authority", async () => {
    const h = harness({ platform: "win32", socket: { netstat: { pids: [4321] } }, procs: { 4321: "C:\\bun.exe C:\\x\\node_modules\\@sleep2agi\\commhub-server\\bin\\commhub.ts" }, healthUp: true });
    expect((await stopHub(9200, h.deps)).code).toBe(0);
    expect(h.signals).toEqual(["SIGTERM 4321"]);
  });

  test("no socket probe at all + valid pid file → pid file is the source; killed; exit 0", async () => {
    const h = harness({ socket: NONE, pidfile: { pid: 700, port: 9200 }, procs: { 700: PROD_CMDLINE }, healthUp: true });
    const r = await stopHub(9200, h.deps);
    expect(r).toMatchObject({ code: 0, killed: [700] });
  });

  test("no socket probe + no pid file + hub answers /health → refuse to guess, exit 1, nothing killed", async () => {
    const h = harness({ socket: NONE, procs: { 800: PROD_CMDLINE }, healthUp: true });
    const r = await stopHub(9200, h.deps);
    expect(r.code).toBe(1);
    expect(h.signals).toEqual([]);
    expect(h.lines.join("\n")).toMatch(/could not find its PID/);
  });

  test("no socket probe + no pid file + nothing answering → nothing to stop, exit 0", async () => {
    const h = harness({ socket: NONE, procs: {}, healthUp: false });
    expect((await stopHub(9200, h.deps)).code).toBe(0);
    expect(h.lines.join("\n")).toContain("No hub server listening on port 9200");
  });

  test("stale pid file (pid dead) is ignored; the real listener is stopped", async () => {
    const h = harness({ socket: { proc: { pids: [901] } }, pidfile: { pid: 900, port: 9200 }, procs: { 901: PROD_CMDLINE }, healthUp: true });
    const r = await stopHub(9200, h.deps);
    expect(r).toMatchObject({ code: 0, killed: [901] });
    expect(h.signals).toEqual(["SIGTERM 901"]);
    expect(h.lines.join("\n")).toContain("pidfile=stale (pid 900 not running)");
  });

  test("stale pid file whose pid was REUSED by another program → never signalled", async () => {
    const h = harness({ socket: NONE, pidfile: { pid: 950, port: 9200 }, procs: { 950: "/usr/bin/sshd -D" }, healthUp: true });
    const r = await stopHub(9200, h.deps);
    expect(r.code).toBe(1);
    expect(h.signals).toEqual([]);
    expect(h.lines.join("\n")).toContain("is not a commhub-server now");
  });

  test("pid file names a commhub-server that the socket probe does not show on this port → not used", async () => {
    const h = harness({ socket: { proc: { pids: [] } }, pidfile: { pid: 960, port: 9200 }, procs: { 960: PROD_CMDLINE }, healthUp: false });
    const r = await stopHub(9200, h.deps);
    expect(r.code).toBe(0);
    expect(h.signals).toEqual([]);
  });

  test("port owned by a NON-hub process → refuse, exit 1, not signalled", async () => {
    const h = harness({ socket: { proc: { pids: [1000] } }, procs: { 1000: PY }, healthUp: false });
    const r = await stopHub(9200, h.deps);
    expect(r.code).toBe(1);
    expect(r.refused.map(c => c.pid)).toEqual([1000]);
    expect(h.signals).toEqual([]);
    expect(h.lines.join("\n")).toContain("refusing to kill pid 1000");
  });

  test("listener whose cmdline cannot be read → refuse (fail closed)", async () => {
    const h = harness({ socket: { ss: { pids: [1100] }, proc: null }, procs: { 1100: null }, healthUp: true });
    const r = await stopHub(9200, h.deps);
    expect(r.code).toBe(1);
    expect(h.signals).toEqual([]);
  });

  test("listener owned by another user (owner unreadable) → refuse, exit 1", async () => {
    const h = harness({ socket: { proc: { pids: [], unresolved: 1 } }, procs: {}, healthUp: true });
    expect((await stopHub(9200, h.deps)).code).toBe(1);
    expect(h.signals).toEqual([]);
  });

  test("hub + a foreign listener on the same port → touch nothing", async () => {
    const h = harness({ socket: { proc: { pids: [1200, 1201] } }, procs: { 1200: PROD_CMDLINE, 1201: PY }, healthUp: true });
    expect((await stopHub(9200, h.deps)).code).toBe(1);
    expect(h.signals).toEqual([]);
  });

  test("survives SIGTERM → SIGKILL after the grace period", async () => {
    const h = harness({ socket: { proc: { pids: [1300] } }, procs: { 1300: PROD_CMDLINE }, healthUp: true, stubborn: [1300] });
    const r = await stopHub(9200, { ...h.deps, graceMs: 500 });
    expect(r.code).toBe(0);
    expect(h.signals).toEqual(["SIGTERM 1300", "SIGKILL 1300"]);
  });

  test("survives SIGKILL too → exit 1 (was exit 0 before #515)", async () => {
    const h = harness({ socket: { proc: { pids: [1400] } }, procs: { 1400: PROD_CMDLINE }, healthUp: true, immortal: [1400] });
    const r = await stopHub(9200, { ...h.deps, graceMs: 500 });
    expect(r.code).toBe(1);
    expect(h.lines.join("\n")).toContain("still running");
  });
});

// ── Docker only: a real (fake) commhub-server process, stopped by the real CLI ──

const IN_DOCKER = existsSync("/.dockerenv");
const CLI = new URL("../bin/cli.ts", import.meta.url).pathname;

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
  const p = s.port; s.stop(true); return p;
}

function cliEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(ANET_|COMMHUB_)/.test(k)) env[k] = v;
  env.HOME = home; env.USERPROFILE = home; env.NO_COLOR = "1";
  // 🔴 no lsof / ss / netstat on PATH: only /proc (and the pid file) can find the hub.
  env.PATH = "/usr/local/bin:/usr/bin:/bin";
  return env;
}

async function startFake(dir: string, port: number, kind: "hub" | "other") {
  const script = kind === "hub" ? join(dir, "commhub-server", "bin", "commhub.ts") : join(dir, "other", "server.ts");
  mkdirSync(join(script, ".."), { recursive: true });
  writeFileSync(script, `Bun.serve({ port: ${port}, hostname: "127.0.0.1", fetch: () => Response.json({ ok: true, version: "fake" }) }); setInterval(() => {}, 1 << 30);\n`);
  const p = Bun.spawn(["bun", script], { stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return p; } catch {}
    await Bun.sleep(100);
  }
  p.kill("SIGKILL");
  throw new Error("fake server did not come up");
}

describe.skipIf(!IN_DOCKER)("Docker: real `anet hub stop` against a real process (no lsof on PATH)", () => {
  test("lsof/ss/netstat absent in this image", () => {
    for (const bin of ["lsof", "ss", "netstat"]) expect(Bun.which(bin, { PATH: "/usr/local/bin:/usr/bin:/bin" })).toBeNull();
  });

  test("commhub-server listener found via /proc, stopped, exit 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "anet-515-hub-")); temps.push(dir);
    const port = await freePort();
    const hub = await startFake(dir, port, "hub");
    const r = Bun.spawn(["bun", CLI, "hub", "stop", "--port", String(port)], { env: cliEnv(dir), cwd: dir, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(r.stdout).text(), new Response(r.stderr).text(), r.exited]);
    const exited = await Promise.race([hub.exited.then(() => true), Bun.sleep(3000).then(() => false)]);
    if (!exited) hub.kill("SIGKILL");
    expect({ code, exited, proc: /proc=pid \d+/.test(out), stopped: out.includes("Stopped commhub-server") }).toEqual({ code: 0, exited: true, proc: true, stopped: true });
    expect(err).toBe("");
  }, 30_000);

  test("port held by a non-hub process → refused, exit 1, process still alive", async () => {
    const dir = mkdtempSync(join(tmpdir(), "anet-515-other-")); temps.push(dir);
    const port = await freePort();
    const other = await startFake(dir, port, "other");
    try {
      const r = Bun.spawn(["bun", CLI, "hub", "stop", "--port", String(port)], { env: cliEnv(dir), cwd: dir, stdout: "pipe", stderr: "pipe" });
      const [, err, code] = await Promise.all([new Response(r.stdout).text(), new Response(r.stderr).text(), r.exited]);
      expect(code).toBe(1);
      expect(err).toContain(`refusing to kill pid ${other.pid}`);
      expect((await fetch(`http://127.0.0.1:${port}/health`)).ok).toBe(true);
    } finally { other.kill("SIGKILL"); }
  }, 30_000);

  test("nothing on the port → exit 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "anet-515-none-")); temps.push(dir);
    const port = await freePort();
    const r = Bun.spawn(["bun", CLI, "hub", "stop", "--port", String(port)], { env: cliEnv(dir), cwd: dir, stdout: "pipe", stderr: "pipe" });
    const [out, , code] = await Promise.all([new Response(r.stdout).text(), new Response(r.stderr).text(), r.exited]);
    expect(code).toBe(0);
    expect(out).toContain(`No hub server listening on port ${port}`);
  }, 30_000);
});

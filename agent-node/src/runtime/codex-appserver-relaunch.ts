// #461 —— 共存节点的 app-server 重新拉起(Linux + tmux)。看门狗的判据在 codex-appserver-watchdog.ts。
//
// 共存拓扑里 app-server 不是桥(agent-node)的子进程:是 `anet node start` 起在 tmux 会话 `<名>-appsrv` 里的
// (agent-network/bin/cli.ts startCopresenceOrchestration)。桥要能重启它,就得知道「原样」怎么起 ——
// 所以趁它活着的时候拍一张启动快照:那个 pane 的进程的 argv(/proc/<pid>/cmdline)和工作目录
// (/proc/<pid>/cwd)。重启 = 同一个 tmux 会话名、同一个 argv(于是同一个 --listen 地址、同一份 -c 配置)、
// 同一个 ANET_NODE_MARKER(`anet node stop` 按它回收)、本节点自己的 CODEX_HOME,桥再按原 thread 接上去。
//
// 快照只认「确实是本节点的那个 app-server」:会话名逐字相等、argv 里有 `app-server` 且 `--listen` 正好是
// 本节点的地址、环境里的 ANET_NODE_MARKER 是本节点的。任一条不符就不拍(也就不会去重启一个不认识的东西)。
//
// 🔴 令牌:launcher 把 CommHub 令牌写进 CODEX_HOME 里一个 0600 文件、子 shell source 完就删,从不进
//    argv / tmux 命令行。这里照做(同一个文件名、同样先 unlink 再 wx 创建),令牌用本节点自己的 ntok。
// 🔴 起来以后核对新进程树的 CODEX_HOME(/proc environ),不符就杀掉、本次重启算失败 —— 和 .94 的
//    launcher / owned app-server 同一道检查(codex-home-enforce.ts)。

import { execTmux } from "../tmux";
import { chmodSync, existsSync, readFileSync, readlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { envVarFromEnviron, hasLoneSurrogate, readProcNulBlock, verifyProcessTreeCodexHome, type ProcReader } from "../codex-home-enforce";
import { parseTmuxPanes, TMUX_PANE_LIST_ARGS } from "./codex-health";
import { parseTmuxRows, tmuxListArgs } from "../tmux-format";

export interface AppServerLaunchSnapshot {
  session: string;
  url: string;
  argv: string[];
  cwd: string;
  pid: number;
  /** #465 —— 拍快照时这个会话名对应的 tmux 会话 id($N)。杀卡死进程前要求它没变(会话没被换掉)。 */
  sessionId?: string;
}

export interface ProcView {
  cmdline(pid: number): string | null;
  cwd(pid: number): string | null;
  environ(pid: number): string | null;
  alive(pid: number): boolean;
}

export const linuxProcView: ProcView = {
  // #448 回归:按字节读、逐条 UTF-8 解码(不是 latin1)—— 否则非 ASCII 的 CODEX_HOME / argv 路径永远对不上,
  // 重放的 argv 也会变成乱码。
  cmdline: (pid) => readProcNulBlock(pid, "cmdline"),
  cwd: (pid) => { try { return readlinkSync(`/proc/${pid}/cwd`); } catch { return null; } },
  environ: (pid) => readProcNulBlock(pid, "environ"),
  alive: (pid) => { try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; } },
};

/** tmux 会话名约定(agent-network/bin/cli.ts copresenceTmuxSessions):TUI 会话名 + "-appsrv"。 */
export function appsrvSessionFor(tuiSession: string): string {
  return `${tuiSession}-appsrv`;
}

export function listTmuxPanes(): string | null {
  try {
    return execTmux(TMUX_PANE_LIST_ARGS, {
      encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000,
    });
  } catch { return null; }
}

export function tmuxSessionId(name: string): string | null {
  let out: string;
  try {
    out = execTmux(TMUX_SESSION_ID_LIST_ARGS, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 });
  } catch { return null; }
  return sessionIdFor(out, name);
}

/** argv for `execTmux`: `-u list-sessions -F '#{session_id}|ANETSEP|#{session_name}'` (#556). */
export const TMUX_SESSION_ID_LIST_ARGS: readonly string[] = tmuxListArgs(["list-sessions"], ["#{session_id}", "#{session_name}"]);

/** TMUX_SESSION_ID_LIST_ARGS 的输出里,名字逐字等于 `name` 的那个会话的 id(旧 TAB 行仍认)。 */
export function sessionIdFor(out: string, name: string): string | null {
  for (const [id, session] of parseTmuxRows(out, 2)) {
    if (id && session === name) return id;
  }
  return null;
}

/** 从 /proc 拍启动快照;不是本节点的那个 app-server 就返回原因。 */
export function captureAppServerLaunch(input: {
  session: string;
  url: string;
  marker: string | undefined;
  panes: string | null;
  proc: ProcView;
  /** 当前这个会话名的 tmux 会话 id;给了就记进快照(#465)。 */
  sessionId?: string | null;
}): { ok: true; snapshot: AppServerLaunchSnapshot } | { ok: false; reason: string } {
  if (input.panes === null) return { ok: false, reason: "tmux unavailable" };
  const rows = parseTmuxPanes(input.panes).filter((r) => r.session === input.session && !r.dead);
  if (rows.length === 0) return { ok: false, reason: `tmux session ${input.session} has no live pane` };
  for (const row of rows) {
    const raw = input.proc.cmdline(row.pid);
    if (!raw) continue;
    const argv = raw.split("\0").filter((a, i, all) => a !== "" || i < all.length - 1);
    const at = argv.indexOf("--listen");
    if (!argv.includes("app-server") || at < 0 || argv[at + 1] !== input.url) continue;
    // 某个参数不是合法 UTF-8:重放时无法逐字节还原,宁可不拍快照(不重启)也不拿乱码去 exec。
    if (argv.some(hasLoneSurrogate)) return { ok: false, reason: `pid ${row.pid} argv is not valid UTF-8; cannot replay it` };
    const marker = envVarFromEnviron(input.proc.environ(row.pid), "ANET_NODE_MARKER");
    if (input.marker && marker !== input.marker) {
      return { ok: false, reason: `pane pid ${row.pid} carries another identity marker` };
    }
    const cwd = input.proc.cwd(row.pid);
    if (!cwd) return { ok: false, reason: `cannot read cwd of pid ${row.pid}` };
    return { ok: true, snapshot: { session: input.session, url: input.url, argv, cwd, pid: row.pid, ...(input.sessionId ? { sessionId: input.sessionId } : {}) } };
  }
  return { ok: false, reason: `no pane in ${input.session} runs \`app-server --listen ${input.url}\`` };
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** tmux 里 `bash -lc` 跑的那一行:和 launcher 同形(export CODEX_HOME → source 令牌文件 → 删掉 → exec)。 */
export function buildRelaunchScript(snapshot: AppServerLaunchSnapshot, codexHome: string, envFile: string): string {
  return [
    `export CODEX_HOME=${shellQuote(codexHome)}`,
    `. ${shellQuote(envFile)}`,
    `rm -f ${shellQuote(envFile)}`,
    `exec ${snapshot.argv.map(shellQuote).join(" ")}`,
  ].join(" ; ");
}

/** 和 launcher 的 writeCodexCopresenceEnvFile 同一套:先 unlink(防符号链接),再 0600 + wx 创建。 */
export function writeAppServerTokenFile(codexHome: string, token: string): string {
  const envPath = join(codexHome, ".anet-copresence.env");
  try { unlinkSync(envPath); } catch (err: any) { if (err?.code !== "ENOENT") throw err; }
  writeFileSync(envPath, `export ANET_CODEX_COMMHUB_TOKEN=${shellQuote(token)}\n`, { mode: 0o600, flag: "wx" });
  try { chmodSync(envPath, 0o600); } catch { /* best-effort */ }
  return envPath;
}

export async function waitForPort(url: string, timeoutMs: number): Promise<boolean> {
  const u = new URL(url);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = createConnection({ host: u.hostname.replace(/^\[|\]$/g, ""), port: Number(u.port) });
      s.once("connect", () => { s.destroy(); resolve(true); });
      s.once("error", () => resolve(false));
      setTimeout(() => { s.destroy(); resolve(false); }, 1_000).unref?.();
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

export interface RelaunchDeps {
  codexHome: string;
  marker: string | undefined;
  token: string;
  panes: () => string | null;
  proc: ProcView;
  tmux: (args: string[]) => void;
  /**
   * 会话名 → tmux 会话 id($N),逐字比较。🔴 不能用 `-t =名`:tmux 3.4 对 CJK 名精确匹配返回空
   * (节点别名常常是中文),而 `-t 名` 是前缀匹配。
   */
  sessionId: (name: string) => string | null;
  waitPort: (url: string, timeoutMs: number) => Promise<boolean>;
  writeTokenFile: (codexHome: string, token: string) => string;
  verifyHome: (pid: number, expected: string) => { ok: true; skipped?: string } | { ok: false; message: string };
  bindTimeoutMs?: number;
  log?: (m: string) => void;
}

/**
 * 能不能动手:快照在、令牌是 ntok、原来那个进程确实没了(pid 不在,或已被别的进程复用 —— 标记对不上)、
 * 会话里没有活 pane。返回 null = 可以。
 */
export function relaunchBlocker(snapshot: AppServerLaunchSnapshot | null, deps: Pick<RelaunchDeps, "marker" | "token" | "panes" | "proc">): string | null {
  if (!snapshot) return "no launch snapshot (this bridge never saw the app-server alive)";
  if (!deps.token.startsWith("ntok_")) return "node token is not an ntok_; cannot hand the app-server its CommHub MCP token";
  if (snapshotProcessStillAlive(snapshot, deps)) return `app-server process ${snapshot.pid} is still alive but not answering; not killing a live process`;
  const panes = deps.panes();
  if (panes !== null && parseTmuxPanes(panes).some((r) => r.session === snapshot.session && !r.dead)) {
    return `tmux session ${snapshot.session} still has a live pane; not replacing it`;
  }
  return null;
}

/** 快照里的那个进程还活着(pid 在,且没有被换成带别的标记的进程)。#465 用它区分「死了」和「卡死」。 */
export function snapshotProcessStillAlive(snapshot: AppServerLaunchSnapshot, deps: Pick<RelaunchDeps, "marker" | "proc">): boolean {
  if (!deps.proc.alive(snapshot.pid)) return false;
  const marker = envVarFromEnviron(deps.proc.environ(snapshot.pid), "ANET_NODE_MARKER");
  return !deps.marker || marker === deps.marker;
}

// ── #465 —— 卡死的 app-server:进程在、端口在,但 ws 握手一直失败(1006 / 超时) ──────────────────────
//
// .95 只在「进程确实没了」时重启;卡死的只报降级。这里补上:连续 M 次探针失败(看门狗判)之后,先用
// 和快照同一套、但更严的身份核对确认它**就是本节点当初起的那个**,才 SIGTERM → 等宽限 → 还活着就
// SIGKILL,再走 .95 的原路重新拉起。任何一条对不上 → 只报降级,绝不动手。

export interface HungKillDeps {
  marker: string | undefined;
  codexHome: string;
  panes: () => string | null;
  proc: ProcView;
  sessionId: (name: string) => string | null;
  /** pid → 进程组 id(/proc/<pid>/stat 第 5 格);读不到 null。 */
  pgid: (pid: number) => number | null;
  /** process.kill;负数 = 整个进程组。 */
  signal: (target: number, sig: NodeJS.Signals | 0) => void;
  sleep: (ms: number) => Promise<void>;
  graceMs: number;
  log?: (m: string) => void;
}

const samePath = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

/**
 * 能不能杀:四条都要对 —— tmux 会话 id 没变且这个 pid 仍是它的活 pane、argv 是 `app-server --listen <本节点 url>`、
 * /proc environ 里的 ANET_NODE_MARKER 是本节点的、CODEX_HOME 是本节点自己的。返回 null = 可以;否则是原因。
 */
export function hungKillVeto(snapshot: AppServerLaunchSnapshot | null, deps: Pick<HungKillDeps, "marker" | "codexHome" | "panes" | "proc" | "sessionId">): string | null {
  if (!snapshot) return "no launch snapshot";
  if (!deps.marker) return "this node has no identity marker (ANET_NODE_MARKER); cannot prove the process is ours";
  if (!snapshot.sessionId) return "launch snapshot has no tmux session id";
  const id = deps.sessionId(snapshot.session);
  if (id !== snapshot.sessionId) return `tmux session ${snapshot.session} is not the one this node started (id ${id ?? "none"}, expected ${snapshot.sessionId})`;
  const panes = deps.panes();
  if (panes === null) return "tmux unavailable";
  if (!parseTmuxPanes(panes).some((r) => r.session === snapshot.session && !r.dead && r.pid === snapshot.pid)) {
    return `pid ${snapshot.pid} is no longer the live pane of ${snapshot.session}`;
  }
  const raw = deps.proc.cmdline(snapshot.pid);
  const argv = raw ? raw.split("\0") : [];
  const at = argv.indexOf("--listen");
  if (!argv.includes("app-server") || at < 0 || argv[at + 1] !== snapshot.url) return `pid ${snapshot.pid} is not \`app-server --listen ${snapshot.url}\``;
  const environ = deps.proc.environ(snapshot.pid);
  if (environ === null) return `cannot read the environment of pid ${snapshot.pid}`;
  if (envVarFromEnviron(environ, "ANET_NODE_MARKER") !== deps.marker) return `pid ${snapshot.pid} carries another identity marker`;
  const home = envVarFromEnviron(environ, "CODEX_HOME");
  if (!home || hasLoneSurrogate(home) || !samePath(home, deps.codexHome)) return `pid ${snapshot.pid} runs with another CODEX_HOME`;
  return null;
}

/**
 * 杀掉核对过的卡死 app-server:SIGTERM → 最多等 graceMs → 仍活着(且仍是本节点的)就 SIGKILL。
 * pane 进程是自己进程组的组长时(tmux 起的 pane 都是)按组发,带走它起的子进程(否则子进程继续占着端口)。
 * 等到 pane 不在了才返回;没杀掉就抛错(重启算失败,消息进健康原因)。
 */
export async function terminateHungAppServer(snapshot: AppServerLaunchSnapshot, deps: HungKillDeps): Promise<string> {
  const veto = hungKillVeto(snapshot, deps);
  if (veto) throw new Error(`not killing the hung app-server: ${veto}`);
  const log = deps.log ?? (() => {});
  const pid = snapshot.pid;
  const target = deps.pgid(pid) === pid ? -pid : pid;
  const gone = () => { try { deps.signal(target, 0); return false; } catch { return true; } };
  log(`[app-server-watchdog] app-server pid ${pid} is alive but not answering; SIGTERM ${target < 0 ? `process group ${pid}` : `pid ${pid}`} (grace ${Math.round(deps.graceMs / 1000)}s)`);
  deps.signal(target, "SIGTERM");
  let how = "SIGTERM";
  for (let waited = 0; !gone() && waited < deps.graceMs; waited += 200) await deps.sleep(200);
  if (!gone()) {
    // 宽限期内 pid 可能已经被复用:只在它还是本节点的那个时补 SIGKILL。
    if (deps.proc.alive(pid) && envVarFromEnviron(deps.proc.environ(pid), "ANET_NODE_MARKER") !== deps.marker) {
      throw new Error(`pid ${pid} changed identity during the grace period; not sending SIGKILL`);
    }
    log(`[app-server-watchdog] app-server pid ${pid} still alive after ${Math.round(deps.graceMs / 1000)}s; SIGKILL`);
    deps.signal(target, "SIGKILL");
    how = "SIGKILL";
    for (let waited = 0; !gone() && waited < 5_000; waited += 200) await deps.sleep(200);
    if (!gone()) throw new Error(`hung app-server pid ${pid} survived SIGKILL`);
  }
  for (let waited = 0; waited < 5_000; waited += 200) {
    const panes = deps.panes();
    if (panes === null || !parseTmuxPanes(panes).some((r) => r.session === snapshot.session && !r.dead)) break;
    await deps.sleep(200);
  }
  return how;
}

export function readPgid(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "latin1");
    // comm 可能带空格和括号:从最后一个 ')' 之后数。字段:state ppid pgrp …
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const pgrp = Number(rest[2]);
    return Number.isInteger(pgrp) && pgrp > 0 ? pgrp : null;
  } catch { return null; }
}

export function realHungKillDeps(input: { codexHome: string; marker: string | undefined; graceMs: number; log?: (m: string) => void }): HungKillDeps {
  return {
    marker: input.marker,
    codexHome: input.codexHome,
    panes: listTmuxPanes,
    proc: linuxProcView,
    sessionId: tmuxSessionId,
    pgid: readPgid,
    signal: (target, sig) => { process.kill(target, sig); },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    graceMs: input.graceMs,
    log: input.log,
  };
}

/** 按快照原样拉起;返回新快照(pid 换了)。失败抛错(消息进健康原因)。 */
export async function relaunchAppServer(snapshot: AppServerLaunchSnapshot, deps: RelaunchDeps): Promise<AppServerLaunchSnapshot> {
  const log = deps.log ?? (() => {});
  const blocked = relaunchBlocker(snapshot, deps);
  if (blocked) throw new Error(blocked);
  const panes = deps.panes();
  // 会话名还在但 pane 已死(remain-on-exit):先清掉残骸,否则 new-session 撞名。
  if (panes !== null && parseTmuxPanes(panes).some((r) => r.session === snapshot.session)) {
    const id = deps.sessionId(snapshot.session);
    if (id) { try { deps.tmux(["kill-session", "-t", id]); } catch { /* 已经没了 */ } }
  }
  const envFile = deps.writeTokenFile(deps.codexHome, deps.token);
  const script = buildRelaunchScript(snapshot, deps.codexHome, envFile);
  try {
    deps.tmux([
      "new-session", "-d", "-s", snapshot.session, "-c", snapshot.cwd,
      ...(deps.marker ? ["-e", `ANET_NODE_MARKER=${deps.marker}`] : []),
      "-e", `CODEX_HOME=${deps.codexHome}`,
      "bash", "-lc", script,
    ]);
  } catch (e: any) {
    try { unlinkSync(envFile); } catch { /* 子 shell 可能已经删了 */ }
    throw new Error(`tmux new-session ${snapshot.session} failed: ${String(e?.message ?? e).slice(0, 120)}`);
  }
  log(`[app-server-watchdog] relaunched tmux=${snapshot.session} listening ${snapshot.url}`);
  const bound = await deps.waitPort(snapshot.url, deps.bindTimeoutMs ?? 25_000);
  if (existsSync(envFile)) { try { unlinkSync(envFile); } catch { /* best-effort */ } }
  if (!bound) throw new Error(`relaunched app-server did not bind ${snapshot.url} within ${Math.round((deps.bindTimeoutMs ?? 25_000) / 1000)}s`);
  const next = captureAppServerLaunch({ session: snapshot.session, url: snapshot.url, marker: deps.marker, panes: deps.panes(), proc: deps.proc, sessionId: deps.sessionId(snapshot.session) });
  if (!next.ok) throw new Error(`relaunched app-server not found: ${next.reason}`);
  const verdict = deps.verifyHome(next.snapshot.pid, deps.codexHome);
  if (!verdict.ok) {
    const id = deps.sessionId(snapshot.session);
    if (id) { try { deps.tmux(["kill-session", "-t", id]); } catch { /* best-effort */ } }
    throw new Error(`refusing the relaunched app-server: ${verdict.message} (#448 fail-closed)`);
  }
  if (verdict.skipped) log(`[app-server-watchdog] CODEX_HOME check skipped: ${verdict.skipped}`);
  return next.snapshot;
}

export function realRelaunchDeps(input: { codexHome: string; marker: string | undefined; token: string; procReader?: ProcReader; log?: (m: string) => void }): RelaunchDeps {
  return {
    codexHome: input.codexHome,
    marker: input.marker,
    token: input.token,
    panes: listTmuxPanes,
    proc: linuxProcView,
    tmux: (args) => { execTmux(args, { stdio: "pipe", timeout: 10_000 }); },
    sessionId: tmuxSessionId,
    waitPort: waitForPort,
    writeTokenFile: writeAppServerTokenFile,
    verifyHome: (pid, expected) => verifyProcessTreeCodexHome({ rootPid: pid, expected, label: "relaunched app-server", reader: input.procReader }),
    log: input.log,
  };
}

/** 节点正在被 `anet node stop` 拆掉时不重启:标记文件被删了 / 换了代 = 不是我们的了。 */
export function markerStillOurs(markerFile: string, marker: string | undefined): boolean {
  if (!marker) return true;
  try {
    const parsed = JSON.parse(readFileSync(markerFile, "utf8"));
    return parsed?.marker === marker;
  } catch { return false; }
}

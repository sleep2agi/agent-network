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

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, readlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { envVarFromEnviron, verifyProcessTreeCodexHome, type ProcReader } from "../codex-home-enforce";
import { parseTmuxPanes } from "./codex-health";

export interface AppServerLaunchSnapshot {
  session: string;
  url: string;
  argv: string[];
  cwd: string;
  pid: number;
}

export interface ProcView {
  cmdline(pid: number): string | null;
  cwd(pid: number): string | null;
  environ(pid: number): string | null;
  alive(pid: number): boolean;
}

export const linuxProcView: ProcView = {
  cmdline: (pid) => { try { return readFileSync(`/proc/${pid}/cmdline`, "latin1"); } catch { return null; } },
  cwd: (pid) => { try { return readlinkSync(`/proc/${pid}/cwd`); } catch { return null; } },
  environ: (pid) => { try { return readFileSync(`/proc/${pid}/environ`, "latin1"); } catch { return null; } },
  alive: (pid) => { try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; } },
};

/** tmux 会话名约定(agent-network/bin/cli.ts copresenceTmuxSessions):TUI 会话名 + "-appsrv"。 */
export function appsrvSessionFor(tuiSession: string): string {
  return `${tuiSession}-appsrv`;
}

export function listTmuxPanes(): string | null {
  try {
    return execFileSync("tmux", ["list-panes", "-a", "-F", "#{session_name}\t#{pane_pid}\t#{pane_dead}\t#{pane_current_command}"], {
      encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000,
    });
  } catch { return null; }
}

export function tmuxSessionId(name: string): string | null {
  let out: string;
  try {
    out = execFileSync("tmux", ["list-sessions", "-F", "#{session_id}\t#{session_name}"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 });
  } catch { return null; }
  for (const line of out.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab > 0 && line.slice(tab + 1) === name) return line.slice(0, tab);
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
    const marker = envVarFromEnviron(input.proc.environ(row.pid), "ANET_NODE_MARKER");
    if (input.marker && marker !== input.marker) {
      return { ok: false, reason: `pane pid ${row.pid} carries another identity marker` };
    }
    const cwd = input.proc.cwd(row.pid);
    if (!cwd) return { ok: false, reason: `cannot read cwd of pid ${row.pid}` };
    return { ok: true, snapshot: { session: input.session, url: input.url, argv, cwd, pid: row.pid } };
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
  if (deps.proc.alive(snapshot.pid)) {
    const marker = envVarFromEnviron(deps.proc.environ(snapshot.pid), "ANET_NODE_MARKER");
    if (!deps.marker || marker === deps.marker) return `app-server process ${snapshot.pid} is still alive but not answering; not killing a live process`;
  }
  const panes = deps.panes();
  if (panes !== null && parseTmuxPanes(panes).some((r) => r.session === snapshot.session && !r.dead)) {
    return `tmux session ${snapshot.session} still has a live pane; not replacing it`;
  }
  return null;
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
  const next = captureAppServerLaunch({ session: snapshot.session, url: snapshot.url, marker: deps.marker, panes: deps.panes(), proc: deps.proc });
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
    tmux: (args) => { execFileSync("tmux", args, { stdio: "pipe", timeout: 10_000 }); },
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

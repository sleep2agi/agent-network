// #448 —— 分层健康,随心跳/状态上报(只报告,不改变调度)。
//
// 现场:~40 台 codex 共存节点里,有的在 Hub 上显示 idle / in_flight=0,实际干不了活:
//   - app-server 的 ws 端口没人监听了;
//   - TUI 那个 tmux pane 变成了 `sleep infinity` 占位;
//   - 模型登录态返回 "refresh token revoked"。
// 「在线」只说明桥进程还活着。这里把另外三层分开报出来,读的人能一眼看出卡在哪一层:
//
//   health = {
//     bridge: "ok",                                          // 能发这条上报,桥就是活的
//     app_server: { ok, rtt_ms, last_error },                // 每 30s 一次 ws 握手探测
//     tui: { ok, reason },                                   // 仅共存节点:pane 活着且不是 sleep 占位
//     model_auth: "ok" | "revoked" | "expired" | "unknown",  // 由最近一次模型调用的结果分类
//   }
//
// 旧 Hub 不认 `health`:report_status 的顶层 schema 不是 strict,未知键被静默丢弃,不会拒整份上报
// (见 server/src/tools.ts 的方框注释)。register-telemetry-fallback 也把它列为可丢的可选块。

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export type ModelAuthState = "ok" | "revoked" | "expired" | "unknown";

export interface AppServerHealth {
  ok: boolean;
  rtt_ms: number | null;
  last_error: string | null;
}

export interface TuiHealth {
  ok: boolean;
  reason: "running" | "session-missing" | "pane-dead" | "sleep-placeholder" | "tmux-unavailable";
}

export interface NodeHealthReport {
  bridge: "ok";
  app_server?: AppServerHealth;
  tui?: TuiHealth;
  model_auth: ModelAuthState;
}

// ── model_auth ─────────────────────────────────────────────────────────────

// 🔴 revoked 先于 expired 判:上游的 "refresh token was already used" 文本里常常也带
//    "expired" / "401",但修法完全不同(revoked = 凭据被别处消费/作废,要重新登录;
//    expired = access token 到期,能刷新就会自愈)。
const REVOKED = [
  /refresh[_ ]token[^\n]{0,40}\b(revoked|already (been )?used|invalidated|reused)\b/i,
  /\btoken[^\n]{0,20}\b(has been|was) revoked\b/i,
  /\brefresh_token_reused\b/i,
  /\binvalid_grant\b/i,
];
const EXPIRED = [
  /\b(access[_ ])?token[^\n]{0,30}\bexpired\b/i,
  /\btoken_expired\b/i,
  /\b401\b[^\n]{0,40}\bunauthori[sz]ed\b/i,
  /\bunauthori[sz]ed\b[^\n]{0,40}\b401\b/i,
  /\bstatus(?: code)?[:= ]+401\b/i,
  /\bHTTP\/?\d?(?:\.\d)? 401\b/i,
];

/** 只认登录态类错误;与登录无关的失败返回 null(调用方据此不改动当前状态)。 */
export function classifyModelAuthError(text: string): Exclude<ModelAuthState, "ok" | "unknown"> | null {
  if (!text) return null;
  if (REVOKED.some((re) => re.test(text))) return "revoked";
  if (EXPIRED.some((re) => re.test(text))) return "expired";
  return null;
}

export class ModelAuthTracker {
  private state: ModelAuthState = "unknown";
  get(): ModelAuthState { return this.state; }
  /** 一次模型调用成功 → ok。 */
  noteSuccess(): void { this.state = "ok"; }
  /** 一次模型调用失败:只有登录类错误才改状态;其他失败(超时、工具报错)说明不了登录态。 */
  noteError(text: string): void {
    const cls = classifyModelAuthError(text);
    if (cls) this.state = cls;
  }
}

// ── app_server:ws 握手 ─────────────────────────────────────────────────────

/** 只接受本机回环 ws:// —— 探针不该被配置成去连别处。 */
export function isLoopbackWsUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === "ws:" || u.protocol === "wss:")
      && ["127.0.0.1", "localhost", "[::1]", "::1"].includes(u.hostname);
  } catch { return false; }
}

/**
 * 打开一条 ws 连接、等到 open、立即关闭。rtt = 握手耗时。
 * 浏览器式 WebSocket(全局 / undici)不暴露 ping 帧;握手完成本身就证明端口有监听且 HTTP upgrade
 * 被处理了 —— 正好是「端口没人监听」这类故障要回答的问题。不发任何 JSON-RPC,不碰会话。
 */
export async function probeAppServerWs(
  url: string,
  opts: { timeoutMs?: number; wsCtor: any; now?: () => number },
): Promise<AppServerHealth> {
  const now = opts.now ?? (() => Date.now());
  if (!isLoopbackWsUrl(url)) return { ok: false, rtt_ms: null, last_error: "not a loopback ws url" };
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const started = now();
  return await new Promise<AppServerHealth>((resolve) => {
    let settled = false;
    let ws: any;
    const finish = (r: AppServerHealth) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws?.close(); } catch { /* already closed */ }
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, rtt_ms: null, last_error: `no ws handshake within ${timeoutMs}ms` }), timeoutMs);
    try {
      ws = new opts.wsCtor(url);
    } catch (e: any) {
      finish({ ok: false, rtt_ms: null, last_error: String(e?.message ?? e).slice(0, 200) });
      return;
    }
    ws.onopen = () => finish({ ok: true, rtt_ms: Math.max(0, now() - started), last_error: null });
    ws.onerror = (ev: any) => finish({
      ok: false, rtt_ms: null,
      last_error: String(ev?.message ?? ev?.error?.message ?? "ws error (connection refused?)").slice(0, 200),
    });
    ws.onclose = (ev: any) => finish({ ok: false, rtt_ms: null, last_error: `closed before open (code=${ev?.code ?? "?"})` });
  });
}

// ── tui:tmux pane ─────────────────────────────────────────────────────────

export interface TmuxPaneRow { session: string; pid: number; dead: boolean; command: string }

/**
 * `tmux list-panes -a -F '#{session_name}\t#{pane_pid}\t#{pane_dead}\t#{pane_current_command}'`
 * 的输出 → 行。会话名**逐字相等**比较:tmux 3.4 上 `-t =名` 对 CJK 名返回空、`-t 名` 是前缀匹配
 * (会命中 `<名>-appsrv`),所以不能交给 tmux 去找。
 */
export function parseTmuxPanes(out: string): TmuxPaneRow[] {
  const rows: TmuxPaneRow[] = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    const [session, pid, dead, command] = line.split("\t");
    if (session === undefined || pid === undefined) continue;
    rows.push({ session, pid: Number(pid), dead: dead === "1", command: command ?? "" });
  }
  return rows;
}

const SLEEP_CMDLINE = /^(?:\S*\/)?sleep(?:\0|$)/;

export function classifyTuiPane(
  rows: TmuxPaneRow[] | null,
  session: string,
  cmdlineOf: (pid: number) => string | null,
): TuiHealth {
  if (rows === null) return { ok: false, reason: "tmux-unavailable" };
  const mine = rows.filter((r) => r.session === session);
  if (mine.length === 0) return { ok: false, reason: "session-missing" };
  const live = mine.filter((r) => !r.dead);
  if (live.length === 0) return { ok: false, reason: "pane-dead" };
  // 每个活 pane 都是 sleep 才算占位;任一 pane 跑着别的东西就算 TUI 在。
  const isSleep = (r: TmuxPaneRow) => r.command === "sleep" || SLEEP_CMDLINE.test(cmdlineOf(r.pid) ?? "");
  if (live.every(isSleep)) return { ok: false, reason: "sleep-placeholder" };
  return { ok: true, reason: "running" };
}

export function probeTmuxTui(session: string): TuiHealth {
  let out: string;
  try {
    out = execFileSync("tmux", ["list-panes", "-a", "-F", "#{session_name}\t#{pane_pid}\t#{pane_dead}\t#{pane_current_command}"], {
      encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000,
    });
  } catch {
    // 没有 tmux 服务器 = 没有任何会话;与「tmux 不存在」在这里不必区分,TUI 都不在。
    return classifyTuiPane([], session, () => null);
  }
  return classifyTuiPane(parseTmuxPanes(out), session, (pid) => {
    try { return readFileSync(`/proc/${pid}/cmdline`, "latin1"); } catch { return null; }
  });
}

// ── 汇总 ──────────────────────────────────────────────────────────────────

export interface CodexHealthMonitorOptions {
  /** 每次探测时取一次:共享拓扑是 config 里的 url,自有拓扑是当前会话的 url;没有就不报 app_server。 */
  appServerUrl: () => string | undefined;
  /** 共存节点的 TUI tmux 会话名;非共存节点不报 tui。 */
  tuiSession?: string;
  intervalMs?: number;
  modelAuth: ModelAuthTracker;
  probeAppServer: (url: string) => Promise<AppServerHealth>;
  probeTui?: (session: string) => TuiHealth;
  /** 任一层的 ok 翻转时回调(用于立刻补一次上报,而不是等 3 分钟心跳)。 */
  onChange?: (report: NodeHealthReport) => void;
}

export function healthSignature(r: NodeHealthReport): string {
  return [r.app_server?.ok ?? "-", r.tui?.ok ?? "-", r.tui?.reason ?? "-", r.model_auth].join("|");
}

export function createCodexHealthMonitor(opts: CodexHealthMonitorOptions) {
  let appServer: AppServerHealth | undefined;
  let tui: TuiHealth | undefined;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let lastSig: string | null = null;

  const snapshot = (): NodeHealthReport => ({
    bridge: "ok",
    ...(appServer ? { app_server: appServer } : {}),
    ...(tui ? { tui } : {}),
    model_auth: opts.modelAuth.get(),
  });

  const tick = async (): Promise<NodeHealthReport> => {
    if (running) return snapshot();
    running = true;
    try {
      const url = opts.appServerUrl();
      appServer = url ? await opts.probeAppServer(url) : undefined;
      if (opts.tuiSession) tui = (opts.probeTui ?? probeTmuxTui)(opts.tuiSession);
    } catch (e: any) {
      appServer = { ok: false, rtt_ms: null, last_error: String(e?.message ?? e).slice(0, 200) };
    } finally {
      running = false;
    }
    const report = snapshot();
    const sig = healthSignature(report);
    if (lastSig !== null && sig !== lastSig) opts.onChange?.(report);
    lastSig = sig;
    return report;
  };

  return {
    snapshot,
    tick,
    /** 模型调用结果变了之后调用:登录态翻转也要触发 onChange。 */
    noteModelAuthMaybeChanged(): void {
      const report = snapshot();
      const sig = healthSignature(report);
      if (lastSig !== null && sig !== lastSig) opts.onChange?.(report);
      lastSig = sig;
    },
    start(): void {
      if (timer) return;
      void tick();
      timer = setInterval(() => { void tick(); }, opts.intervalMs ?? 30_000);
      (timer as any).unref?.();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

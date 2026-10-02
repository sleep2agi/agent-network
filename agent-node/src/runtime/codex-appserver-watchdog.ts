// #461(#448 的子项)—— App Server 看门狗:app-server 死了(ws 1006、进程没了)就按原会话重新拉起。
//
// .94 起节点把 app_server 层的健康报上去(codex-health.ts),.86 的 Hub 据此把降级节点挡在派发外面
// (server/src/node-health-guard.ts)。但「报上去」之后没人修:一台 app-server 挂掉的节点会一直降级,
// 直到有人登上机器 `anet node restart`。这里补上自愈的那一半:
//
//   探针连续失败 FAILURES_BEFORE_RESTART 次(或已经知道进程退出了)→ 重启一次 → 探针恢复 ok → 健康翻回 ok,
//   onChange 立刻补报,Hub 的派发门自己重新打开。
//
// 健康随重启走:重启期间 app_server.ok=false、last_error 说明「正在第 k/N 次重启」;放弃之后
// last_error 说明放弃了、为什么、怎么手动修 —— 节点保持降级,不会假装好了。
//
// 🔴 不做的事(owner 约束):不自动换账号、不在节点之间共享/拷贝 auth、不碰别的节点的进程。
//    重启只用本节点自己的 CODEX_HOME、自己的标记(ANET_NODE_MARKER)、自己的令牌。
// 🔴 一个窗口内最多 MAX_RESTARTS 次:一台起来就死的 app-server(登录坏了、二进制坏了)不能被无限重启。
//    放弃是粘性的 —— 直到探针自己看到 ok(有人手动修好了)才回到看守状态。
// 🔴 只重启「进程确实没了」的:进程还在但不应答(卡死)不杀 —— 那可能是正在跑的一轮,杀了会丢活。
//    canRestart() 返回原因时只报告不动手。

import type { AppServerHealth } from "./codex-health";

export const DEFAULT_MAX_RESTARTS = 3;
export const DEFAULT_RESTART_WINDOW_MS = 10 * 60_000;
export const DEFAULT_FAILURES_BEFORE_RESTART = 2;

export type WatchdogPhase = "watching" | "restarting" | "gave_up";

export interface AppServerWatchdogOptions {
  maxRestarts?: number;
  windowMs?: number;
  /** 连续几次探针失败才动手(一次握手超时不该就重启)。已知进程退出时跳过这一步(noteExit)。 */
  failuresBeforeRestart?: number;
  now?: () => number;
  /** 不能/不该重启时返回原因(进程还活着、没有启动快照、平台不支持、节点正在停…);可以就返回 null。 */
  canRestart?: () => string | null;
  /** 真正的重启:拉起 app-server 并把桥重新接上原会话。失败就抛,消息会出现在健康原因里。 */
  restart: (cause: string) => Promise<void>;
  /** 一次重启结束(成功或失败)后调用:调用方据此立刻再探一次,让健康尽快翻回来。 */
  onSettled?: () => void;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
}

export interface AppServerWatchdogState {
  phase: WatchdogPhase;
  /** 窗口内已经发起的重启时刻(ms)。 */
  restarts: number[];
  consecutiveFailures: number;
  lastRestartError: string | null;
  gaveUpReason: string | null;
}

const minutes = (ms: number) => `${Math.round(ms / 60_000)} min`;

export function createAppServerWatchdog(opts: AppServerWatchdogOptions) {
  const maxRestarts = Math.max(1, opts.maxRestarts ?? DEFAULT_MAX_RESTARTS);
  const windowMs = Math.max(1_000, opts.windowMs ?? DEFAULT_RESTART_WINDOW_MS);
  const failuresBeforeRestart = Math.max(1, opts.failuresBeforeRestart ?? DEFAULT_FAILURES_BEFORE_RESTART);
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? (() => {});
  const warn = opts.warn ?? (() => {});

  let phase: WatchdogPhase = "watching";
  let restarts: number[] = [];
  let consecutive = 0;
  let exitKnown = false;
  let currentCause = "";
  let lastRestartError: string | null = null;
  let gaveUpReason: string | null = null;

  const attempt = () => restarts.length;
  const annotate = (h: AppServerHealth, why: string): AppServerHealth => ({ ok: false, rtt_ms: null, last_error: why.slice(0, 200) || h.last_error });

  const begin = (cause: string) => {
    restarts.push(now());
    phase = "restarting";
    currentCause = cause;
    log(`[app-server-watchdog] restarting app-server (attempt ${attempt()}/${maxRestarts} in ${minutes(windowMs)}): ${cause}`);
    void Promise.resolve()
      .then(() => opts.restart(cause))
      .then(() => {
        lastRestartError = null;
        log(`[app-server-watchdog] app-server restarted (attempt ${attempt()}/${maxRestarts}); waiting for the probe to confirm`);
      })
      .catch((e: any) => {
        lastRestartError = String(e?.message ?? e).slice(0, 160);
        warn(`[app-server-watchdog] restart attempt ${attempt()}/${maxRestarts} failed: ${lastRestartError}`);
      })
      .finally(() => {
        phase = "watching";
        consecutive = 0;
        exitKnown = false;
        opts.onSettled?.();
      });
  };

  return {
    /**
     * 每次 app_server 探针结果都过一遍:返回要上报的健康(可能带上重启/放弃的说明),必要时发起重启。
     * 不等重启完成 —— 重启在后台跑,结束后 onSettled 让调用方再探一次。
     */
    observe(h: AppServerHealth): AppServerHealth {
      if (h.ok) {
        if (phase === "gave_up") log(`[app-server-watchdog] app-server is answering again (fixed by hand?) — watching again`);
        if (phase !== "restarting") phase = "watching";
        consecutive = 0;
        exitKnown = false;
        gaveUpReason = null;
        return h;
      }
      const raw = h.last_error ?? "unreachable";
      if (phase === "restarting") return annotate(h, `restarting app-server (attempt ${attempt()}/${maxRestarts}): ${currentCause}`);
      if (phase === "gave_up") return annotate(h, gaveUpReason ?? raw);
      consecutive += 1;
      if (!exitKnown && consecutive < failuresBeforeRestart) return h;
      const blocked = opts.canRestart?.() ?? null;
      if (blocked) return annotate(h, `${raw}; not restarting: ${blocked}`);
      const t = now();
      restarts = restarts.filter((at) => t - at < windowMs);
      if (restarts.length >= maxRestarts) {
        phase = "gave_up";
        gaveUpReason = `app-server auto-restart gave up: ${restarts.length} restarts in ${minutes(windowMs)}`
          + `${lastRestartError ? ` (last: ${lastRestartError})` : ""} — restart the node by hand (anet node restart)`;
        warn(`[app-server-watchdog] ${gaveUpReason}; staying degraded`);
        return annotate(h, gaveUpReason);
      }
      begin(exitKnown ? `process exited; ${raw}` : raw);
      return annotate(h, `restarting app-server (attempt ${attempt()}/${maxRestarts}): ${currentCause}`);
    },
    /** 已经确知进程退出了(owned 子进程的 exit 事件 / ws 1006):下一次失败的探针不再等确认。 */
    noteExit(): void {
      exitKnown = true;
    },
    state(): AppServerWatchdogState {
      return { phase, restarts: [...restarts], consecutiveFailures: consecutive, lastRestartError, gaveUpReason };
    },
  };
}

/** 测试 / 现场调参:ANET_CODEX_APPSERVER_RESTART_MAX、ANET_CODEX_APPSERVER_RESTART_WINDOW_MS。非法值退回默认。 */
export function watchdogLimitsFromEnv(env: NodeJS.ProcessEnv): { maxRestarts: number; windowMs: number } {
  const int = (v: string | undefined, min: number, fallback: number) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= min ? n : fallback;
  };
  return {
    maxRestarts: int(env.ANET_CODEX_APPSERVER_RESTART_MAX, 1, DEFAULT_MAX_RESTARTS),
    windowMs: int(env.ANET_CODEX_APPSERVER_RESTART_WINDOW_MS, 1_000, DEFAULT_RESTART_WINDOW_MS),
  };
}

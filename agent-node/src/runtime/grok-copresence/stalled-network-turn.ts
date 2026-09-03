// #870 —— 网络回合超时后,状态机故意不回 idle(共享 TUI 里那一轮可能还在跑,强行标 idle 会
// 并发注入)。但它把「回 idle」完全押在 turn_ended 一定会到上;不到时 phase 永远停在
// network_turn,后面每条任务只 queued 不 injected,各自等满超时失败,且没有自愈路径。
//
// 这里给出「有上限的等待 + 观测」的出口,两个条件都要满足才放弃那一轮:
//   1. 有上限:那条任务已经超时,而且从超时算起又过了一个 taskTimeout(总共 ≥ 2× timeout)
//      仍没等到 turn_ended;
//   2. 有观测:PTY 已经连续 quietMs 没有任何输出 —— 真在跑的 grok 回合会持续刷屏
//      (流式输出/进度),安静这么久说明那一轮不在产出。
// 放弃 = 把状态机从 network_turn 拉回 idle(显式事件 network_turn_abandoned,只对同一个
// taskId 生效),后面排队的任务才能注入;日志里写明两个数字。
export interface StalledNetworkTurnInput {
  readonly phase: string;
  /** 当前 network_turn 里的任务 id(没有则 null)。 */
  readonly activeTaskId: string | null;
  /** 超时时记下的那条任务 id(没有超时过则 null)。 */
  readonly timedOutTaskId: string | null;
  /** 超时发生的时刻(ms epoch)。 */
  readonly timedOutAt: number | null;
  readonly now: number;
  readonly taskTimeoutMs: number;
  /** PTY 最后一次有输出的时刻。 */
  readonly lastPtyOutputAt: number;
  readonly quietMs?: number;
}

export const STALLED_TURN_QUIET_MS = 60_000;

export function describeStalledNetworkTurn(input: StalledNetworkTurnInput): string | null {
  if (input.phase !== "network_turn") return null;
  if (!input.activeTaskId || !input.timedOutTaskId || input.activeTaskId !== input.timedOutTaskId) return null;
  if (input.timedOutAt === null) return null;
  const sinceTimeout = input.now - input.timedOutAt;
  if (sinceTimeout < input.taskTimeoutMs) return null;
  const quietMs = input.quietMs ?? STALLED_TURN_QUIET_MS;
  const quietFor = input.now - input.lastPtyOutputAt;
  if (quietFor < quietMs) return null;
  return `network turn ${input.activeTaskId} timed out ${Math.round(sinceTimeout / 1000)}s ago and no turn_ended arrived; `
    + `PTY has been silent for ${Math.round(quietFor / 1000)}s — abandoning the turn so queued tasks can run (#870). `
    + `If the shared TUI was in fact still working, the next injection will be queued behind it by grok itself.`;
}

// #5332 —— ACP 回合取消（`session/cancel` 通知）。
//
// ACP 规范里取消是**通知**：client → agent 发 `session/cancel`，参数 { sessionId }，
// agent 以 stopReason=cancelled 结束本轮。传输层早就有 notify（client.ts:226），
// 缺的只是「把当前回合的 client/session 暴露给 control 处理器」。
//
// 这个模块只做登记与取消；不做重试、不猜结果 —— 发出去以后是否真的停由 agent 决定
// （老版本 agy 可能不认，真机验证后再决定能力位是否降级）。
export type ActiveAcpTurn = {
  client: { notify: (method: string, params?: unknown) => void };
  sessionId: string;
  runtime: string;
};

let current: ActiveAcpTurn | null = null;

export function setActiveAcpTurn(turn: ActiveAcpTurn): void { current = turn; }
export function clearActiveAcpTurn(turn: ActiveAcpTurn): void { if (current === turn) current = null; }
export function getActiveAcpTurn(): ActiveAcpTurn | null { return current; }
/** 测试用：清空（生产不需要，避免跨用例污染）。 */
export function __resetActiveAcpTurnForTest(): void { current = null; }

export function cancelActiveAcpTurn(): { ok: boolean; reason?: string } {
  const turn = current;
  if (!turn) return { ok: false, reason: "no_active_turn" };
  try {
    turn.client.notify("session/cancel", { sessionId: turn.sessionId });
    return { ok: true };
  } catch (error: any) {
    return { ok: false, reason: String(error?.message ?? error) };
  }
}

import { beforeEach, describe, expect, test } from "bun:test";
import { __resetActiveAcpTurnForTest, cancelActiveAcpTurn, clearActiveAcpTurn, getActiveAcpTurn, setActiveAcpTurn } from "./active-turn.js";

describe("#5332 ACP cancel", () => {
  beforeEach(() => { __resetActiveAcpTurnForTest(); });
  test("没有在飞回合 ⇒ no_active_turn（不假装成功）", () => {
    expect(cancelActiveAcpTurn()).toEqual({ ok: false, reason: "no_active_turn" });
  });

  test("有在飞回合 ⇒ 发 session/cancel 通知，带 sessionId", () => {
    const calls: Array<{ method: string; params: any }> = [];
    const turn = { client: { notify: (method: string, params?: unknown) => { calls.push({ method, params }); } }, sessionId: "ses_1", runtime: "antigravity" };
    setActiveAcpTurn(turn);
    expect(cancelActiveAcpTurn()).toEqual({ ok: true });
    expect(calls).toEqual([{ method: "session/cancel", params: { sessionId: "ses_1" } }]);
    clearActiveAcpTurn(turn);
  });

  test("notify 抛错 ⇒ ok:false + 原因（不吞掉）", () => {
    setActiveAcpTurn({ client: { notify: () => { throw new Error("closed"); } }, sessionId: "s", runtime: "grok-build-acp" });
    expect(cancelActiveAcpTurn()).toEqual({ ok: false, reason: "closed" });
  });

  test("clear 只清自己那一份（不误清下一轮）", () => {
    const a = { client: { notify: () => {} }, sessionId: "a", runtime: "antigravity" };
    const b = { client: { notify: () => {} }, sessionId: "b", runtime: "antigravity" };
    setActiveAcpTurn(a); setActiveAcpTurn(b);
    clearActiveAcpTurn(a);
    expect(getActiveAcpTurn()?.sessionId).toBe("b");
  });
});

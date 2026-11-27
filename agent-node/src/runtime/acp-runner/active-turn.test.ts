import { beforeEach, describe, expect, test } from "bun:test";
import { __resetActiveAcpTurnForTest, cancelActiveAcpTurn, clearActiveAcpTurn, getActiveAcpTurn, setActiveAcpTurn } from "./active-turn.js";

describe("#5332 ACP cancel", () => {
  beforeEach(() => { __resetActiveAcpTurnForTest(); });
  test("没有在飞回合 ⇒ no_active_turn（不假装成功）", () => {
    expect(cancelActiveAcpTurn()).toEqual({ ok: false, interrupted: false, reason: "no_active_turn" });
  });

  test("有在飞回合 ⇒ 发 session/cancel 通知，带 sessionId 且回 interrupted:true", () => {
    const calls: Array<{ method: string; params: any }> = [];
    const turn = { client: { notify: (method: string, params?: unknown) => { calls.push({ method, params }); } }, sessionId: "ses_1", runtime: "antigravity" };
    setActiveAcpTurn(turn);
    expect(cancelActiveAcpTurn()).toEqual({ ok: true, interrupted: true });
    expect(calls).toEqual([{ method: "session/cancel", params: { sessionId: "ses_1" } }]);
    clearActiveAcpTurn(turn);
  });

  test("notify 抛错 ⇒ ok:false + interrupted:false + 原因（不吞掉）", () => {
    setActiveAcpTurn({ client: { notify: () => { throw new Error("closed"); } }, sessionId: "s", runtime: "grok-build-acp" });
    expect(cancelActiveAcpTurn()).toEqual({ ok: false, interrupted: false, reason: "closed" });
  });

  test("clear 只清自己那一份（不误清下一轮）", () => {
    const a = { client: { notify: () => {} }, sessionId: "a", runtime: "antigravity" };
    const b = { client: { notify: () => {} }, sessionId: "b", runtime: "antigravity" };
    setActiveAcpTurn(a); setActiveAcpTurn(b);
    clearActiveAcpTurn(a);
    expect(getActiveAcpTurn()?.sessionId).toBe("b");
  });
});

describe("回合结束后撤销登记", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(import.meta.dir, "../grok-build-acp/runtime.ts"), "utf8") as string;
  test("ACP 只在一轮 prompt 在飞时登记，prompt 结束即撤销（之后的停止得到 no_active_turn）", () => {
    // #3922：登记点从「建好 session 就登记」改成「session/prompt 在飞期间登记、finally 撤销」——
    // 建会话、重试退避、收尾 drain 期间来的停止不能再被当成「这一轮被取消」。
    const promptScoped = /const activeTurn: ActiveAcpTurn = \{ client, sessionId, runtime: "acp" \};\s*setActiveAcpTurn\(activeTurn\);\s*try \{[\s\S]*?\} finally \{\s*clearActiveAcpTurn\(activeTurn\);\s*\}/;
    expect(promptScoped.test(src)).toBe(true);
    const turn = { client: { notify: () => { throw new Error("antigravity ACP client not started or already exited"); } }, sessionId: "s", runtime: "acp" };
    __resetActiveAcpTurnForTest();
    setActiveAcpTurn(turn);
    clearActiveAcpTurn(turn);
    expect(cancelActiveAcpTurn()).toEqual({ ok: false, interrupted: false, reason: "no_active_turn" });
  });
});

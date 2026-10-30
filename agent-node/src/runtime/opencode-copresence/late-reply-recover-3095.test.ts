import { describe, expect, test } from "bun:test";
import { extractTurnResult, type TurnEntry } from "./late-reply-recover";

// #3095 阶段二 —— 从会话历史里读回「上次没等到的那一轮」的结果。
//
// 实测依据（2026-10-30）：节点 kill -9 + 重启后，历史仍在共享 opencode server 上，
// 目标 turn 之后有一条 assistant 输出 "DONE persist-3095"。
// 下面这些用例就是用那次真实形状构造的（最新在前、turn 之后有 prompt 回显 + 最终答案 + idle）。
const entries: TurnEntry[] = [
  { id: "msg_idle", role: "idle" },
  { id: "msg_final", role: "assistant", content: [{ type: "text", text: "DONE persist-3095" }] },
  { id: "msg_echo", role: "assistant", content: [{ type: "text", text: "Another drill. Run sleep 50, reply one line." }] },
  { id: "msg_turn", role: "user" },
  { id: "msg_old", role: "assistant", content: [{ type: "text", text: "earlier answer" }] },
];

describe("#3095 阶段二 读回结果", () => {
  test("取这个 turn 之后**最后一条** assistant（不是 prompt 回显）", () => {
    const out = extractTurnResult(entries, "msg_turn");
    expect(out).toEqual({ state: "done", text: "DONE persist-3095" });
  });

  test("turn 还在跑（之后没有 assistant 输出）：pending，不是 missing", () => {
    // turn 是最新一条 ⇒ 它之后什么都没有
    const running: TurnEntry[] = [
      { id: "msg_turn", role: "user" },
      { id: "msg_old", role: "assistant", content: [{ type: "text", text: "earlier answer" }] },
    ];
    expect(extractTurnResult(running, "msg_turn").state).toBe("pending");
  });

  test("历史里没有这个 turn（server 重启/被裁剪）：missing —— 要降级成告知丢失", () => {
    expect(extractTurnResult(entries, "msg_gone").state).toBe("missing");
  });

  test("只认 turn 之后的输出，不把更早的答案当成本轮结果", () => {
    const out = extractTurnResult(entries, "msg_turn");
    expect(out.state === "done" && out.text).not.toBe("earlier answer");
  });

  test("assistant 内容为空不算完成（继续等，别把空串当结果发出去）", () => {
    const empty: TurnEntry[] = [
      { id: "msg_empty", role: "assistant", content: [{ type: "text", text: "   " }] },
      { id: "msg_turn", role: "user" },
    ];
    expect(extractTurnResult(empty, "msg_turn").state).toBe("pending");
  });

  test("parts 形状与 content 形状都认（两种历史格式并存）", () => {
    const partsShape: TurnEntry[] = [
      { id: "msg_final", role: "assistant", parts: [{ type: "text", text: "从 parts 读到的结果" }] },
      { id: "msg_turn", role: "user" },
    ];
    expect(extractTurnResult(partsShape, "msg_turn")).toEqual({ state: "done", text: "从 parts 读到的结果" });
  });
});

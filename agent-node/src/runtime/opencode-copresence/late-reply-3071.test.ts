import { describe, expect, test } from "bun:test";
import { watchLateReply } from "./v2-session";

// #3071 —— 超时不等于结果丢失。
//
// 现场（2026-10-30 生产实测）：
//   「仍在节点的 TUI 会话里运行…等待回复已达 30 分钟上限」的失败任务 289 条，
//   其中 thread_id/turn_id 非空的 **0 条**；全库 task_late_replies 只有 4 行。
//   那一轮最终跑完了，但没有人在听 —— 结果直接蒸发。
//
// 这个改动之所以小：bridge 判断「好了没」本来就是**轮询会话历史**，
// 所以超时后只要让轮询继续活着，等 turn 结束再补发一次即可。
describe("#3071 超时后的迟到结果", () => {
  const noSleep = async () => {};

  test("轮询到这一轮结束：补发一次 replied，带上会话/消息 id", async () => {
    const calls: any[] = [];
    let polls = 0;
    await watchLateReply({
      threadId: "ses_x", turnId: "msg_y",
      readEntries: async () => { polls += 1; return [{} as any]; },
      isRunning: () => true,
      onLateReply: (payload) => { calls.push(payload); },
      sleep: noSleep,
      capMs: 10_000,
      // 前两次还在跑，第三次结束
      evaluate: () => (polls >= 3 ? { state: "done", replyText: "最终结果" } : { state: "pending" }),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ threadId: "ses_x", turnId: "msg_y", replyText: "最终结果", status: "replied" });
  });

  test("一直没结束：到上限就放弃，一次都不补发，并留日志", async () => {
    const calls: any[] = [];
    const logs: string[] = [];
    await watchLateReply({
      threadId: "ses_x", turnId: "msg_y",
      readEntries: async () => [{} as any],
      isRunning: () => true,
      onLateReply: (payload) => { calls.push(payload); },
      sleep: noSleep,
      capMs: 5,
      log: (m) => logs.push(m),
      evaluate: () => ({ state: "pending" }),
    });
    expect(calls).toHaveLength(0);
    expect(logs.join("\n")).toContain("late-reply window closed");
  });

  test("会话已经不在跑：立刻退出，不补发", async () => {
    const calls: any[] = [];
    await watchLateReply({
      threadId: "ses_x", turnId: "msg_y",
      readEntries: async () => [{} as any],
      isRunning: () => false,
      onLateReply: (payload) => { calls.push(payload); },
      sleep: noSleep,
      capMs: 10_000,
      evaluate: () => ({ state: "done", replyText: "不该到这" }),
    });
    expect(calls).toHaveLength(0);
  });

  test("这一轮以错误结束：仍然补发，status=failed 且带原因", async () => {
    const calls: any[] = [];
    await watchLateReply({
      threadId: "ses_x", turnId: "msg_y",
      readEntries: async () => [{} as any],
      isRunning: () => true,
      onLateReply: (payload) => { calls.push(payload); },
      sleep: noSleep,
      capMs: 10_000,
      evaluate: () => ({ state: "done_error", error: new Error("provider quota") }),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].status).toBe("failed");
    expect(calls[0].replyText).toContain("provider quota");
  });

  test("补发本身失败不能把观察器炸掉（只写日志）", async () => {
    const logs: string[] = [];
    await watchLateReply({
      threadId: "ses_x", turnId: "msg_y",
      readEntries: async () => [{} as any],
      isRunning: () => true,
      onLateReply: () => { throw new Error("hub down"); },
      sleep: noSleep,
      capMs: 10_000,
      log: (m) => logs.push(m),
      evaluate: () => ({ state: "done", replyText: "x" }),
    });
    expect(logs.join("\n")).toContain("late-reply delivery failed");
  });

  test("历史读取失败不终止观察（下一轮继续试）", async () => {
    const calls: any[] = [];
    let reads = 0;
    await watchLateReply({
      readEntries: async () => { reads += 1; if (reads < 3) throw new Error("transient"); return [{} as any]; },
      isRunning: () => true,
      onLateReply: (payload) => { calls.push(payload); },
      sleep: noSleep,
      capMs: 10_000,
      log: () => {},
      evaluate: () => ({ state: "done", replyText: "迟到的" }),
    });
    expect(reads).toBeGreaterThanOrEqual(3);
    expect(calls).toHaveLength(1);
  });
});

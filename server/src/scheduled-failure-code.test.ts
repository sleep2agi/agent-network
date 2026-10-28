// #1879 —— 失败分类：共享会话忙与真失败分开。
import { describe, expect, test } from "bun:test";
import { scheduledFailureCode } from "./scheduled-failure-code.js";

describe("scheduledFailureCode", () => {
  test("共享会话忙 → task_failed_busy（两种情况都覆盖）", () => {
    const notSubmitted = "[TMA云盘欧] opencode 任务未提交：共享会话在 30 分钟 内一直处于忙碌状态（可能有人正在 TUI 里跑一轮），本任务没有发出";
    expect(scheduledFailureCode("failed", notSubmitted)).toBe("task_failed_busy");
    const stillRunning = "[通信客户端欧] ⏳ opencode 任务仍在节点的 TUI 会话里运行，没有被中止；bridge 等待回复已达 30 分钟";
    expect(scheduledFailureCode("failed", stillRunning)).toBe("task_failed_busy");
  });

  test("真失败仍然是 task_failed（不能被分类吞掉）", () => {
    expect(scheduledFailureCode("failed", "runtime failed")).toBe("task_failed");
    expect(scheduledFailureCode("failed", null)).toBe("task_failed");
    // 提到「共享会话」但没有任何忙碌措辞 ⇒ 仍然算真失败，不能被分类吞掉
    expect(scheduledFailureCode("failed", "共享会话已释放，任务失败原因不明")).toBe("task_failed");
  });

  test("非 failed 状态不受影响", () => {
    expect(scheduledFailureCode("replied", "共享会话忙")).toBeNull();
    expect(scheduledFailureCode("cancelled", "共享会话一直处于忙碌")).toBe("task_cancelled");
    expect(scheduledFailureCode("expired", null)).toBe("task_expired");
  });
});

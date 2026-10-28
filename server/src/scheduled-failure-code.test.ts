// #1879 —— 失败分类：共享会话忙与真失败分开。
import { describe, expect, test } from "bun:test";
import { scheduledFailureCode, busyElapsedNote } from "./scheduled-failure-code.js";

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

// #2884 —— 两个量必须分开报：排队（创建→开始处理）与会话等待（开始处理→失败）。
describe("busyElapsedNote", () => {
  test("生产里那条 412 分钟：拆成排队 382 + 会话等待 30.1", () => {
    // 原始数据取自 tasks 表（2026-10-27，TMA需求欧）
    const note = busyElapsedNote("2026-10-27 13:54:48", "2026-10-27 20:16:52", "2026-10-27 20:46:57");
    expect(note).toBeTruthy();
    expect(note!).toContain("实测总耗时 412 分钟");
    expect(note!).toContain("排队 382 分钟");
    expect(note!).toContain("会话等待 30.1 分钟");
    // 关键：不能让人以为 30 分钟就是全部
    expect(note!).toContain("不代表总共等了多久");
  });

  test("没有被排队的（排队 0）：照样把两段都说出来，不省略", () => {
    const note = busyElapsedNote("2026-10-28 12:11:07", "2026-10-28 12:11:08", "2026-10-28 12:41:10");
    expect(note!).toContain("排队 0 分钟");
    expect(note!).toContain("会话等待 30 分钟");
  });

  test("节点没上报开始处理时刻：只说总计，不硬凑分子", () => {
    const note = busyElapsedNote("2026-10-27 13:54:48", null, "2026-10-27 20:46:57");
    expect(note!).toContain("实测总耗时 412 分钟");
    expect(note!).toContain("无法拆出排队与会话等待");
    expect(note!).not.toContain("会话等待 30");
  });

  test("时刻缺失或倒挂 ⇒ null（宁可不写，也不编一个负数）", () => {
    expect(busyElapsedNote(null, null, "2026-10-27 20:46:57")).toBeNull();
    expect(busyElapsedNote("2026-10-27 13:54:48", null, null)).toBeNull();
    expect(busyElapsedNote("2026-10-27 20:00:00", null, "2026-10-27 13:00:00")).toBeNull();
  });

  test("跨库：PG 可能给 Date / 毫秒数，不能静默失效", () => {
    const created = new Date(Date.now() - 412 * 60_000);
    const started = new Date(Date.now() - 30 * 60_000);
    const completed = new Date();
    const fromDates = busyElapsedNote(created, started, completed);
    expect(fromDates).toContain("排队 382 分钟");
    expect(fromDates).toContain("会话等待 30 分钟");

    const fromNumbers = busyElapsedNote(created.getTime(), started.getTime(), completed.getTime());
    expect(fromNumbers).toContain("排队 382 分钟");

    // 空串也要当「没有」，不能 parse 成 1970
    expect(busyElapsedNote("", "", "")).toBeNull();
  });
});

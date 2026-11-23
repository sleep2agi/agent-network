import { describe, expect, test } from "bun:test";
import { orphanNoticeText } from "./task-orphan-notice-text";

const row = { task_id: "idem_0d3d03d9a4d5bceba567716d6c675234dc8c96f8", to_name: "ANet负责人", status: "acked",
  node_status: "idle", content: "~/.anet/ 里面应该有有安装 OpenCodeV2 小微软测试鸽 那个" };

describe("the unanswered-message notice", () => {
  // The exact case from admin's screenshot (2026-11-23).
  test("a person gets one plain sentence about their own message", () => {
    const { title, text } = orphanNoticeText(row, 62, "user");
    expect(title).toBe("还没收到回复");
    expect(text).toBe("ANet负责人 还没有回复你 1 小时前的消息：「~/.anet/ 里面应该有有安装 OpenCodeV2 小微软测试鸽 那个」。可以再发一句催一下。");
    for (const internal of ["idem_", "acked", "idle", "cancel_task", "Hub", "Task ", "status"]) expect(text).not.toContain(internal);
    expect(text).not.toMatch(/[A-Za-z]{4,} [a-z]{3,} [a-z]{3,}/); // no English sentence
  });
  test("the wait reads the way people say it", () => {
    const wait = (m: number | null) => orphanNoticeText({ ...row, content: "" }, m, "user").text;
    expect(wait(25)).toBe("ANet负责人 还没有回复你 25 分钟前的消息。可以再发一句催一下。");
    expect(wait(60)).toContain("1 小时前");
    expect(wait(95)).toContain("1 小时 35 分钟前");
    expect(wait(125)).toContain("2 小时前");
    expect(wait(60 * 30 + 40)).toContain("30 小时前");
    expect(wait(null)).toBe("ANet负责人 还没有回复你的消息。可以再发一句催一下。");
  });
  test("a long message is cut and marked as cut", () => {
    const { text } = orphanNoticeText({ ...row, content: "很长的一句话".repeat(20) }, 70, "user");
    expect(text).toContain("…」");
    expect(text.length).toBeLessThan(120);
  });
  test("an agent still gets the task id, the status and the next step", () => {
    const { title, text } = orphanNoticeText(row, 62);
    expect(title).toBe("任务可能没人收尾");
    expect(text).toContain(row.task_id);
    expect(text).toContain("cancel_task");
    expect(orphanNoticeText(row, 62, "agent").text).toBe(text);
  });
});

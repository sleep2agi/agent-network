// 「排队」和「卡死」在用户眼里长得一样 —— 这个文件钉住让两者可区分的那句话。
import { describe, expect, test } from "bun:test";
import { queueNoticeText } from "./queue-notice";

describe("队列可见性", () => {
  test("前面 2 条 ⇒ 说清是 2 条", () => {
    expect(queueNoticeText(2)).toContain("前面还有 2 条");
  });

  test("前面 0 条或负数 ⇒ 不发（每句话都加提示就是噪声）", () => {
    expect(queueNoticeText(0)).toBe("");
    expect(queueNoticeText(-3)).toBe("");
    expect(queueNoticeText(Number.NaN)).toBe("");
  });

  test("小数向下取整（宁可少说一条，也不要报一个其实没有的位次）", () => {
    expect(queueNoticeText(2.9)).toContain("2 条");
  });

  test("文案要能让人做决定：说明可以继续发、不会丢", () => {
    const t = queueNoticeText(1);
    expect(t).toContain("不会丢");
    expect(t).toContain("轮到这条");
  });

  test("🔴 不许编一个预计时间（没人算得准，给了就是假承诺）", () => {
    for (const ahead of [1, 3, 10]) {
      const t = queueNoticeText(ahead);
      expect(t).not.toMatch(/预计|大约|秒|分钟/);
    }
  });
});

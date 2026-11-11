// reply-2000 —— chuqi 反馈「客户端消息末尾被截断」。
// 根因不是 Hub/客户端，而是节点把回执正文砍在 2000 字（四处 slice(0,2000)）。
// 判据：短文原样返回；长文不再砍到 2000，且截断时**留下可读标记**（不静默切句）。
import { describe, expect, test } from "bun:test";
import { capReplyText, REPLY_TEXT_MAX } from "./shared/reply-text-cap";

describe("capReplyText", () => {
  test("2000 字左右不再被截断（这是本次修复的直接判据）", () => {
    const s = "字".repeat(5000);
    expect(capReplyText(s)).toBe(s);
  });

  test("低于上限原样返回", () => {
    expect(capReplyText("ok")).toBe("ok");
    expect(capReplyText(undefined)).toBe("");
  });

  test("超过上限时保留前 N 字并标注总字数（不静默切句）", () => {
    const s = "a".repeat(REPLY_TEXT_MAX + 123);
    const out = capReplyText(s);
    expect(out.startsWith("a".repeat(REPLY_TEXT_MAX))).toBe(true);
    expect(out).toContain(`已截断到 ${REPLY_TEXT_MAX}`);
    expect(out).toContain(`共 ${s.length} 字`);
  });

  test("接线：cli.ts 里四处不再有 slice(0, 2000)", () => {
    const src = require("node:fs").readFileSync(require("node:path").join(import.meta.dir, "cli.ts"), "utf8");
    const mod = require("node:fs").readFileSync(require("node:path").join(import.meta.dir, "shared", "reply-text-cap.ts"), "utf8");
    void mod;
    expect(src.includes("slice(0, 2000)")).toBe(false);
    expect((src.match(/capReplyText\(/g) || []).length).toBeGreaterThanOrEqual(4);  // 四个回执站点
  });
});

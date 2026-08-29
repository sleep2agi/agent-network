import { describe, expect, test } from "bun:test";
import { redactTokens, redactMessageRow } from "./redact-tokens.js";

describe("#1459 ③ redact-at-read", () => {
  test("🔴 各种前缀形状都被遮住，且前缀保留（读者仍知道泄漏的是哪一类）", () => {
    const cases: Array<[string, string]> = [
      ["ntok_abcdef123456", "ntok_"],
      ["utok_abcdef123456", "utok_"],
      ["ghp_" + "A".repeat(24), "ghp_"],
      ["github_pat_" + "B".repeat(24), "github_pat_"],
      ["xoxb-1234567890-abcdef", "xoxb-"],
      ["sk-" + "C".repeat(20), "sk-"],
    ];
    for (const [raw, prefix] of cases) {
      const out = redactTokens(`before ${raw} after`);
      expect(out).toContain("***redacted***");
      expect(out).toContain(prefix);
      expect(out).not.toContain(raw);          // 原值一定不能整体幸存
      expect(out).toContain("before");         // 周围文本不受影响
      expect(out).toContain("after");
    }
  });

  test("🔴 保守：不像凭据的内容一个字都不能改", () => {
    for (const s of [
      "任务完成，磁盘 96%",
      "see https://example.com/a-b_c",
      "sk-",                       // 太短，不是凭据
      "ntok_",                     // 光前缀
      "the stock ticker is SKU-12",
    ]) {
      expect(redactTokens(s)).toBe(s);
    }
  });

  test("同一段里的多个 token 全部被遮", () => {
    const out = redactTokens(`a ntok_aaaaaaaaaa b sk-${"z".repeat(20)} c`);
    expect(out.match(/\*\*\*redacted\*\*\*/g)?.length).toBe(2);
  });

  test("redactMessageRow 只碰自由文本字段，不动结构字段", () => {
    const row = {
      message_id: "dm_ntok_looking_but_is_an_id",
      user_id: "u_1",
      content: "here is ntok_abcdef123456",
      title: "sk-" + "d".repeat(20),
      meta_json: JSON.stringify({ note: "ghp_" + "E".repeat(24) }),
      created_at: "2026-08-30 00:00:00",
    };
    const out = redactMessageRow(row);
    expect(out.content).toContain("***redacted***");
    expect(out.title).toContain("***redacted***");
    expect(out.meta_json).toContain("***redacted***");
    // 结构字段原样 —— 即便 message_id 里恰好有个像前缀的子串
    expect(out.message_id).toBe(row.message_id);
    expect(out.user_id).toBe(row.user_id);
    expect(out.created_at).toBe(row.created_at);
  });

  test("非字符串原样返回（null/数字不该被改成字符串）", () => {
    expect(redactTokens(null as any)).toBeNull();
    expect(redactTokens(42 as any)).toBe(42);
    expect(redactMessageRow({ content: null, title: 7 } as any)).toEqual({ content: null, title: 7 } as any);
  });
});

// 2016-10-31 —— 上游自由文本的日志脱敏契约。
//
// 判据（四条，对应四种已知泄露形态）：
//   ① 长度有上限（超出截断并注明原始长度）
//   ② 常见密钥前缀被打码
//   ③ Authorization 头里的凭据被打码
//   ④ URL 查询参数里的敏感值被打码；user:pass@host 里的凭据被打码
//
// 🔴 这是黑名单 ⇒ 它只降低概率，不消除泄露。真正消除要靠“不记自由文本”，
//    所以 name+code 那个摘要仍然是首选，本函数只用于“必须看原文才能排查”的场合。

import { describe, expect, test } from "bun:test";
import { redactUpstreamText } from "./redact-upstream-text";

describe("redactUpstreamText", () => {
  test("caps length and reports the original size (so truncation is visible, not silent)", () => {
    const out = redactUpstreamText("x".repeat(500));
    expect(out.length).toBeLessThanOrEqual(200 + 20);
    expect(out).toContain("500 chars");
  });

  test("masks common key prefixes but keeps the prefix readable for triage", () => {
    const out = redactUpstreamText("upstream said sk-abcdef123456 and ghp_zzzzzzzzzzzz");
    expect(out).not.toContain("sk-abcdef123456");
    expect(out).not.toContain("ghp_zzzzzzzzzzzz");
    expect(out).toContain("sk-***");
    expect(out).toContain("ghp_***");
  });

  test("masks bearer/basic credentials and URL query secrets", () => {
    const out = redactUpstreamText(
      "GET https://api.example.com/v1?token=supersecret&x=1 Authorization: Bearer abcdefghijklmnop",
    );
    expect(out).not.toContain("supersecret");
    expect(out).not.toContain("abcdefghijklmnop");
    expect(out).toContain("token=***");
    expect(out).toContain("Bearer ***");
    // 无关参数不该被误伤
    expect(out).toContain("x=1");
  });

  test("strips control characters so a client cannot forge extra log lines", () => {
    const out = redactUpstreamText("line1\nline2\r\n[error] forged\tby upstream");
    expect(out).not.toContain("\n");
    expect(out).not.toContain("\r");
    expect(out).not.toContain("\t");
  });

  // 🔴 密钥跨越截断边界：这一条防的是「先截断后打码」那个顺序错误。
  //    顺序写反时，前缀 `sk-` 还在、后半被切掉 ⇒ 正则匹配不上 ⇒ 密钥原样泄露，
  //    而样本短的时候测试全绿。所以这里刻意把密钥放在第 200 字节附近。
  test("a secret straddling the truncation boundary is still masked", () => {
    // 关键：把 `sk-` 放在**截断点附近**，使「先截断后打码」只剩 `sk-` + 极短尾巴
    // （< 6 个字符 ⇒ 正则的 {6,} 匹配不上 ⇒ 前缀原样泄露）。
    const pad = "x".repeat(195);
    const out = redactUpstreamText(`${pad} sk-abcdef1234567890 tail`);
    // 🔴 断言必须针对**前缀形态**，不能只断言“那个完整密钥不在”。
    //    因为在写反顺序时，截断已经把完整密钥切掉了 —— 断言会**空过**。
    // 只断言「没有未打码的前缀形态」。标记本身可能整体被退掉（截断点落在标记内），
    // 那是允许的 —— 允许“少几个字节”，不允许“留下半个前缀”。
    expect(out).not.toMatch(/sk-[A-Za-z0-9_-]/);
  });

  // 🔴 黑名单降低的那部分，恰好是「测试能想到的」那部分。
  //    所以必须有一条「匹配不到任何模式」的用例：它不证明安全，
  //    只证明**未匹配的原文也能安全落盘**（单行、有上限、控制字符被替换）。
  test("text matching no known pattern still lands safely (bounds, single line)", () => {
    const weird = `unknown credential format ${"Z".repeat(400)}`;
    const out = redactUpstreamText(weird);
    expect(out.length).toBeLessThanOrEqual(200 + 20);
    expect(out).not.toContain("\n");
    expect(out).toContain("chars)");
  });

  test("keeps a benign message readable — redaction must not make logs useless", () => {
    const msg = "provider returned 429 rate_limit_exceeded after 3 retries";
    expect(redactUpstreamText(msg)).toBe(msg);
  });
});

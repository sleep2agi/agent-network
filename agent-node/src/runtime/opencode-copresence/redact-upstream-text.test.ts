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

  test("keeps a benign message readable — redaction must not make logs useless", () => {
    const msg = "provider returned 429 rate_limit_exceeded after 3 retries";
    expect(redactUpstreamText(msg)).toBe(msg);
  });
});

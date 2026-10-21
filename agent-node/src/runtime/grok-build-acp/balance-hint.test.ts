// #1976 —— 402 额度耗尽在错误里要能一眼看出（#1941：账号没额度，界面上却是一串 JSON）。
import { describe, expect, test } from "bun:test";
import { formatJsonRpcErrorForTest } from "./client";

describe("grok ACP error text", () => {
  test("the 402 shape with http_status says the account is out of balance", () => {
    const text = formatJsonRpcErrorForTest({
      code: -32603,
      message: "Internal error",
      data: { message: "API error (status 402 Payment Required): Grok Build usage balance exhausted", http_status: 402 },
    });
    expect(text).toContain("402");
    expect(text).toContain("额度耗尽");
    expect(text).toContain("不是网络、模型或节点的问题");
  });

  test("the 402 shape as a plain message is recognised too", () => {
    const text = formatJsonRpcErrorForTest({
      code: -32603,
      message: "Internal error",
      data: "API error (status 402 Payment Required): Grok Build usage balance exhausted",
    });
    expect(text).toContain("额度耗尽");
  });

  test("the message-only shape is recognised", () => {
    const text = formatJsonRpcErrorForTest({
      code: -32603,
      message: "API error (status 402 Payment Required): Grok Build usage balance exhausted",
    });
    expect(text).toContain("额度耗尽");
  });

  test("an unrelated error is left alone (no invented advice)", () => {
    const text = formatJsonRpcErrorForTest({
      code: -32603,
      message: "Internal error",
      data: { message: "reqwest error stream: error sending request for url (https://cli-chat-proxy.grok.com/v1/responses)" },
    });
    expect(text).not.toContain("额度耗尽");
    expect(text).toContain("grok ACP error -32603");
  });

  test("a model mismatch is not mistaken for a balance problem", () => {
    const text = formatJsonRpcErrorForTest({
      code: -32603,
      message: "Grok ACP model check failed: configured model \"grok-4.7\" but the agent reports \"grok-4.6\"",
    });
    expect(text).not.toContain("额度耗尽");
  });
});

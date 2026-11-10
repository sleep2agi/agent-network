import { expect, test } from "bun:test";
import { runtimeErrorReplyText, UNVERIFIED_OWNER_MARKER } from "./unverified-reply-text";

test("#2824 空产出占位符时不说「以下是原文」", () => {
  const t = runtimeErrorReplyText("opencode", {
    message: "OpenCode reply was not owned by the submitted network message",
    ownershipReason: "another user message was delivered into this turn before it produced a final answer",
    unverifiedReplyText: "[opencode: assistant returned no reply]",
  });
  expect(t).not.toContain("以下是该轮实际产出的回答原文");
  expect(t).toContain("被人类插话打断");
  expect(t).toContain("请重派");
  expect(t).toContain(UNVERIFIED_OWNER_MARKER);
});

test("#2824 有真实正文时仍然把正文带出来（原行为不变）", () => {
  const t = runtimeErrorReplyText("opencode", {
    message: "not owned",
    unverifiedReplyText: "这是模型真正写出来的答案",
  });
  expect(t).toContain("以下是该轮实际产出的回答原文");
  expect(t).toContain("这是模型真正写出来的答案");
});

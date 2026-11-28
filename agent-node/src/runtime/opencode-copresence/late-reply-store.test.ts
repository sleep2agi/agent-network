import { expect, test } from "bun:test";
import { isStaleLateReplyRecord, LATE_REPLY_MAX_AGE_MS } from "./late-reply-store";

test("启动补发只补 24 小时内的记录：过期、没有时间的都算过期", () => {
  
  const now = Date.parse("2026-11-28T11:00:00Z");
  expect(isStaleLateReplyRecord({ armedAt: "2026-11-28T10:00:00Z" }, now)).toBe(false);
  expect(isStaleLateReplyRecord({ armedAt: "2026-11-16T17:33:27.895Z" }, now)).toBe(true);
  expect(isStaleLateReplyRecord({ armedAt: new Date(now - LATE_REPLY_MAX_AGE_MS - 1).toISOString() }, now)).toBe(true);
  expect(isStaleLateReplyRecord({ armedAt: "" }, now)).toBe(true);
  expect(isStaleLateReplyRecord({ armedAt: "not-a-date" }, now)).toBe(true);
});

import { describe, expect, test } from "bun:test";
import { inboxDeliveryPolicy } from "./inbox-message-policy";

describe("atomic peer reply inbox policy", () => {
  test("ordinary work still expects a response", () => {
    expect(inboxDeliveryPolicy("task")).toEqual({ deliverToRuntime: true, replyExpected: true });
    expect(inboxDeliveryPolicy("broadcast")).toEqual({ deliverToRuntime: true, replyExpected: true });
  });

  test("a peer reply is actionable but cannot start reply ping-pong", () => {
    expect(inboxDeliveryPolicy("reply")).toEqual({ deliverToRuntime: true, replyExpected: false });
  });

  test("plain informational messages retain ack-only behavior", () => {
    expect(inboxDeliveryPolicy("message")).toEqual({ deliverToRuntime: false, replyExpected: false });
  });
});

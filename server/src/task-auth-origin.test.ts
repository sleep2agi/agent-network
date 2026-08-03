import { describe, expect, test } from "bun:test";
import { stampTaskAuthOrigin } from "./task-auth-origin";

describe("stampTaskAuthOrigin", () => {
  test("server auth fact overrides a client-spoofed origin", () => {
    expect(stampTaskAuthOrigin({ source: "dashboard-chat", auth_origin: "user" }, "node")).toEqual({
      source: "dashboard-chat",
      auth_origin: "node",
    });
  });

  test("preserves existing metadata fields", () => {
    expect(stampTaskAuthOrigin({ client_request_id: "dreq_x", attachments: [] }, "user")).toEqual({
      client_request_id: "dreq_x",
      attachments: [],
      auth_origin: "user",
    });
  });

  test("does not manufacture metadata for old callers that supplied none", () => {
    expect(stampTaskAuthOrigin(undefined, "legacy")).toBeUndefined();
    expect(stampTaskAuthOrigin(null, "legacy")).toBeNull();
  });
});

import { describe, expect, test } from "bun:test";
import {
  clientRequestIdFromMeta,
  idempotentTaskId,
  idempotentTaskMatches,
  type StoredIdempotentTask,
} from "./task-idempotency.js";

describe("dashboard task idempotency", () => {
  test("accepts only bounded dashboard request ids", () => {
    expect(clientRequestIdFromMeta({ client_request_id: "dreq_0123456789abcdef" })).toBe("dreq_0123456789abcdef");
    expect(clientRequestIdFromMeta({ client_request_id: "short" })).toBeNull();
    expect(clientRequestIdFromMeta({ client_request_id: "dreq_bad space 0123456789" })).toBeNull();
    expect(clientRequestIdFromMeta(null)).toBeNull();
  });

  test("same caller scope and request id derive the same task id", () => {
    const a = idempotentTaskId("net_a", "admin", "dreq_0123456789abcdef");
    expect(idempotentTaskId("net_a", "admin", "dreq_0123456789abcdef")).toBe(a);
    expect(idempotentTaskId("net_b", "admin", "dreq_0123456789abcdef")).not.toBe(a);
    expect(idempotentTaskId("net_a", "other", "dreq_0123456789abcdef")).not.toBe(a);
    expect(a).toMatch(/^idem_[0-9a-f]{40}$/);
  });

  test("replay accepts semantically identical metadata regardless of key order", () => {
    const row: StoredIdempotentTask = {
      task_id: "idem_x", from_name: "admin", to_name: "worker", priority: "normal",
      content: "hello", network_id: "net_a", status: "delivered",
      meta_json: JSON.stringify({ client_request_id: "dreq_0123456789abcdef", attachments: [{ name: "a", file_id: "f1" }] }),
    };
    expect(idempotentTaskMatches(row, {
      fromName: "admin", toName: "worker", priority: "normal", content: "hello", networkId: "net_a",
      metaJson: JSON.stringify({ attachments: [{ file_id: "f1", name: "a" }], client_request_id: "dreq_0123456789abcdef" }),
    })).toBe(true);
  });

  test("same request id with changed payload is a conflict", () => {
    const row: StoredIdempotentTask = {
      task_id: "idem_x", from_name: "admin", to_name: "worker", priority: "normal",
      content: "hello", network_id: "net_a", status: "delivered",
      meta_json: JSON.stringify({ client_request_id: "dreq_0123456789abcdef" }),
    };
    expect(idempotentTaskMatches(row, {
      fromName: "admin", toName: "worker", priority: "normal", content: "changed", networkId: "net_a",
      metaJson: row.meta_json,
    })).toBe(false);
  });
});

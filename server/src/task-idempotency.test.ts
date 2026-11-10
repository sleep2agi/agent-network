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

  test("rolling upgrade ignores the new server-only auth stamp for replay equality", () => {
    const row: StoredIdempotentTask = {
      task_id: "idem_x", from_name: "admin", to_name: "worker", priority: "normal",
      content: "hello", network_id: "net_a", status: "delivered",
      meta_json: JSON.stringify({ client_request_id: "dreq_0123456789abcdef", source: "dashboard-chat" }),
    };
    expect(idempotentTaskMatches(row, {
      fromName: "admin", toName: "worker", priority: "normal", content: "hello", networkId: "net_a",
      metaJson: JSON.stringify({ client_request_id: "dreq_0123456789abcdef", source: "dashboard-chat", auth_origin: "user" }),
    })).toBe(true);
  });

  // #669 —— 回归：parent_source 是 Hub 派生的，不参与幂等比较。
  // 现场（test1210 抓到）：第一次调用可能没有可推断的父任务（meta 不带该字段），
  // 重放时上一条已 delivered ⇒ 推断命中 ⇒ meta 带上 parent_source:"inferred"，
  // 于是同一请求被判 idempotency_conflict。本地复现后修复（比较时排除该字段）。
  test("parent_source (Hub-derived) does not break replay equality", () => {
    const row: StoredIdempotentTask = {
      task_id: "idem_x", from_name: "admin", to_name: "worker", priority: "normal",
      content: "hello", network_id: "net_a", status: "delivered",
      meta_json: JSON.stringify({ client_request_id: "dreq_0123456789abcdef", parent_source: "inferred" }),
    };
    expect(idempotentTaskMatches(row, {
      fromName: "admin", toName: "worker", priority: "normal", content: "hello", networkId: "net_a",
      metaJson: JSON.stringify({ client_request_id: "dreq_0123456789abcdef" }),
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

import { beforeEach, describe, expect, test } from "bun:test";
import { requestSecretUi, pendingSecretRequests, clearSecretRequest, _resetForTest } from "./secret-request-ui.js";

beforeEach(_resetForTest);

describe("#4827 secret_request_ui 登记", () => {
  test("举手即 pending，且不返回值", () => {
    expect(requestSecretUi({ nodeId: "n1", key: "GITHUB_TOKEN", label: "GitHub 密钥", byNodeId: "n1" })).toEqual({ ok: true, pending: true });
    expect(pendingSecretRequests("n1")).toEqual([
      { key: "GITHUB_TOKEN", label: "GitHub 密钥", requested_at: expect.any(String), by_node_id: "n1" },
    ]);
  });

  test("没有待填 ⇒ 字段缺省（undefined，不是空数组）", () => {
    expect(pendingSecretRequests("n2")).toBeUndefined();
  });

  test("同 key 只保留最新一条", () => {
    requestSecretUi({ nodeId: "n1", key: "K", byNodeId: "n1", label: "旧" });
    requestSecretUi({ nodeId: "n1", key: "K", byNodeId: "n1", label: "新" });
    const p = pendingSecretRequests("n1")!;
    expect(p.length).toBe(1);
    expect(p[0].label).toBe("新");
  });

  test("用户提交后清掉对应举手", () => {
    requestSecretUi({ nodeId: "n1", key: "K", byNodeId: "n1" });
    clearSecretRequest("n1", "K");
    expect(pendingSecretRequests("n1")).toBeUndefined();
  });

  test("30 分钟后过期", () => {
    const t0 = Date.now();
    requestSecretUi({ nodeId: "n1", key: "K", byNodeId: "n1", now: t0 });
    expect(pendingSecretRequests("n1", t0 + 31 * 60 * 1000)).toBeUndefined();
  });

  test("空 key → key_required；超长 label → invalid_secret_input", () => {
    expect(requestSecretUi({ nodeId: "n1", key: "  ", byNodeId: "n1" })).toEqual({ ok: false, error: "key_required" });
    expect(requestSecretUi({ nodeId: "n1", key: "K", label: "x".repeat(81), byNodeId: "n1" })).toEqual({ ok: false, error: "invalid_secret_input" });
  });
});

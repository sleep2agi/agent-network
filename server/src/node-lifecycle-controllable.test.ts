import { describe, expect, test } from "bun:test";
import {
  childNodeIdForCreateRequest,
  buildControllableMap,
  isLifecycleControllable,
} from "./node-lifecycle-controllable.js";

// app#196 —— 桌面端对 218 个节点里的 207 个（95%）显示了「停止/重启/删除」，
// 而那三个工具的 schema 是 regex(/^node_[a-z0-9_-]+$/)，那 207 个是 n_ 开头，
// 点下去只会看到一段 zod 正则原文。
describe("childNodeIdForCreateRequest —— 推导规则", () => {
  test("cr_ 前缀 → node_ 前缀，其余部分逐字保留", () => {
    // 🔴 这一对是 2026-08-28 生产 hub 日志里真实的 create-node finalize 行，
    //    不是我按注释造的。
    expect(childNodeIdForCreateRequest("cr_59723b24-8372-4270-9b3c-1552e592a09f"))
      .toBe("node_59723b24-8372-4270-9b3c-1552e592a09f");
  });
  test("不是 cr_ 开头的一律 null —— 不猜、不截断", () => {
    expect(childNodeIdForCreateRequest("node_abc")).toBeNull();
    expect(childNodeIdForCreateRequest("n_abc")).toBeNull();
    expect(childNodeIdForCreateRequest("abc")).toBeNull();
    expect(childNodeIdForCreateRequest("cr_")).toBeNull();   // 只有前缀，没有主体
  });
  test("非字符串输入不抛，返回 null", () => {
    for (const v of [undefined, null, 123, {}, []]) {
      expect(childNodeIdForCreateRequest(v as any)).toBeNull();
    }
  });
});

describe("isLifecycleControllable —— 判据不是 id 前缀", () => {
  const map = buildControllableMap([
    { request_id: "cr_aaa", daemon_node_id: "node_daemon_x" },
    { request_id: "cr_bbb", daemon_node_id: "node_daemon_y" },
    { request_id: "not-a-request", daemon_node_id: "node_daemon_z" },  // 应被丢弃
  ]);

  test("有创建记录的 → 可控", () => {
    expect(isLifecycleControllable("node_aaa", null, map)).toBe(true);
    expect(map.get("node_aaa")).toBe("node_daemon_x");
  });

  test("🔴 光有 node_ 前缀但没有创建记录 → 不可控", () => {
    // 这条是本模块存在的理由：前缀是实现细节，不是判据。
    expect(isLifecycleControllable("node_never_created", null, map)).toBe(false);
  });

  test("手工起的 n_ 节点 → 不可控（那 207 个）", () => {
    expect(isLifecycleControllable("n_22b777bf", null, map)).toBe(false);
  });

  test("🔴 daemon 自己可控 —— 它在 node_create_requests 里没有记录", () => {
    // 漏掉这条会把 3 个 daemon 从可控名单里误删。
    expect(isLifecycleControllable("node_daemon_39bd1eeae3ee", "host_supervisor", map)).toBe(true);
    // 正控：同一个 id 但 role 不是 host_supervisor ⇒ 仍不可控，
    // 证明上面那条过是因为 role，不是因为 id 恰好带 node_ 前缀。
    expect(isLifecycleControllable("node_daemon_39bd1eeae3ee", null, map)).toBe(false);
  });

  test("坏的 request_id 不会污染映射", () => {
    expect(map.has("node_not-a-request")).toBe(false);
    expect(map.size).toBe(2);
  });
});

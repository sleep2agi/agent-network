// 请求级 memo（request-memo.ts）的最小断言：同请求内算一次，跨请求清空。
import { describe, expect, test } from "bun:test";
import { memoRequest, requestMemoKeysForTests, resetRequestMemo } from "./request-memo.js";

describe("request-memo", () => {
  test("同一请求内只算一次", () => {
    const owner = {};
    let calls = 0;
    const compute = () => { calls++; return { v: calls }; };
    expect(memoRequest(owner, "k", compute)).toEqual({ v: 1 });
    expect(memoRequest(owner, "k", compute)).toEqual({ v: 1 });
    expect(calls).toBe(1);
    expect(requestMemoKeysForTests(owner)).toEqual(["k"]);
  });

  test("跨请求清空：值必须重新算（复用池不许残留权限/身份快照）", () => {
    const owner = {};
    let calls = 0;
    const compute = () => { calls++; return calls; };
    expect(memoRequest(owner, "n", compute)).toBe(1);
    resetRequestMemo(owner);
    expect(requestMemoKeysForTests(owner)).toEqual([]);
    expect(memoRequest(owner, "n", compute)).toBe(2);
  });

  test("不同 owner 互不影响", () => {
    const a = {}, b = {};
    memoRequest(a, "k", () => "a");
    expect(memoRequest(b, "k", () => "b")).toBe("b");
    expect(memoRequest(a, "k", () => "x")).toBe("a");
  });
});

test("调用方 IP 每个请求单独设置，不跨请求残留，也不进复用池的键", async () => {
  const { setRequestClientIP, requestClientIP, resetRequestMemo } = await import("./request-memo.js");
  const { CREATE_SERVER_FIELDS, poolKeyOf } = await import("./server.js");
  const owner = {};
  resetRequestMemo(owner); setRequestClientIP(owner, "10.0.0.1");
  expect(requestClientIP(owner)).toBe("10.0.0.1");
  resetRequestMemo(owner); setRequestClientIP(owner, "10.0.0.2");
  expect(requestClientIP(owner)).toBe("10.0.0.2");
  // 同一身份、不同 IP ⇒ 同一个池子键（能复用同一台实例）
  expect((CREATE_SERVER_FIELDS as readonly string[]).includes("clientIP")).toBe(false);
  const id = { enforceNetworkId: "net", enforceUserId: null, callerAlias: "n", callerTokenIsNetwork: true, callerTokenId: "t", includeProtocolTools: false, callerIdentityRejected: false };
  expect(poolKeyOf({ ...id, clientIP: "1.1.1.1" } as any)).toBe(poolKeyOf({ ...id, clientIP: "2.2.2.2" } as any));
});

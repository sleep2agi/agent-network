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

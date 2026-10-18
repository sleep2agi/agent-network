import { describe, test, beforeEach } from "bun:test";

// 🔴 见证 #3（#1309 评审第 ④ 条）：**钩子声明的超时只存在于源码**。
//    失败记录行给的是**测试名** + 它**用满**的那个超时（6000.02ms），
//    下一行的消息 `a beforeEach/afterEach hook timed out for this test.`
//    里**没有数字**。所以分母只能是那个 ms（⇒ 100%），
//    拿测试自己的默认（5000ms）去算会把它报成 120%。
describe("hook control", () => {
  beforeEach(async () => {
    await new Promise(() => {});
  }, 6_000);

  test("body passes", () => {});
});

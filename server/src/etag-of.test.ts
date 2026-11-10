// 2026-10-31 —— ETag 函数的两个方向。
//
// 只测「内容变 ⇒ ETag 变」是不够的：那一条挡的是「退化得更松」（按长度、按份数、按前缀）。
// 还要一条「内容不变 ⇒ ETag 不变」，它挡的是「退化得更严」（改成随机数、加时间戳、加自增）——
// 后者会让每个响应都「变了」，304 永远不命中，而现象是「客户端还是能收到 200」，没人会报错。
//
// ⚠️ 口径（2026-10-31 自查后修正）：本文件共 5 条断言，但**独立维度只有 4 个** ——
//    「只差末位」与「只差首位」同属「内容差」这一维，它们不是两种独立输入。
//    所以对外只说「4 个维度」，不说「5 种输入」：断言数好数，独立输入数要靠「删掉一个维度是否仍有覆盖」来判。
//
// 差异的位置也有讲究：必须有一条把差异放在**最后一个字符**，
// 因为任何截断式比较（前缀 / 前 N 位 hash）在差异靠后时仍然判等。
import { describe, expect, test } from "bun:test";
import { etagOf } from "./status-read-cache.js";

describe("etagOf: 两个方向 + 差异位置", () => {
  test("内容不变 ⇒ ETag 不变（纯函数；否则 304 永远不命中）", () => {
    const body = JSON.stringify({ sessions: [{ alias: "a" }], n: 1 });
    expect(etagOf(body)).toBe(etagOf(body));
    // 逐字节相同的两个字符串（构造方式不同）也必须同值
    expect(etagOf("x" + "y")).toBe(etagOf("xy"));
  });

  test("只差**最后一个字符** ⇒ ETag 必须不同（挡前缀 / 短 hash 比较）", () => {
    const a = `{"sessions":[{"alias":"node-a"}],"total":10}`;
    const b = `{"sessions":[{"alias":"node-b"}],"total":11}`; // 长度相同、末位不同
    expect(a.length).toBe(b.length);
    expect(a.slice(0, -1)).not.toBe(b.slice(0, -1)); // 中部也有差，先声明
    expect(etagOf(a)).not.toBe(etagOf(b));
    // 更严格的一条：**只有**最后一个字符不同。
    // ⚠️ 我第一版写成 `{"x":"aaaaaaa1"}` vs `{"x":"aaaaaaa2"}` —— 那是倒数第二个字符不同
    //    （最后一个是 `}`），而 `slice(0,-1)` 当场把这件事说出来。断言写的是「只差末位」，
    //    样本却不是「只差末位」—— 这类样本错误比断言错误更难发现，因为它照样是绿的。
    const c = "aaaaaaa1";
    const d = "aaaaaaa2";
    expect(c.slice(0, -1)).toBe(d.slice(0, -1));
    expect(etagOf(c)).not.toBe(etagOf(d));
  });

  test("只差第一个字符 ⇒ ETag 也必须不同（方向对称，防「只比后缀」）", () => {
    expect(etagOf("1abcdefg")).not.toBe(etagOf("2abcdefg"));
  });

  test("长度写进 ETag 不该让「同长度不同内容」判等", () => {
    const a = "abcdefgh";
    const b = "abcdefgi";
    expect(a.length).toBe(b.length);
    expect(etagOf(a)).not.toBe(etagOf(b));
    // 反向：相同内容、不同长度 ⇒ 必然不同（长度是 ETag 的一部分，这是有意的）
    expect(etagOf("ab")).not.toBe(etagOf("ab "));
  });

  test("形状：带引号的强 ETag（If-None-Match 才能按原样回送）", () => {
    expect(etagOf("{}")).toMatch(/^"s-[0-9a-z]+-[0-9a-z]+"$/);
    expect(etagOf("")).toMatch(/^"s-[0-9a-z]+-0"$/);
  });
});

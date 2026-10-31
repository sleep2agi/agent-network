// 2026-10-31 —— 「设了空」与「没设」是两件事。
//
// 起因（外部复核）：`'TMAICLOUD_PUBLIC_ORIGIN' in process.env` 才能区分「设了空」与「没设」，
// 而 `if (process.env.X)` 把两者都判假。
//
// 在本仓的落点：COMMHUB_CORS_ORIGINS。
//   · 未设        ⇒ 开发默认（localhost 两个端口）
//   · 设了但为空  ⇒ **空清单**（谁都不许）
// 如果两者都判假并回退默认，那么运维写 `COMMHUB_CORS_ORIGINS=`（想「一个都不许」）
// 得到的却是「放行 localhost」—— 空落到了**更松**的一侧。
//
// 判据：写一个允许清单的默认值之前，先写出它的**最松值**。
//       这里最松值不是空（空 = 谁都不许 = 最严），而是 `*`。所以空绝不能被读成「用默认」。
import { describe, expect, test } from "bun:test";
import { normalizeOrigin, parseCorsOrigins } from "./server.js";

describe("parseCorsOrigins: 未设 / 设空 / 设值 三态", () => {
  test("未设 ⇒ 开发默认（localhost 两个端口）", () => {
    expect(parseCorsOrigins(undefined)).toEqual(["http://localhost:3000", "http://localhost:3001"]);
  });

  test("设了但为空 ⇒ 空清单（谁都不许），**不回退默认**", () => {
    expect(parseCorsOrigins("")).toEqual([]);
    // 只写了分隔符 / 空白也是空清单，而不是"默认"
    expect(parseCorsOrigins(",")).toEqual([]);
    expect(parseCorsOrigins("  ,  ")).toEqual([]);
  });

  test("设了值 ⇒ 逐条 trim，空条目被丢掉（不许出现空字符串条目）", () => {
    expect(parseCorsOrigins(" https://a.example , https://b.example ")).toEqual(["https://a.example", "https://b.example"]);
    expect(parseCorsOrigins("https://a.example,")).toEqual(["https://a.example"]);
  });

  // 2026-10-31 —— **语义变更（更严）**：非法条目现在被丢弃，而不是原样保留。
  // 旧实现保留 "*"，于是运行期 `includes(origin)` 永远不命中 ——
  // 「保留一条永不匹配的项」与「丢弃它」在行为上相同，但前者会让运维以为已经放行。
  test("非法条目被丢弃（'*' / 裸主机名 / 非 http(s)）", () => {
    expect(parseCorsOrigins("*")).toEqual([]);
    expect(parseCorsOrigins("a.example")).toEqual([]);
    expect(parseCorsOrigins("ftp://a.example")).toEqual([]);
    expect(parseCorsOrigins(undefined)).not.toContain("*");
  });

  // 外部复核 ①：`https://host` 与 `https://host:443` 在字符串上不等、在 origin 上相等。
  test("默认端口与大小写被规范化 —— 字符串比较会在这里判不同", () => {
    expect(normalizeOrigin("https://A.Example:443")).toBe("https://a.example");
    expect(normalizeOrigin("https://a.example")).toBe("https://a.example");
    expect(normalizeOrigin("http://a.example:80")).toBe("http://a.example");
    expect(normalizeOrigin("https://a.example:8443")).toBe("https://a.example:8443");
    expect(normalizeOrigin("https://a.example/")).toBe("https://a.example");
    // 清单写成带默认端口 ⇒ 规范化后与不带端口的请求相等（这正是那批「地址栏正常却全 403」的用户）
    expect(parseCorsOrigins("https://a.example:443")).toEqual(["https://a.example"]);
    // 去重：同一 origin 的两种写法只留一条
    expect(parseCorsOrigins("https://a.example,https://a.example:443/")).toEqual(["https://a.example"]);
  });
});

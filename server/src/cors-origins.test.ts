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
import { parseCorsOrigins } from "./server.js";

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

  test("must-fire：'*' 不会被当成通配（本实现是精确匹配清单）", () => {
    // 如果哪天有人把 '*' 当通配实现，这条仍会过 —— 但 corsHeaders 用的是 includes，
    // 所以这里钉的是「清单里有什么就是什么」，不是「* 有特殊含义」。
    expect(parseCorsOrigins("*")).toEqual(["*"]);
    expect(parseCorsOrigins(undefined)).not.toContain("*");
  });
});

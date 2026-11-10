// 2026-10-31 —— license 三态契约。
//
// 四条断言对应四种输入，第四种（查询失败）在旧实现里会直接 500 掉整个 /health：
//   known  : 有行且有 type
//   absent : 查询成功、无行
//   unknown: 有行但 type 空（数据不全）—— 修法与 absent 不同
//   unknown: 查询失败 —— 修法与 absent 不同，且**不许拖垮 /health**

import { describe, expect, test } from "bun:test";
import { legacyLicenseField, licenseStateOf } from "./license-state";

describe("licenseStateOf", () => {
  test("known: a row with a non-empty type", () => {
    expect(licenseStateOf({ type: "pro" })).toEqual({ kind: "known", type: "pro" });
    expect(licenseStateOf({ type: "  team  " })).toEqual({ kind: "known", type: "team" });
  });

  test("absent: query succeeded and there is no row", () => {
    expect(licenseStateOf(null)).toEqual({ kind: "absent" });
    expect(licenseStateOf(undefined)).toEqual({ kind: "absent" });
  });

  test("unknown(row_without_type): a row exists but the type is empty — different fix from absent", () => {
    expect(licenseStateOf({ type: "" })).toEqual({ kind: "unknown", reason: "license_row_without_type" });
    expect(licenseStateOf({ type: "   " })).toEqual({ kind: "unknown", reason: "license_row_without_type" });
    expect(licenseStateOf({})).toEqual({ kind: "unknown", reason: "license_row_without_type" });
    expect(licenseStateOf({ type: 42 })).toEqual({ kind: "unknown", reason: "license_row_without_type" });
  });

  test("unknown(query_failed) wins over the row — a failed query tells us nothing about the row", () => {
    expect(licenseStateOf({ type: "pro" }, true)).toEqual({ kind: "unknown", reason: "license_query_failed" });
    expect(licenseStateOf(null, true)).toEqual({ kind: "unknown", reason: "license_query_failed" });
  });

  test("the three states are mutually exclusive — no input yields two of them", () => {
    const kinds = new Set([
      licenseStateOf({ type: "pro" }).kind,
      licenseStateOf(null).kind,
      licenseStateOf({ type: "" }).kind,
      licenseStateOf(null, true).kind,
    ]);
    // known / absent / unknown —— 只有三种 kind，且 unknown 有两条不同 reason
    expect([...kinds].sort()).toEqual(["absent", "known", "unknown"]);
  });
});

describe("legacyLicenseField", () => {
  test("stays byte-identical to the old expression for every input", () => {
    expect(legacyLicenseField({ type: "pro" })).toBe("pro");
    expect(legacyLicenseField({ type: "" })).toBe("none");
    expect(legacyLicenseField({})).toBe("none");
    expect(legacyLicenseField(null)).toBe("none");
    // 非字符串 type 旧实现也回 "none"（`license?.type || "none"` 的真值语义）
    expect(legacyLicenseField({ type: 0 as unknown })).toBe("none");
  });
});

// 2026-11-01 —— 值域 == 生产者集合，**用穷举**而不是用声明。
//
// `LicenseState` 是一个联合类型：它声明了 {known, absent, unknown} 与两个 reason。
// 声明本身不会红 —— 有人加了第四个分支（例如 expired）而忘了改类型时，
// TypeScript 会红，但**改类型而不加分支**（往联合里加一个没人产生的成员）不会红，
// 于是「值域里有它、但没人会产生它」这一格没有任何断言。
//
// 这里的域是有限的（failed × 5 种 row）⇒ 可以穷举：
//   ① 产生的 kind 集合 == 声明的 kind 集合
//   ② 产生的 reason 集合 == 声明的 reason 集合
//   ③ 每个输入恰好落在一格里（互斥）
describe("值域 == 生产者集合（穷举有限域）", () => {
  const ROWS: unknown[] = [
    null, undefined, {}, { type: "" }, { type: "   " }, { type: 42 }, { type: "pro" }, { type: " team " },
  ];
  const OUT = ROWS.flatMap((r) => [false, true].map((failed) => licenseStateOf(r as any, failed)));

  test("① kind 集合恰好是 known / absent / unknown 三个", () => {
    expect([...new Set(OUT.map((o) => o.kind))].sort()).toEqual(["absent", "known", "unknown"]);
  });

  test("② reason 集合恰好是两个（多一个 ⇒ 有值没有生产者；少一个 ⇒ 有生产者没有值）", () => {
    const reasons = OUT.flatMap((o) => (o.kind === "unknown" ? [o.reason] : [])).sort();
    expect([...new Set(reasons)]).toEqual(["license_query_failed", "license_row_without_type"]);
  });

  // ④ 声明的值域 vs 产生的值域：只比「产生的」抓不到「声明了但没人产生」。
  // 这一条读源码里的联合类型字面量，与上面 ② 的产出集合对账。
  test("④ 类型里声明的 reason 集合 == 实际产出的集合（无声明无生产者）", async () => {
    const { licenseStateOf: fn } = await import("./license-state.js");
    const src = (await import("node:fs")).readFileSync(new URL("./license-state.ts", import.meta.url), "utf8");
    // 注意结尾：联合类型的**最后一个**成员后面是 ` }` 而不是 `|`，
    // 只写 `(?=\||;)` 会漏掉它 —— 而漏掉的那一个正好是「最后加进去的那个」，
    // 也就是这条断言最该抓到的那一个。
    const declared = [...src.matchAll(/"([a-z_]+)"\s*(?=[|;}])/g)].map((m) => m[1])
      .filter((x) => x.startsWith("license_"));
    const produced = [...new Set(OUT.flatMap((o) => (o.kind === "unknown" ? [o.reason] : [])))].sort();
    expect([...new Set(declared)].sort()).toEqual(produced);
    expect(typeof fn).toBe("function");
  });

  test("③ 每个输入恰好落在一格里（互斥，不重叠）", () => {
    for (const o of OUT) {
      const hits = [o.kind === "known", o.kind === "absent", o.kind === "unknown"].filter(Boolean).length;
      expect(hits).toBe(1);
    }
  });
});

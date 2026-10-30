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

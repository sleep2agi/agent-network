// admin 2026-11-15 —— 节点职责介绍:边界校验 + 状态列表里的一行摘要。纯函数,不起服务。
import { describe, expect, test } from "bun:test";
import { MAX_DESCRIPTION_LEN, descriptionSummary, validateDescription } from "./node-attrs-validate.js";

describe("validateDescription", () => {
  test("undefined / null / blank → clear (null)", () => {
    expect(validateDescription(undefined)).toEqual({ ok: true, value: null });
    expect(validateDescription(null)).toEqual({ ok: true, value: null });
    expect(validateDescription(" \n\t ")).toEqual({ ok: true, value: null });
  });
  test("non-string is rejected, never coerced", () => {
    expect(validateDescription(42).ok).toBe(false);
    expect(validateDescription(["a"]).ok).toBe(false);
  });
  test("keeps newlines, normalises CRLF, strips other control chars, trims line ends, folds 3+ blank lines", () => {
    const r = validateDescription("第一行  \r\n第二\u0007行\n\n\n\n第三行");
    expect(r).toEqual({ ok: true, value: "第一行\n第二 行\n\n第三行" });
  });
  test("length cap counts code points, not UTF-16 units", () => {
    expect(validateDescription("😀".repeat(MAX_DESCRIPTION_LEN)).ok).toBe(true);
    expect(validateDescription("😀".repeat(MAX_DESCRIPTION_LEN + 1)).ok).toBe(false);
  });
});

describe("descriptionSummary", () => {
  test("first non-empty line, capped with an ellipsis", () => {
    expect(descriptionSummary("\n\n  负责发版  \n其余")).toBe("负责发版");
    expect(descriptionSummary("字".repeat(200), 10)).toBe(`${"字".repeat(9)}…`);
  });
  test("nothing written → null (the key is omitted from get_all_status rows)", () => {
    expect(descriptionSummary(null)).toBeNull();
    expect(descriptionSummary("   \n  ")).toBeNull();
  });
});

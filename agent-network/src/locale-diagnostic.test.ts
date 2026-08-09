import { describe, expect, test } from "bun:test";
import { diagnoseLocale, formatLocaleSource } from "./locale-diagnostic";

describe("#68 locale diagnostic", () => {
  test("LC_ALL overrides an otherwise UTF-8 LANG", () => {
    expect(diagnoseLocale({ LANG: "en_US.UTF-8", LC_ALL: "C" }, "linux")).toEqual({
      effectiveVariable: "LC_ALL",
      effectiveValue: "C",
      shouldWarn: true,
    });
  });

  test("LC_CTYPE overrides LANG when LC_ALL is empty", () => {
    expect(diagnoseLocale({ LANG: "C", LC_ALL: "", LC_CTYPE: "zh_CN.UTF-8" }, "linux")).toEqual({
      effectiveVariable: "LC_CTYPE",
      effectiveValue: "zh_CN.UTF-8",
      shouldWarn: false,
    });
  });

  test("accepts common UTF-8 spellings", () => {
    for (const value of ["C.UTF-8", "en_US.utf8", "zh_CN.UTF8"]) {
      expect(diagnoseLocale({ LANG: value }, "linux").shouldWarn).toBe(false);
    }
  });

  test("warns for POSIX, C, non-UTF-8, and unset locale", () => {
    for (const env of [{ LANG: "POSIX" }, { LANG: "C" }, { LANG: "en_US.ISO-8859-1" }, {}]) {
      expect(diagnoseLocale(env, "linux").shouldWarn).toBe(true);
    }
  });

  test("does not prescribe POSIX locale variables on Windows", () => {
    expect(diagnoseLocale({}, "win32")).toEqual({
      effectiveVariable: null,
      effectiveValue: null,
      shouldWarn: false,
    });
  });

  test("renders locale values without terminal control or unbounded output", () => {
    const diagnostic = diagnoseLocale({ LC_ALL: `C\n\u001b[31m${"x".repeat(200)}` }, "linux");
    const rendered = formatLocaleSource(diagnostic);
    expect(rendered).toStartWith("LC_ALL=C??[31m");
    expect(rendered).not.toContain("\n");
    expect(rendered).not.toContain("\u001b");
    expect(rendered.length).toBeLessThanOrEqual(7 + 128);
  });
});

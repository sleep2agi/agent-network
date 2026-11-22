// #5123 档位持久化：只在 applied 后写回；启动恢复只决定「试不试」
import { describe, expect, test } from "bun:test";
import { shouldPersistVariant, startupVariantPlan, persistVariantToConfig, isValidVariantId } from "./variant-persist.js";

describe("#5123 variant persist", () => {
  test("只有 applied 才允许写回；unknown/rejected 一律不写", () => {
    expect(shouldPersistVariant("applied", "high")).toBe(true);
    expect(shouldPersistVariant("applied", null)).toBe(true);          // 显式回到默认档
    expect(shouldPersistVariant("unknown", "high")).toBe(false);
    expect(shouldPersistVariant("rejected", "high")).toBe(false);
    expect(shouldPersistVariant("applied", "bad variant!")).toBe(false);
  });

  test("启动恢复三态：capable=false 跳过；值相同 noop；不同 apply", () => {
    expect(startupVariantPlan("high", "high", true)).toBe("noop");
    expect(startupVariantPlan("high", "default", true)).toBe("apply");
    expect(startupVariantPlan("high", undefined, true)).toBe("apply");
    expect(startupVariantPlan("high", null, true)).toBe("apply");
    expect(startupVariantPlan("high", "low", false)).toBe("skip-unsupported");
    expect(startupVariantPlan(undefined, "high", true)).toBe("noop");
    expect(startupVariantPlan("bad variant!", "low", true)).toBe("noop");  // 脏配置不动会话
  });

  test("写回是原子替换：先写 tmp 再 rename", () => {
    const events: string[] = [];
    const ok = persistVariantToConfig("/cfg.json", "high", {
      readConfig: () => JSON.stringify({ alias: "n1", model: "a/b" }),
      writeConfig: (p, c) => { events.push(`write:${p}`); expect(JSON.parse(c).modelVariant).toBe("high"); },
      rename: (from, to) => { events.push(`rename:${from}->${to}`); },
      warn: () => {},
    });
    expect(ok).toBe(true);
    expect(events[0]).toContain(".variant-");
    expect(events[1]).toContain("->/cfg.json");
  });

  test("variant=null 时删除该键（回到默认档），不是写 null", () => {
    let written = "";
    persistVariantToConfig("/cfg.json", null, {
      readConfig: () => JSON.stringify({ alias: "n1", modelVariant: "high" }),
      writeConfig: (_p, c) => { written = c; },
      rename: () => {},
      warn: () => {},
    });
    expect(JSON.parse(written).modelVariant).toBeUndefined();
  });

  test("读配置失败只 warn，不抛（切换成功不应被写回失败连坐）", () => {
    const warns: string[] = [];
    const ok = persistVariantToConfig("/cfg.json", "high", {
      readConfig: () => { throw new Error("EACCES"); },
      warn: (m) => warns.push(m),
    });
    expect(ok).toBe(false);
    expect(warns.join(" ")).toContain("writeback failed");
  });

  test("variant id 形状与写入校验一致", () => {
    expect(isValidVariantId("high")).toBe(true);
    expect(isValidVariantId("a_b-1.2")).toBe(true);
    expect(isValidVariantId("x".repeat(41))).toBe(false);
    expect(isValidVariantId("has space")).toBe(false);
    expect(isValidVariantId(42)).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import { applyVariantConfig } from "./variant-config-apply";
import { validateLocalPatch, computeApplyMode } from "../config-apply";

test("variant patch is hot, validated and never conflated with restart", () => {
  expect(validateLocalPatch({ modelVariant: null }, { runtime: "opencode" })).toBeNull();
  expect(validateLocalPatch({ modelVariant: "bad value" }, { runtime: "opencode" })?.field).toBe("modelVariant");
  expect(computeApplyMode({ modelVariant: null })).toBe("hot");
  expect(computeApplyMode({})).toBe("restart_only");
});

test("same-model variants and explicit clear use exact bound session", async () => {
  const calls: unknown[] = [];
  const session = { isRunning: true, sessionId: "ses_a", selectedSessionModel: async () => ({ providerID: "p", id: "m", variant: "old" }),
    selectSessionModel: async (id: string, model: any) => { calls.push([id, model]); return { status: "applied" as const, model }; } };
  expect((await applyVariantConfig(session, { modelVariant: "new" })).status).toBe("applied");
  expect((await applyVariantConfig(session, { modelVariant: null })).status).toBe("applied");
  expect(calls).toEqual([["ses_a", { providerID: "p", id: "m", variant: "new" }], ["ses_a", { providerID: "p", id: "m" }]]);
});

test("old capability, scope, busy, and ambiguous writes fail closed", async () => {
  expect(await applyVariantConfig(undefined, { modelVariant: "x" })).toEqual({ status: "rejected", reason: "unsupported" });
  const session = { isRunning: true, sessionId: "ses_a", selectedSessionModel: async () => ({ providerID: "p", id: "m" }),
    selectSessionModel: async () => ({ status: "rejected" as const, reason: "busy" as const }) };
  expect(await applyVariantConfig(session, { modelVariant: "x" })).toEqual({ status: "rejected", reason: "busy" });
  expect(await applyVariantConfig({ ...session, selectedSessionModel: async () => undefined }, { modelVariant: "x" })).toEqual({ status: "rejected", reason: "scope" });
  expect(await applyVariantConfig({ ...session, selectSessionModel: async () => { throw Error("timeout"); } }, { modelVariant: "x" })).toEqual({ status: "unknown" });
});


// Stock (non-test) builds have no atomic idle lease shared with the human TUI, so they
// use the narrower setSelectedVariant writer. These pin its contract: refuse while one
// of our turns is in flight, apply with the real readback, and never report "applied"
// for a write that did not take effect.
describe("applyVariantConfig — stock-build writer", () => {
  const session = (overrides: Record<string, unknown> = {}) => ({
    isRunning: true,
    sessionId: "ses_prod",
    setSelectedVariant: async (variant: string | null) => ({ providerID: "deepseek", id: "deepseek-flash",
      ...(variant === null ? {} : { variant }) }),
    ...overrides,
  });

  test("applies and returns the real readback selection", async () => {
    expect(await applyVariantConfig(session() as any, { modelVariant: "high" }))
      .toEqual({ status: "applied", model: { providerID: "deepseek", id: "deepseek-flash", variant: "high" } });
  });
  test("in-flight turn is rejected as busy", async () => {
    // #4414 之后 busy 会带 detail（判据原文）。这里盯的是 status/reason 不变，
    // 原文由下面那条用例单独断言 —— 别把两件事揉进一个 toEqual。
    const result = await applyVariantConfig(session({ setSelectedVariant: async () => { throw new Error("variant_busy"); } }) as any, { modelVariant: "high" });
    expect(result.status).toBe("rejected");
    expect((result as any).reason).toBe("busy");
    expect((result as any).detail).toBe("variant_busy");
  });
  test("readback mismatch is unknown, never applied", async () => {
    expect(await applyVariantConfig(session({ setSelectedVariant: async () => { throw new Error("variant did not change"); } }) as any, { modelVariant: "high" }))
      .toEqual({ status: "unknown" });
  });
  test("model+variant in one patch stays unsupported on stock builds", async () => {
    expect(await applyVariantConfig(session() as any, { model: "deepseek/deepseek-flash", modelVariant: "high" }))
      .toEqual({ status: "rejected", reason: "unsupported" });
  });
});


// The bug this pins: `applyVariantConfig` used to pick its path by asking whether the
// controller methods EXIST. On a stock build they do (the test-build controller provides
// them) and only deny when called, so the idle-gated writer was never reached and every
// variant write came back `variant_unsupported`.
describe("applyVariantConfig — stock build keeps the controller methods but they deny", () => {
  test("falls through to the idle-gated writer instead of reporting unsupported", async () => {
    const calls: string[] = [];
    const session = {
      isRunning: true,
      sessionId: "ses_stock",
      variantConfigTestOwned: false,
      // present, exactly like a stock build - and they answer unsupported
      selectedSessionModel: async () => { calls.push("controller-read"); return { providerID: "deepseek", id: "deepseek-flash" }; },
      selectSessionModel: async () => { calls.push("controller-write"); return { status: "rejected" as const, reason: "unsupported" as const }; },
      setSelectedVariant: async (variant: string | null) => { calls.push("stock-write"); return { providerID: "deepseek", id: "deepseek-flash", ...(variant === null ? {} : { variant }) }; },
    };
    const result = await applyVariantConfig(session as any, { modelVariant: "low" });
    expect(result).toEqual({ status: "applied", model: { providerID: "deepseek", id: "deepseek-flash", variant: "low" } });
    expect(calls).toEqual(["stock-write"]);
  });

  test("test build still uses the identity-pinned controller", async () => {
    const calls: string[] = [];
    const session = {
      isRunning: true,
      sessionId: "ses_test",
      variantConfigTestOwned: true,
      selectedSessionModel: async () => { calls.push("controller-read"); return { providerID: "deepseek", id: "deepseek-flash" }; },
      selectSessionModel: async () => { calls.push("controller-write"); return { status: "applied" as const, model: { providerID: "deepseek", id: "deepseek-flash", variant: "low" } }; },
      setSelectedVariant: async () => { calls.push("stock-write"); throw new Error("must not be used on a test build"); },
    };
    const result = await applyVariantConfig(session as any, { modelVariant: "low" });
    expect(result.status).toBe("applied");
    expect(calls).toEqual(["controller-read", "controller-write"]);
  });
});


// #4414：拒绝时不能只剩枚举。Hub 的 last_update.error 存的正是这个字符串，
// 丢掉 in_flight / turn_age_ms 之后，「恰好有一轮在飞」和「计数器卡死」不可分。
describe("applyVariantConfig — rejection evidence", () => {
  test("keeps the busy detail instead of only the enum", async () => {
    const session = {
      isRunning: true,
      sessionId: "ses_busy",
      variantConfigTestOwned: false,
      setSelectedVariant: async () => { throw new Error("variant_busy (in_flight=1, turn_age_ms=42000)"); },
    };
    const result = await applyVariantConfig(session as any, { modelVariant: "low" });
    expect(result.status).toBe("rejected");
    expect((result as any).reason).toBe("busy");
    expect((result as any).detail).toContain("in_flight=1");
    expect((result as any).detail).toContain("turn_age_ms=42000");
  });
});

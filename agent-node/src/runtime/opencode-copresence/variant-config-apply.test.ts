import { expect, test } from "bun:test";
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

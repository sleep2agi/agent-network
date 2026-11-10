import { describe, expect, test } from "bun:test";
import { opencodeModelEffectiveSnapshot as snap } from "./opencode-model-effective";

describe("opencodeModelEffectiveSnapshot", () => {
  test("variant readback wins and carries the variant", () => {
    expect(snap({ variantReadback: { providerID: "p", id: "m", variant: "high" }, variantRunning: true, sessionModel: "x/y", sessionRunning: true }))
      .toEqual({ model_effective: "p/m", modelVariant: "high" });
  });
  test("default variant is reported as null", () => {
    expect(snap({ variantReadback: { providerID: "p", id: "m", variant: "default" }, variantRunning: true, sessionModel: undefined, sessionRunning: true }))
      .toEqual({ model_effective: "p/m", modelVariant: null });
  });
  test("model without variants still reports the session model, variant unknown", () => {
    const out = snap({ variantReadback: undefined, variantRunning: false, sessionModel: "openai/gpt-6.1-terra", sessionRunning: true });
    expect(out).toEqual({ model_effective: "openai/gpt-6.1-terra" });
    expect("modelVariant" in out).toBe(false);
  });
  test("dead session reports nothing", () => {
    expect(snap({ variantReadback: undefined, variantRunning: false, sessionModel: "openai/x", sessionRunning: false })).toEqual({});
  });
  test("no session model reports nothing", () => {
    expect(snap({ variantReadback: undefined, variantRunning: false, sessionModel: undefined, sessionRunning: true })).toEqual({});
    expect(snap({ variantReadback: undefined, variantRunning: false, sessionModel: "bare", sessionRunning: true })).toEqual({});
  });
});

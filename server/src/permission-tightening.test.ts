import { expect, test } from "bun:test";
import { isInboxTightening, isPermissionModeTightening } from "./permission-tightening.js";

test("mode can only move normal -> restricted -> readonly (including no-op)", () => {
  const modes = ["normal", "restricted", "readonly"];
  for (let i = 0; i < modes.length; i++) for (let j = 0; j < modes.length; j++) {
    expect(isPermissionModeTightening(modes[i], modes[j])).toBe(j >= i);
  }
  expect(isPermissionModeTightening("unknown", "readonly")).toBe(false);
  expect(isPermissionModeTightening("normal", "unknown")).toBe(false);
});

test("inbox is a nonempty subset; null is unlimited, never a tightening target", () => {
  expect(isInboxTightening(null, ["a"])).toBe(true);
  expect(isInboxTightening(["a", "b"], ["b"])).toBe(true);
  expect(isInboxTightening(["a"], ["a", "a"])).toBe(true);
  expect(isInboxTightening(["a"], ["b"])).toBe(false);
  expect(isInboxTightening(["a"], null)).toBe(false);
  expect(isInboxTightening(null, null)).toBe(false);
  expect(isInboxTightening(["a"], [])).toBe(false);
});

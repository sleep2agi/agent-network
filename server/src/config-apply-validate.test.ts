// Coverage for the RFC-024 patch validators / classifiers. Pinned at
// the helper layer so the contract (allowlist + security-flag gate +
// per-field range/enum + apply-mode classification) can't drift
// silently. SEC-2 fail-closed regression guard included — any future
// "convenience" change that lets non-admin remote-flip a security flag
// fails these tests.

import { describe, expect, test } from "bun:test";
import {
  ALLOWED_FLAGS,
  SECURITY_SENSITIVE_FLAGS,
  isAllowedToChangeFlag,
  computeApplyMode,
  validatePatch,
} from "./config-apply-validate";

describe("ALLOWED_FLAGS — exact contract (no silent extension)", () => {
  test("contains exactly the 6 fields from RFC-024 §4", () => {
    expect([...ALLOWED_FLAGS].sort()).toEqual([
      "budget",
      "dangerouslySkipPermissions",
      "maxTurns",
      "permissionMode",
      "teammateMode",
      "timeout",
    ]);
  });
});

describe("SECURITY_SENSITIVE_FLAGS — privilege-elevation surface", () => {
  test("contains the 3 privilege-elevation flags", () => {
    expect([...SECURITY_SENSITIVE_FLAGS].sort()).toEqual([
      "dangerouslySkipPermissions",
      "permissionMode",
      "teammateMode",
    ]);
  });

  test("every security-sensitive flag is also in ALLOWED_FLAGS (sanity)", () => {
    for (const f of SECURITY_SENSITIVE_FLAGS) expect(ALLOWED_FLAGS.has(f)).toBe(true);
  });
});

describe("isAllowedToChangeFlag — SEC-2 fail-CLOSED (pending Vincent policy)", () => {
  // Until Vincent confirms the policy, every role MUST be rejected for
  // patches containing security-sensitive flags. These tests pin the
  // fail-closed default so PR A can't silently re-open the door.

  test("member role + dangerouslySkipPermissions → reject", () => {
    const r = isAllowedToChangeFlag("member", { dangerouslySkipPermissions: true });
    expect(r).not.toBeNull();
    expect(r?.field).toBe("flags.dangerouslySkipPermissions");
    expect(r?.reason).toMatch(/pending policy/i);
  });

  test("admin role + dangerouslySkipPermissions → reject (NOT relaxed yet)", () => {
    const r = isAllowedToChangeFlag("admin", { dangerouslySkipPermissions: false });
    expect(r).not.toBeNull();
  });

  test("owner role + permissionMode → reject (every role locked)", () => {
    const r = isAllowedToChangeFlag("owner", { permissionMode: "default" });
    expect(r).not.toBeNull();
  });

  test("member role + teammateMode → reject", () => {
    const r = isAllowedToChangeFlag("member", { teammateMode: true });
    expect(r).not.toBeNull();
  });

  test("admin role + mixed (model is not a flag here, but security flag inside) → reject", () => {
    // model isn't in this helper's input (helper only takes flags); but a
    // patch with BOTH model and dangerouslySkipPermissions is rejected
    // because the flag bag contains DSP. Pinning that the helper looks
    // at every flag, not just the first.
    const r = isAllowedToChangeFlag("admin", { teammateMode: false, dangerouslySkipPermissions: true });
    expect(r).not.toBeNull();
  });

  test("member role + only harmless flags (maxTurns) → pass", () => {
    expect(isAllowedToChangeFlag("member", { maxTurns: 50 })).toBeNull();
  });

  test("member role + only harmless flags (maxTurns + budget) → pass", () => {
    expect(isAllowedToChangeFlag("member", { maxTurns: 50, budget: 100 })).toBeNull();
  });

  test("any role + empty flag bag → pass (no flags to gate)", () => {
    expect(isAllowedToChangeFlag(null, {})).toBeNull();
    expect(isAllowedToChangeFlag("member", {})).toBeNull();
    expect(isAllowedToChangeFlag("admin", {})).toBeNull();
  });
});

describe("computeApplyMode — tier classifier (RFC-024 §4)", () => {
  test("empty patch (model + flags both empty) → restart_only", () => {
    expect(computeApplyMode(undefined, {})).toBe("restart_only");
  });

  test("model alone → restart (SDK reinit needed)", () => {
    expect(computeApplyMode("claude-opus-4", {})).toBe("restart");
  });

  test("flags.permissionMode alone → restart", () => {
    expect(computeApplyMode(undefined, { permissionMode: "auto" })).toBe("restart");
  });

  test("flags.dangerouslySkipPermissions alone → restart", () => {
    expect(computeApplyMode(undefined, { dangerouslySkipPermissions: true })).toBe("restart");
  });

  test("flags.teammateMode alone → restart", () => {
    expect(computeApplyMode(undefined, { teammateMode: false })).toBe("restart");
  });

  test("flags.timeout alone → restart (per RFC-024 §4 — module-level const today)", () => {
    expect(computeApplyMode(undefined, { timeout: 60000 })).toBe("restart");
  });

  test("flags.maxTurns alone → hot", () => {
    expect(computeApplyMode(undefined, { maxTurns: 50 })).toBe("hot");
  });

  test("flags.budget alone → hot", () => {
    expect(computeApplyMode(undefined, { budget: 100 })).toBe("hot");
  });

  test("mixed (model + maxTurns) → restart (strictest wins)", () => {
    expect(computeApplyMode("gpt-5", { maxTurns: 50 })).toBe("restart");
  });

  test("mixed (only hot flags) → hot", () => {
    expect(computeApplyMode(undefined, { maxTurns: 50, budget: 100 })).toBe("hot");
  });

  test("mixed (hot + one restart flag) → restart", () => {
    expect(computeApplyMode(undefined, { maxTurns: 50, timeout: 60000 })).toBe("restart");
  });
});

describe("validatePatch — model field", () => {
  test("undefined model passes (no change)", () => {
    expect(validatePatch(undefined, {})).toBeNull();
  });
  test("valid model string passes", () => {
    expect(validatePatch("claude-opus-4", {})).toBeNull();
  });
  test("empty model string rejected", () => {
    const r = validatePatch("", {});
    expect(r?.field).toBe("model");
  });
  test("model >200 chars rejected", () => {
    const r = validatePatch("x".repeat(201), {});
    expect(r?.field).toBe("model");
  });
  test("non-string model rejected", () => {
    const r = validatePatch(123 as any, {});
    expect(r?.field).toBe("model");
  });
});

describe("validatePatch — flag allowlist (anything not in ALLOWED_FLAGS rejected)", () => {
  test("unknown flag rejected", () => {
    const r = validatePatch(undefined, { mysteryFlag: 1 } as any);
    expect(r?.field).toBe("flags.mysteryFlag");
    expect(r?.reason).toMatch(/allowlist/);
  });
  test("typo of allowed flag rejected (no fuzzy match)", () => {
    const r = validatePatch(undefined, { permission_mode: "auto" } as any);
    expect(r?.field).toBe("flags.permission_mode");
  });
});

describe("validatePatch — per-flag enum / range", () => {
  test("permissionMode valid values", () => {
    for (const v of ["default", "auto", "bypassPermissions", "acceptEdits", "plan"]) {
      expect(validatePatch(undefined, { permissionMode: v })).toBeNull();
    }
  });
  test("permissionMode invalid value rejected", () => {
    const r = validatePatch(undefined, { permissionMode: "godmode" } as any);
    expect(r?.field).toBe("flags.permissionMode");
  });
  test("dangerouslySkipPermissions must be boolean", () => {
    expect(validatePatch(undefined, { dangerouslySkipPermissions: true })).toBeNull();
    expect(validatePatch(undefined, { dangerouslySkipPermissions: false })).toBeNull();
    expect(validatePatch(undefined, { dangerouslySkipPermissions: "true" } as any)?.field).toBe("flags.dangerouslySkipPermissions");
    expect(validatePatch(undefined, { dangerouslySkipPermissions: 1 } as any)?.field).toBe("flags.dangerouslySkipPermissions");
  });
  test("teammateMode must be boolean", () => {
    expect(validatePatch(undefined, { teammateMode: true })).toBeNull();
    expect(validatePatch(undefined, { teammateMode: "yes" } as any)?.field).toBe("flags.teammateMode");
  });
  test("maxTurns must be integer in [0, 10000]", () => {
    expect(validatePatch(undefined, { maxTurns: 0 })).toBeNull();
    expect(validatePatch(undefined, { maxTurns: 10000 })).toBeNull();
    expect(validatePatch(undefined, { maxTurns: -1 })?.field).toBe("flags.maxTurns");
    expect(validatePatch(undefined, { maxTurns: 10001 })?.field).toBe("flags.maxTurns");
    expect(validatePatch(undefined, { maxTurns: 1.5 })?.field).toBe("flags.maxTurns");
    expect(validatePatch(undefined, { maxTurns: "5" } as any)?.field).toBe("flags.maxTurns");
  });
  test("budget must be number in [0, 1_000_000]", () => {
    expect(validatePatch(undefined, { budget: 0 })).toBeNull();
    expect(validatePatch(undefined, { budget: 500.5 })).toBeNull();
    expect(validatePatch(undefined, { budget: 1_000_000 })).toBeNull();
    expect(validatePatch(undefined, { budget: -1 })?.field).toBe("flags.budget");
    expect(validatePatch(undefined, { budget: 1_000_001 })?.field).toBe("flags.budget");
  });
  test("timeout must be integer ms in [0, 3_600_000]", () => {
    expect(validatePatch(undefined, { timeout: 30000 })).toBeNull();
    expect(validatePatch(undefined, { timeout: 3_600_000 })).toBeNull();
    expect(validatePatch(undefined, { timeout: -1 })?.field).toBe("flags.timeout");
    expect(validatePatch(undefined, { timeout: 3_600_001 })?.field).toBe("flags.timeout");
    expect(validatePatch(undefined, { timeout: 60.5 })?.field).toBe("flags.timeout");
  });
});

describe("validatePatch — combinations", () => {
  test("valid model + valid flag bag passes", () => {
    expect(validatePatch("claude-opus-4", { maxTurns: 50, budget: 100 })).toBeNull();
  });
  test("first invalid field surfaces (good model + bad flag)", () => {
    const r = validatePatch("claude-opus-4", { maxTurns: -1 });
    expect(r?.field).toBe("flags.maxTurns");
  });
});

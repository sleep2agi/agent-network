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
  test("contains exactly the 5 fields from RFC-024 §4 (teammateMode dropped per #290 review)", () => {
    // teammateMode was originally listed in the 6-flag scope but
    // investigation found it's only consumed by the claude-code-cli
    // spawn path (agent-network/bin/cli.ts), NOT by the agent-node-
    // driven runtimes the config-apply pipeline targets. Including it
    // would silently ack `applied` for no-op changes — same class as
    // the BLOCKER 2 schema-mismatch issue. P2 to add a claude-code-cli
    // config-apply path.
    expect([...ALLOWED_FLAGS].sort()).toEqual([
      "budget",
      "dangerouslySkipPermissions",
      "maxTurns",
      "permissionMode",
      "timeout",
    ]);
  });
});

describe("SECURITY_SENSITIVE_FLAGS — privilege-elevation surface", () => {
  test("contains the 2 privilege-elevation flags (teammateMode dropped — see ALLOWED_FLAGS comment)", () => {
    expect([...SECURITY_SENSITIVE_FLAGS].sort()).toEqual([
      "dangerouslySkipPermissions",
      "permissionMode",
    ]);
  });

  test("every security-sensitive flag is also in ALLOWED_FLAGS (sanity)", () => {
    for (const f of SECURITY_SENSITIVE_FLAGS) expect(ALLOWED_FLAGS.has(f)).toBe(true);
  });
});

describe("isAllowedToChangeFlag — SEC-2 admin-gate (final policy 2026-06-28)", () => {
  // Security-sensitive flags require admin role on the caller's
  // network. Any non-admin role is rejected. Harmless flags fall
  // through (`canWrite` upstream handles role !== viewer).

  test("member role + dangerouslySkipPermissions → reject", () => {
    const r = isAllowedToChangeFlag("member", { dangerouslySkipPermissions: true });
    expect(r).not.toBeNull();
    expect(r?.field).toBe("flags.dangerouslySkipPermissions");
    expect(r?.reason).toMatch(/admin or owner/i);
  });

  test("admin role + dangerouslySkipPermissions → pass (allowed)", () => {
    expect(isAllowedToChangeFlag("admin", { dangerouslySkipPermissions: false })).toBeNull();
  });

  test("admin role + permissionMode → pass", () => {
    expect(isAllowedToChangeFlag("admin", { permissionMode: "default" })).toBeNull();
  });

  test("teammateMode dropped from schema (P1 scope) — no role check fires for it", () => {
    // teammateMode no longer in SECURITY_SENSITIVE_FLAGS, so SEC-2 gate
    // doesn't fire. The patch-allowlist gate (validatePatch) rejects it
    // separately as "not in allowlist", which is the correct surface.
    expect(isAllowedToChangeFlag("admin", { teammateMode: true } as any)).toBeNull();
  });

  test("owner role + permissionMode → pass (owner is higher than admin in anet RBAC)", () => {
    // owner > admin in the network_members hierarchy (auth.ts line 354
    // explicitly treats owner as the highest tier; updateMemberRole
    // refuses to assign owner). The SEC-2 gate uses an admin-or-above
    // semantic so the highest-privilege user isn't accidentally locked
    // out of a permission their subordinates can use.
    expect(isAllowedToChangeFlag("owner", { permissionMode: "default" })).toBeNull();
  });

  test("owner role + dangerouslySkipPermissions → pass", () => {
    expect(isAllowedToChangeFlag("owner", { dangerouslySkipPermissions: true })).toBeNull();
  });

  test("viewer role + any security flag → reject", () => {
    expect(isAllowedToChangeFlag("viewer", { dangerouslySkipPermissions: true })).not.toBeNull();
  });

  test("null role (no network membership) + any security flag → reject", () => {
    expect(isAllowedToChangeFlag(null, { dangerouslySkipPermissions: true })).not.toBeNull();
  });

  test("member role + mixed bag with security flag → reject (checks every flag, not just first)", () => {
    const r = isAllowedToChangeFlag("member", { permissionMode: "default", dangerouslySkipPermissions: true });
    expect(r).not.toBeNull();
  });

  test("admin role + mixed bag (security + harmless) → pass", () => {
    expect(isAllowedToChangeFlag("admin", { dangerouslySkipPermissions: true, maxTurns: 50 })).toBeNull();
  });

  test("member role + only harmless flags (maxTurns) → pass", () => {
    expect(isAllowedToChangeFlag("member", { maxTurns: 50 })).toBeNull();
  });

  test("member role + only harmless flags (maxTurns + budget) → pass", () => {
    expect(isAllowedToChangeFlag("member", { maxTurns: 50, budget: 100 })).toBeNull();
  });

  test("any role + empty flag bag → pass (no flags to gate)", () => {
    expect(isAllowedToChangeFlag(null, {})).toBeNull();
    expect(isAllowedToChangeFlag("viewer", {})).toBeNull();
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

  test("teammateMode dropped from RESTART_REQUIRED_FLAGS (no longer in scope)", () => {
    // teammateMode no longer in RESTART_REQUIRED_FLAGS. computeApplyMode
    // sees only unknown-to-tier-table flags → returns "hot" by default.
    // The patch-allowlist gate (validatePatch) rejects it separately.
    expect(computeApplyMode(undefined, { teammateMode: false } as any)).toBe("hot");
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
  test("teammateMode rejected as not-in-allowlist (dropped from P1 scope)", () => {
    // teammateMode was originally allowed but dropped per #290 review
    // (no consumer in agent-node runtimes). validatePatch now rejects
    // it the same way it rejects any unknown flag.
    const r = validatePatch(undefined, { teammateMode: true } as any);
    expect(r?.field).toBe("flags.teammateMode");
    expect(r?.reason).toMatch(/allowlist/);
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

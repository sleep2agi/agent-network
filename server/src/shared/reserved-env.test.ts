import { describe, expect, test } from "bun:test";
import { RESERVED_ENV_KEYS_EXACT, RESERVED_ENV_PREFIXES, isReservedEnvKey } from "./reserved-env.js";

describe("RFC-026 v4 §4.4.7 reserved env denylist (B1)", () => {
  test("exact PATH/HOME/LANG/NODE_OPTIONS blocked", () => {
    for (const k of ["PATH", "HOME", "LANG", "LC_ALL", "SHELL", "USER", "LOGNAME", "NODE_OPTIONS", "IFS", "TMPDIR"]) {
      expect(isReservedEnvKey(k)).toBe(true);
    }
  });
  test("LD_ prefix family blocked (Linux dynamic loader)", () => {
    for (const k of ["LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT", "LD_"]) {
      expect(isReservedEnvKey(k)).toBe(true);
    }
  });
  test("DYLD_ prefix blocked (macOS)", () => {
    expect(isReservedEnvKey("DYLD_INSERT_LIBRARIES")).toBe(true);
    expect(isReservedEnvKey("DYLD_LIBRARY_PATH")).toBe(true);
  });
  test("BUN_/NPM_/NPM_CONFIG_/NODE_ prefix blocked", () => {
    expect(isReservedEnvKey("BUN_INSTALL")).toBe(true);
    expect(isReservedEnvKey("NPM_TOKEN")).toBe(true);
    expect(isReservedEnvKey("NPM_CONFIG_REGISTRY")).toBe(true);
    expect(isReservedEnvKey("NODE_PATH")).toBe(true);
    expect(isReservedEnvKey("NODE_TLS_REJECT_UNAUTHORIZED")).toBe(true);
  });
  test("legitimate API key style is NOT blocked", () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "TELEGRAM_BOT_TOKEN", "DEEPSEEK_API_KEY", "MY_APP_CONFIG"]) {
      expect(isReservedEnvKey(k)).toBe(false);
    }
  });
  test("set shape sanity — both EXACT and PREFIX non-empty + frozen-ish", () => {
    expect(RESERVED_ENV_KEYS_EXACT.size).toBeGreaterThan(10);
    expect(RESERVED_ENV_PREFIXES.length).toBeGreaterThan(3);
  });
});

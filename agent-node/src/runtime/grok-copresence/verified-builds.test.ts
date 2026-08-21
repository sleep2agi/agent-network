import { describe, expect, test } from "bun:test";
import {
  GROK_COPRESENCE_VERIFIED_BUILDS,
  assertGrokCopresenceVersion,
  grokBuildAutoLeader,
} from "./runtime.js";
import { copresenceCapabilities } from "./platform.js";

describe("grok co-presence verified builds", () => {
  test("the macOS 1.0.5 build is registered — measured on an Apple M4", () => {
    // Exact string matters: this table matches verbatim, and the same source
    // commit prints a different hash length per platform. 5115b46bc9 (linux) is
    // a prefix of 5115b46bc909 (darwin) — same commit, different builds.
    expect(GROK_COPRESENCE_VERIFIED_BUILDS.has("grok 1.0.5 (5115b46bc909)")).toBe(true);
    expect(() => assertGrokCopresenceVersion("grok 1.0.5 (5115b46bc909)")).not.toThrow();
  });

  test("darwin 1.0.5 keeps autoLeader=false, like the linux build of the same commit", () => {
    // grok is leaderless on macOS: after running it, ~/.grok/leader.sock and
    // leader.lock are both absent (both present on linux).
    expect(grokBuildAutoLeader("grok 1.0.5 (5115b46bc909)")).toBe(false);
  });

  test("an unregistered build is still refused, and the message names what it saw", () => {
    // The allowlist is the point: a build nobody verified must not run a shared
    // TUI just because its version number looks close enough.
    expect(() => assertGrokCopresenceVersion("grok 1.0.6 (deadbeef)")).toThrow("grok 1.0.6 (deadbeef)");
    expect(() => assertGrokCopresenceVersion("")).toThrow("empty version");
  });

  test("🔴 the darwin registration and the darwin capability row tell the SAME story", () => {
    // The build note says isolated HOME does NOT empty out on macOS
    // (skills=89, agents=3 against 122 on the real home). If the capability row
    // ever claimed isolation works there, the two would contradict each other
    // and only one of them is what the runtime actually enforces.
    expect(copresenceCapabilities("darwin").homeIsolationHidesVendorSkills).toBe(false);
    expect(copresenceCapabilities("darwin").supported).toBe(true);
  });
});

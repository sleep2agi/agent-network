import { describe, expect, test } from "bun:test";
import {
  GROK_COPRESENCE_PROFILE_ENV,
  readPinnedGrokCopresenceCapabilityProfile,
  selectGrokCopresenceCapabilityProfile,
  selectGrokCopresenceSandboxProfile,
} from "./profile-selection";

describe("Grok co-presence process capability profile", () => {
  test("accepts only the exact startup profiles", () => {
    expect(selectGrokCopresenceCapabilityProfile(undefined)).toBe("commhub-only");
    expect(selectGrokCopresenceCapabilityProfile([])).toBe("commhub-only");
    expect(selectGrokCopresenceCapabilityProfile(["WebSearch"])).toBe("x-search");
    expect(selectGrokCopresenceCapabilityProfile(["Read", "Grep", "Glob"])).toBe("repo-read");
    for (const tools of [
      ["web_search"], ["WebSearch", "WebFetch"], ["WebSearch "], ["all"], ["Read"],
      ["Read", "Glob", "Grep"], ["Read", "Grep"], ["Read", "Grep", "Glob", "WebSearch"],
    ]) {
      expect(() => selectGrokCopresenceCapabilityProfile(tools)).toThrow("exact tools profile");
    }
  });

  test("defaults closed and rejects an invalid process profile", () => {
    expect(readPinnedGrokCopresenceCapabilityProfile({
      [GROK_COPRESENCE_PROFILE_ENV]: "commhub-only",
    })).toBe("commhub-only");
    expect(readPinnedGrokCopresenceCapabilityProfile({
      [GROK_COPRESENCE_PROFILE_ENV]: "x-search",
    })).toBe("x-search");
    expect(readPinnedGrokCopresenceCapabilityProfile({
      [GROK_COPRESENCE_PROFILE_ENV]: "repo-read",
    })).toBe("repo-read");
    expect(readPinnedGrokCopresenceCapabilityProfile({})).toBe("commhub-only");
    expect(() => readPinnedGrokCopresenceCapabilityProfile({
      [GROK_COPRESENCE_PROFILE_ENV]: "human-turn",
    })).toThrow("invalid");
  });

  test("uses the strict sandbox only for repo-read", () => {
    const profiles = { workspaceProfile: "anet-workspace", strictProfile: "anet-strict" };
    expect(selectGrokCopresenceSandboxProfile("commhub-only", profiles)).toBe("anet-workspace");
    expect(selectGrokCopresenceSandboxProfile("x-search", profiles)).toBe("anet-workspace");
    expect(selectGrokCopresenceSandboxProfile("repo-read", profiles)).toBe("anet-strict");
  });
});

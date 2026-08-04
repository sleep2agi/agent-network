import { describe, expect, test } from "bun:test";
import {
  GROK_COPRESENCE_PROFILE_ENV,
  readPinnedGrokCopresenceCapabilityProfile,
  selectGrokCopresenceCapabilityProfile,
} from "./profile-selection";

describe("Grok co-presence process capability profile", () => {
  test("accepts only the two exact startup profiles", () => {
    expect(selectGrokCopresenceCapabilityProfile(undefined)).toBe("commhub-only");
    expect(selectGrokCopresenceCapabilityProfile([])).toBe("commhub-only");
    expect(selectGrokCopresenceCapabilityProfile(["WebSearch"])).toBe("x-search");
    for (const tools of [
      ["web_search"], ["WebSearch", "WebFetch"], ["WebSearch "], ["all"], ["Read"],
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
    expect(readPinnedGrokCopresenceCapabilityProfile({})).toBe("commhub-only");
    expect(() => readPinnedGrokCopresenceCapabilityProfile({
      [GROK_COPRESENCE_PROFILE_ENV]: "human-turn",
    })).toThrow("invalid");
  });
});

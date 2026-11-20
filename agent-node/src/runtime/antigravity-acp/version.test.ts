import { describe, expect, it } from "vitest";
import { agyReadinessMessage, compareAgyVersion, formatAgyVersion, parseAgyVersion, PINNED_AGY_VERSION } from "./version";

describe("agy version pin", () => {
  it("parses the one-line --version output", () => {
    expect(parseAgyVersion("1.5.13\n")).toMatchObject({ major: 1, minor: 5, patch: 13, raw: "1.5.13" });
    expect(parseAgyVersion("v1.5.13")).toMatchObject({ major: 1, minor: 5, patch: 13 });
  });
  it("returns null on junk", () => {
    expect(parseAgyVersion("")).toBeNull();
    expect(parseAgyVersion("Antigravity CLI")).toBeNull();
  });
  it("only the pinned version is ready", () => {
    const pinned = parseAgyVersion(PINNED_AGY_VERSION)!;
    expect(compareAgyVersion(pinned)).toBe("pinned");
    expect(compareAgyVersion(parseAgyVersion("1.5.14"))).toBe("newer");
    expect(compareAgyVersion(parseAgyVersion("1.5.12"))).toBe("older");
    expect(compareAgyVersion(null)).toBe("unknown");
  });
  it("explains why newer/older/unknown are blocked", () => {
    expect(agyReadinessMessage("pinned", parseAgyVersion("1.5.13"))).toContain("已验收");
    expect(agyReadinessMessage("newer", parseAgyVersion("1.5.14"))).toContain("先审过");
    expect(agyReadinessMessage("older", parseAgyVersion("1.5.12"))).toContain("1.5.13");
    expect(agyReadinessMessage("unknown", null)).toContain("PATH");
  });
  it("formats pre-release suffix", () => {
    const v = parseAgyVersion("1.6.0-preview.2")!;
    expect(formatAgyVersion(v)).toBe("1.6.0-preview.2");
    expect(compareAgyVersion(v)).toBe("newer");
  });
});

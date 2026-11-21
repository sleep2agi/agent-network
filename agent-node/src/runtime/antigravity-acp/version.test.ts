import { describe, expect, it } from "vitest";
import { agyReadinessMessage, compareAgyVersion, formatAgyVersion, parseAgyVersion, PINNED_AGY_VERSION, pinnedAgyVersion } from "./version";

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
  it("newer/older are advisory (not blockers)", () => {
    expect(agyReadinessMessage("pinned", parseAgyVersion("1.5.13"))).toContain("已验收");
    expect(agyReadinessMessage("newer", parseAgyVersion("1.5.14"))).toContain("不阻断");
    expect(agyReadinessMessage("older", parseAgyVersion("1.5.12"))).toContain("不阻断");
    expect(agyReadinessMessage("older", parseAgyVersion("1.5.12"))).toContain("1.5.13");
    expect(agyReadinessMessage("unknown", null)).toContain("PATH");
  });
  it("formats pre-release suffix", () => {
    const v = parseAgyVersion("1.6.0-preview.2")!;
    expect(formatAgyVersion(v)).toBe("1.6.0-preview.2");
    expect(compareAgyVersion(v)).toBe("newer");
  });
});

// 2026-11-21 真机：agy 的自动升级关不掉（settings.json 的 AutoUpdate 不生效），
// 而基线是写死的常量 —— 被升级一次就完全没有退路（节点直接拒跑，只能等发版）。
// AGY_ACCEPTED_VERSION 是显式的逃生口：默认值不变，审过新版本后由运维主动设置。
describe("AGY_ACCEPTED_VERSION escape hatch", () => {
  const original = process.env.AGY_ACCEPTED_VERSION;
  const restore = () => {
    if (original === undefined) delete process.env.AGY_ACCEPTED_VERSION;
    else process.env.AGY_ACCEPTED_VERSION = original;
  };

  it("defaults to the pinned version when unset", () => {
    delete process.env.AGY_ACCEPTED_VERSION;
    expect(pinnedAgyVersion()).toBe(PINNED_AGY_VERSION);
    restore();
  });

  it("accepts a reviewed version and flips compareAgyVersion to pinned", () => {
    process.env.AGY_ACCEPTED_VERSION = "1.5.14";
    expect(pinnedAgyVersion()).toBe("1.5.14");
    expect(compareAgyVersion(parseAgyVersion("1.5.14"))).toBe("pinned");
    restore();
  });

  it("ignores junk (a typo must not turn the pin into 'accept anything')", () => {
    process.env.AGY_ACCEPTED_VERSION = "latest";
    expect(pinnedAgyVersion()).toBe(PINNED_AGY_VERSION);
    restore();
  });

  it("newer/older messages are actionable (降级锁定 或 审过后放行)", () => {
    const newer = agyReadinessMessage("newer", parseAgyVersion("1.5.14"));
    expect(newer).toContain("AGY_ACCEPTED_VERSION=1.5.14");
    expect(newer).toContain("chflags uchg");
    expect(agyReadinessMessage("older", parseAgyVersion("1.5.12"))).toContain("install.sh");
  });
});

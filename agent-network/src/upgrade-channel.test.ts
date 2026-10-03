import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { compareSemver, parseSemver, resolveUpgradeChannel } from "./upgrade-channel";

// Registry shape as measured on 2026-10-03: latest is a PROMOTED preview build,
// so both tags carry a "-preview.N" suffix. That is the whole bug (#510).
const TAGS = { latest: "2.3.0-preview.76", preview: "2.3.0-preview.124" };

function channelOf(installed: string | null, flag?: string, distTags: any = TAGS) {
  const r = resolveUpgradeChannel({ installed, flag, distTags });
  if (!r.ok) throw new Error(`unexpected refusal: ${r.error}`);
  return r;
}

describe("#510 anet upgrade stays on the current channel", () => {
  test("latest stays latest even though the latest build is a -preview.N version", () => {
    const r = channelOf("2.3.0-preview.76");
    expect(r.channel).toBe("latest");
    expect(r.source).toBe("detected");
    expect(r.reason).toContain("latest");
  });

  test("a user behind on latest stays on latest (no silent switch to preview)", () => {
    expect(channelOf("2.3.0-preview.70").channel).toBe("latest");
    expect(channelOf("2.2.9-preview.3").channel).toBe("latest");
  });

  test("a stable (non-prerelease) install stays on latest, even without registry data", () => {
    expect(channelOf("2.4.0").channel).toBe("latest");
    expect(channelOf("2.4.0", undefined, null).channel).toBe("latest");
  });

  test("preview stays preview", () => {
    expect(channelOf("2.3.0-preview.124").channel).toBe("preview");
    // behind on preview but ahead of latest
    const r = channelOf("2.3.0-preview.100");
    expect(r.channel).toBe("preview");
    expect(r.reason).toContain("newer than latest");
  });

  test("explicit --channel switches in both directions and skips detection", () => {
    const toPreview = resolveUpgradeChannel({ installed: "2.3.0-preview.76", flag: "preview", distTags: TAGS });
    expect(toPreview).toMatchObject({ ok: true, channel: "preview", source: "flag" });
    const toLatest = resolveUpgradeChannel({ installed: "2.3.0-preview.124", flag: "latest", distTags: TAGS });
    expect(toLatest).toMatchObject({ ok: true, channel: "latest", source: "flag" });
    // works even when the version is unparseable and the registry is down
    const blind = resolveUpgradeChannel({ installed: "", flag: "latest", distTags: null });
    expect(blind).toMatchObject({ ok: true, channel: "latest" });
  });

  test("bad --channel values are refused", () => {
    expect(resolveUpgradeChannel({ installed: "2.4.0", flag: "true", distTags: TAGS }))
      .toMatchObject({ ok: false, error: expect.stringContaining("requires a value") });
    expect(resolveUpgradeChannel({ installed: "2.4.0", flag: "beta", distTags: TAGS }))
      .toMatchObject({ ok: false, error: expect.stringContaining('got "beta"') });
  });

  test("unknown/unparseable installed version is refused with a clear message, not guessed", () => {
    for (const installed of ["", null, "garbage", "2.3", "latest"]) {
      const r = resolveUpgradeChannel({ installed, distTags: TAGS });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain("cannot determine your release channel");
        expect(r.error).toContain("--channel latest");
      }
    }
  });

  test("a prerelease with no usable latest dist-tag is refused, not guessed", () => {
    for (const distTags of [null, {}, { preview: TAGS.preview }, { latest: "nope" }]) {
      const r = resolveUpgradeChannel({ installed: "2.3.0-preview.80", distTags });
      expect(r.ok).toBe(false);
    }
    // ...but an exact preview-tag match is still decidable
    expect(channelOf("2.3.0-preview.124", undefined, { preview: TAGS.preview }).channel).toBe("preview");
  });
});

describe("semver precedence", () => {
  const cmp = (a: string, b: string) => Math.sign(compareSemver(parseSemver(a)!, parseSemver(b)!));
  test("numeric prerelease ids compare numerically", () => {
    expect(cmp("2.3.0-preview.124", "2.3.0-preview.76")).toBe(1);
    expect(cmp("2.3.0-preview.9", "2.3.0-preview.10")).toBe(-1);
  });
  test("release beats its prerelease; core version dominates", () => {
    expect(cmp("2.3.0", "2.3.0-preview.999")).toBe(1);
    expect(cmp("2.2.9", "2.3.0-preview.1")).toBe(-1);
    expect(cmp("2.3.0-preview.5", "2.3.0-preview.5")).toBe(0);
  });
});

test("cli.ts routes `anet upgrade` through resolveUpgradeChannel and installs the announced version", () => {
  const source = readFileSync(join(import.meta.dir, "..", "bin", "cli.ts"), "utf8");
  expect(source).toContain('from "../src/upgrade-channel";');
  expect(source).toContain("const resolution = resolveUpgradeChannel({");
  // the regex that mis-detected latest users as preview must be gone
  expect(source).not.toContain("function detectChannel(");
  expect(source).not.toMatch(/-\(preview\|rc\|alpha\|beta\|next\)/);
  // installs the exact version printed in the plan, not a floating tag
  expect(source).toContain("installGlobalPackage(`${p.pkg}@${p.target}`);");
  expect(source).toContain("Will install from the ${channel} channel:");
});

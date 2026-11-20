import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { checkAgyReadiness } from "./readiness";

const bin = process.env.AGY_BIN ?? "";
const has = !!bin && existsSync(bin);

describe.skipIf(!has)("agy readiness against the real binary", () => {
  it("reports the pinned version and acp support", () => {
    const r = checkAgyReadiness(bin);
    expect(r.hasAcp).toBe(true);
    expect(r.state).toBe("pinned");
    expect(r.version?.raw).toContain("1.5.13");
    expect(r.ok).toBe(true);
    expect(r.message).toContain("已验收");
  });
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KNOWN_REASONING_EFFORTS,
  codexModelsCachePath,
  collectReasoningEffortsFromModelsCache,
  describeUnknownReasoningEfforts,
  findUnknownReasoningEfforts,
} from "./codex-models-cache-check.js";

// 2026-09-03 DEV 本机 ~/.codex/models_cache.json 的真实形状(只保留相关字段)。
const REAL_SHAPE = {
  fetched_at: "2026-09-03T00:00:00Z",
  client_version: "0.149.1",
  models: [
    {
      slug: "gpt-5.5",
      description: "Frontier model with maximum effort available",
      default_reasoning_level: "medium",
      supported_reasoning_levels: [
        { effort: "low", description: "Fast" },
        { effort: "medium", description: "Balanced" },
        { effort: "high", description: "Thorough" },
        { effort: "xhigh", description: "Deeper" },
        { effort: "max", description: "Maximum" },
        { effort: "ultra", description: "Ultra" },
      ],
    },
  ],
};

describe("#1645 codex models cache reasoning-effort gate", () => {
  test("known set mirrors types/codex/ReasoningEffort.ts", () => {
    expect([...KNOWN_REASONING_EFFORTS]).toEqual(["none", "minimal", "low", "medium", "high", "xhigh"]);
  });
  test("collects efforts from the real cache shape without picking up prose", () => {
    expect(collectReasoningEffortsFromModelsCache(REAL_SHAPE)).toEqual(["high", "low", "max", "medium", "ultra", "xhigh"]);
  });
  test("names exactly the variants the local codex does not know", () => {
    const report = findUnknownReasoningEfforts(REAL_SHAPE);
    expect(report.unknown).toEqual(["max", "ultra"]);
    expect(report.clientVersion).toBe("0.149.1");
  });
  test("a cache with only known variants is silent", () => {
    const ok = { models: [{ default_reasoning_level: "low", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] }] };
    expect(findUnknownReasoningEfforts(ok).unknown).toEqual([]);
  });
  test("string-array and bare-string shapes are also read", () => {
    expect(collectReasoningEffortsFromModelsCache({ supported_reasoning_levels: ["low", "max"], default_reasoning_level: "ultra" }))
      .toEqual(["low", "max", "ultra"]);
  });
  test("describe: missing / malformed file → no lines; real shape → two lines naming max and ultra", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-cache-"));
    try {
      expect(describeUnknownReasoningEfforts(join(dir, "missing.json"))).toEqual([]);
      writeFileSync(join(dir, "bad.json"), "{not json");
      expect(describeUnknownReasoningEfforts(join(dir, "bad.json"))).toEqual([]);
      writeFileSync(join(dir, "real.json"), JSON.stringify(REAL_SHAPE));
      const lines = describeUnknownReasoningEfforts(join(dir, "real.json"));
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain("max, ultra");
      expect(lines[0]).toContain("0.149.1");
      expect(lines[1]).toContain("#1645");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("path honours CODEX_HOME", () => {
    expect(codexModelsCachePath({ CODEX_HOME: "/x/codex" })).toBe(join("/x/codex", "models_cache.json"));
    expect(codexModelsCachePath({})).toContain(join(".codex", "models_cache.json"));
  });
});

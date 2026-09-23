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
  // #1973 —— 选中的 codex(#1969 解析结果)不比写缓存的 codex 旧 ⇒ 它认得自己写下的档位,不该警告。
  const withCache = (fn: (path: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "codex-cache-1973-"));
    try {
      const path = join(dir, "models_cache.json");
      writeFileSync(path, JSON.stringify({ ...REAL_SHAPE, client_version: "0.155.1" }));
      fn(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  test("#1973 selected codex equal to or newer than the cache writer → no warning", () => {
    withCache((path) => {
      expect(describeUnknownReasoningEfforts(path, "0.155.1")).toEqual([]);
      expect(describeUnknownReasoningEfforts(path, "0.160.0")).toEqual([]);
      expect(describeUnknownReasoningEfforts(path, "codex-cli 0.156.2")).toEqual([]);
    });
  });
  test("#1973 selected codex older than the cache writer → warning naming both versions", () => {
    withCache((path) => {
      const lines = describeUnknownReasoningEfforts(path, "0.133.0");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain("max, ultra");
      expect(lines[0]).toContain("0.133.0");
      expect(lines[0]).toContain("0.155.1");
      expect(lines[1]).toContain("#1645");
    });
  });
  test("#1973 selected version unknown → old hard-coded-set behaviour (still warns)", () => {
    withCache((path) => {
      for (const selected of [undefined, "", "   "]) {
        const lines = describeUnknownReasoningEfforts(path, selected);
        expect(lines).toHaveLength(2);
        expect(lines[0]).toContain("max, ultra");
        expect(lines[0]).toContain("0.155.1");
      }
    });
  });
  test("#1973 cache writer version unknown → old behaviour even with a selected version", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-cache-1973-"));
    try {
      const path = join(dir, "models_cache.json");
      const { client_version: _drop, ...noVersion } = REAL_SHAPE;
      writeFileSync(path, JSON.stringify(noVersion));
      expect(describeUnknownReasoningEfforts(path, "0.199.0")).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("path honours CODEX_HOME", () => {
    expect(codexModelsCachePath({ CODEX_HOME: "/x/codex" })).toBe(join("/x/codex", "models_cache.json"));
    expect(codexModelsCachePath({})).toContain(join(".codex", "models_cache.json"));
  });
});

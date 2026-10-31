// #3294 —— agent-node 的构建标识读取：三态 + 「只给值，成因交给 Hub」。
//
// 与 server / agent-network 两份同一套判据，但独立实现（三个包分别发布，不能跨包 import）。
// 这里钉的是：present / absent / invalid 分开；坏掉的**不冒充没有**（虽然两者对外都返回 undefined，
// 成因由 Hub 的 build_note 承担 —— 这一点必须写下来，否则「读不到」会被读成「本来就没有」）。
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILD_INFO_FILE, readBuildInfo, validateBuildInfo } from "./build-info";

const SHA = "c".repeat(40);
const GOOD = { schema: 1, commit: SHA, dirty: false, built_at: "2026-10-31T20:00:00Z" };

function inTemp(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "an-build-info-"));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("#3294 agent-node build-info", () => {
  test("absent：没有文件（源码检出 / 老制品）—— 正常状态", () => {
    inTemp((dir) => expect(readBuildInfo(dir)).toEqual({ kind: "absent" }));
  });

  test("present：原样读出", () => {
    inTemp((dir) => {
      writeFileSync(join(dir, BUILD_INFO_FILE), JSON.stringify(GOOD));
      expect(readBuildInfo(dir)).toEqual({ kind: "present", info: GOOD });
    });
  });

  test("invalid 与 absent 分开（写坏了 ≠ 没有）", () => {
    inTemp((dir) => {
      writeFileSync(join(dir, BUILD_INFO_FILE), "not json");
      expect(readBuildInfo(dir)).toEqual({ kind: "invalid", error: "invalid_json" });
      writeFileSync(join(dir, BUILD_INFO_FILE), JSON.stringify({ ...GOOD, dirty: "no" }));
      expect(readBuildInfo(dir)).toEqual({ kind: "invalid", error: "invalid_shape" });
    });
  });

  test("严格校验：每种坏形状都拒绝", () => {
    expect(validateBuildInfo(null)).toBeNull();
    expect(validateBuildInfo({ ...GOOD, schema: 0 })).toBeNull();
    expect(validateBuildInfo({ ...GOOD, commit: SHA.toUpperCase() })).toBeNull();
    expect(validateBuildInfo({ ...GOOD, built_at: "2026-10-31" })).toBeNull();
  });
});

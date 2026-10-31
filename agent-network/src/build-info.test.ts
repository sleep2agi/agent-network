// #3294 —— CLI 的构建标识：三态读取 + `anet --version` 那一行。
//
// 与 commhub-server 那份**同一套判据**，但是独立实现（两个包分别发布，不能跨包 import）。
// 这里钉三件事：
//   ① present / absent / invalid 必须分开（absent 是源码检出的正常态；invalid 是注入写坏）
//   ② `--version` 那一行对三种状态各有各的说法，绝不把「没有」显示成「没问题」
//   ③ 脏树必须自己说出来 —— 脏树的 commit 只能当自称
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILD_INFO_FILE, formatBuildLine, readBuildInfo, validateBuildInfo } from "./build-info";

const SHA = "b".repeat(40);
const GOOD = { schema: 1, commit: SHA, dirty: false, built_at: "2026-10-31T19:00:00Z" };

function inTemp(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "anet-build-info-"));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("#3294 CLI build-info", () => {
  test("absent 是正常状态（源码检出 / 老制品）", () => {
    inTemp((dir) => expect(readBuildInfo(dir)).toEqual({ kind: "absent" }));
  });

  test("present 原样读出", () => {
    inTemp((dir) => {
      writeFileSync(join(dir, BUILD_INFO_FILE), JSON.stringify(GOOD));
      expect(readBuildInfo(dir)).toEqual({ kind: "present", info: GOOD });
    });
  });

  test("invalid 与 absent 分开报（写坏了 ≠ 没有）", () => {
    inTemp((dir) => {
      writeFileSync(join(dir, BUILD_INFO_FILE), "{oops");
      expect(readBuildInfo(dir)).toEqual({ kind: "invalid", error: "invalid_json" });
      writeFileSync(join(dir, BUILD_INFO_FILE), JSON.stringify({ ...GOOD, commit: "xyz" }));
      expect(readBuildInfo(dir)).toEqual({ kind: "invalid", error: "invalid_shape" });
    });
  });

  test("严格校验：每种坏形状都拒绝", () => {
    expect(validateBuildInfo(null)).toBeNull();
    expect(validateBuildInfo({ ...GOOD, schema: 2 })).toBeNull();
    expect(validateBuildInfo({ ...GOOD, commit: SHA.toUpperCase() })).toBeNull();
    expect(validateBuildInfo({ ...GOOD, dirty: "false" })).toBeNull();
    expect(validateBuildInfo({ ...GOOD, built_at: "2026-10-31 19:00:00" })).toBeNull();
  });

  test("🔴 三种状态在 --version 那一行里各有各的说法", () => {
    expect(formatBuildLine({ kind: "present", info: GOOD })).toBe(`build ${SHA.slice(0, 12)}`);
    expect(formatBuildLine({ kind: "present", info: { ...GOOD, dirty: true } })).toContain("dirty tree");
    // 「没有」与「坏掉」不能都写成同一句 —— 否则下一个人会去查错方向
    const absent = formatBuildLine({ kind: "absent" });
    const invalid = formatBuildLine({ kind: "invalid", error: "invalid_shape" });
    expect(absent).toContain("no build-info.json");
    expect(invalid).toContain("present but invalid");
    expect(absent).not.toBe(invalid);
  });
});

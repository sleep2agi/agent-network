// #3177 —— 构建期注入的构建标识：**读取三态**（present / absent / invalid）。
//
// 为什么这三态必须分开（这是本文件存在的理由）：
//   部署形态（npm install 出来的 runtime）里没有 .git ⇒ 运行期 git rev-parse 拿不到东西 ⇒
//   生产 /health 的 build_identified 恒为 false（实测：部署 .246 之后仍为 false）。
//   于是「注入写坏了」与「还没注入」会读成同一个东西 —— 而后者是正常状态、前者是缺陷。
//   ⇒ absent 是正常的；invalid 必须能被单独看见。
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILD_INFO_FILE, readBuildInfo, validateBuildInfo } from "./build-info";

const SHA = "a".repeat(40);
const GOOD = { schema: 1, commit: SHA, dirty: false, built_at: "2026-10-31T17:00:00Z" };

function inTemp(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "build-info-"));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("#3177 build-info 读取", () => {
  test("absent：目录里没有文件 —— 这是**正常状态**（部署形态没注入），不是缺陷", () => {
    inTemp((dir) => expect(readBuildInfo(dir)).toEqual({ kind: "absent" }));
  });

  test("present：格式正确就原样读出（含可选 source）", () => {
    inTemp((dir) => {
      writeFileSync(join(dir, BUILD_INFO_FILE), JSON.stringify({ ...GOOD, source: "release.yml" }));
      expect(readBuildInfo(dir)).toEqual({ kind: "present", info: { ...GOOD, source: "release.yml" } });
    });
  });

  test("invalid：文件在但形状不对 ⇒ 与 absent **分开报**", () => {
    inTemp((dir) => {
      writeFileSync(join(dir, BUILD_INFO_FILE), "{ not json");
      expect(readBuildInfo(dir)).toEqual({ kind: "invalid", error: "invalid_json" });
      writeFileSync(join(dir, BUILD_INFO_FILE), JSON.stringify({ ...GOOD, commit: "short" }));
      expect(readBuildInfo(dir)).toEqual({ kind: "invalid", error: "invalid_shape" });
    });
  });

  test("严格校验：这几个都不接受（每一个都是真实会写错的形态）", () => {
    expect(validateBuildInfo(null)).toBeNull();
    expect(validateBuildInfo([])).toBeNull();
    expect(validateBuildInfo({ ...GOOD, schema: "1" })).toBeNull();          // 字符串 schema
    expect(validateBuildInfo({ ...GOOD, commit: "A".repeat(40) })).toBeNull(); // 大写 hex
    expect(validateBuildInfo({ ...GOOD, commit: "a".repeat(39) })).toBeNull();
    expect(validateBuildInfo({ ...GOOD, dirty: "false" })).toBeNull();        // 字符串布尔
    expect(validateBuildInfo({ ...GOOD, built_at: "2026-10-31 17:00:00" })).toBeNull(); // 非 ISO-Z
    expect(validateBuildInfo({ ...GOOD, built_at: "yesterday" })).toBeNull();
    expect(validateBuildInfo({ ...GOOD, source: 42 })).toBeNull();
  });

  test("脏树可以注入，但读数里必须看得见 dirty —— 否则「脏树构建」会被当成提交", () => {
    const dirty = validateBuildInfo({ ...GOOD, dirty: true });
    expect(dirty?.dirty).toBe(true);
    expect(dirty?.commit).toBe(SHA);
  });
});

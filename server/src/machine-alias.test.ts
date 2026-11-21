import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "anet-machine-alias-"));
process.env.COMMHUB_DB ||= join(DIR, "hub.db");

let mod: typeof import("./machine-alias.js");

beforeAll(async () => {
  process.env.COMMHUB_AUTH_TOKEN ||= "legacy-master-token-for-test";
  mod = await import("./machine-alias.js");
});
afterAll(() => { try { rmSync(DIR, { recursive: true, force: true }); } catch {} });

describe("machine alias（#admin 2026-11-21）", () => {
  test("set → get，同一 hostname 覆盖写（一台机器一个别名）", () => {
    mod.setMachineAlias("host-a", "机房 A 主力机", "u1");
    expect(mod.getMachineAlias("host-a")?.alias).toBe("机房 A 主力机");
    mod.setMachineAlias("host-a", "机房 A（改名）", "u2");
    expect(mod.getMachineAlias("host-a")?.alias).toBe("机房 A（改名）");
  });

  test("不同 hostname 互不影响", () => {
    mod.setMachineAlias("host-b", "B 机", "u1");
    expect(mod.getMachineAlias("host-a")?.alias).toBe("机房 A（改名）");
    expect(mod.getMachineAlias("host-b")?.alias).toBe("B 机");
  });

  test("清除后回到未设置（未设置 ⇒ 前端应回落到 hostname）", () => {
    expect(mod.clearMachineAlias("host-b")).toBe(true);
    expect(mod.getMachineAlias("host-b")).toBeNull();
  });

  test("别名校验：空 / 超长 / 控制字符都拒绝，首尾空白会 trim", () => {
    expect(mod.normalizeMachineAlias("   ")).toBeNull();
    expect(mod.normalizeMachineAlias("x".repeat(65))).toBeNull();
    expect(mod.normalizeMachineAlias("bad\x00name")).toBeNull();
    expect(mod.normalizeMachineAlias("  正常名字  ")).toBe("正常名字");
  });
});

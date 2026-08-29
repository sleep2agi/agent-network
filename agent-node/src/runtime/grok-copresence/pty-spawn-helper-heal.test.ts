import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ensurePtySpawnHelperExecutable } from "./runtime";

// #1399 —— npm 解包剥掉 spawn-helper 执行位后,运行时在 spawn 前自愈。
describe("ensurePtySpawnHelperExecutable (#1399)", () => {
  test("644 的 darwin spawn-helper 被修成可执行;缺失架构静默跳过", () => {
    const root = join(tmpdir(), `pty-heal-${process.pid}-${Math.random().toString(36).slice(2)}`);
    const arm = join(root, "prebuilds", "darwin-arm64");
    mkdirSync(arm, { recursive: true });
    const helper = join(arm, "spawn-helper");
    writeFileSync(helper, "x");
    chmodSync(helper, 0o644);
    try {
      ensurePtySpawnHelperExecutable(
        (id: string) => { expect(id).toBe("node-pty/package.json"); return join(root, "package.json"); },
      );
      expect(statSync(helper).mode & 0o111).not.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("resolve 抛错时静默不炸(node-pty 缺失场景交给 import 报错)", () => {
    expect(() => ensurePtySpawnHelperExecutable(() => { throw new Error("not found"); })).not.toThrow();
  });
});

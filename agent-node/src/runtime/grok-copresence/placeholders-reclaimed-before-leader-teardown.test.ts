// #1422 —— stop 时占位文件必须在 leader 拆卸**之前**回收。
// 拆卸链原来是 …→ terminateOwnedPty → teardownOwnedLeader → finalizeStoppedState(才删占位文件);
// `anet node stop` 只给 10 s 宽限,leader 拆卸吃掉宽限就 SIGKILL,占位文件留下(test225 偶红)。
// 判据:teardownOwnedLeader 开始执行时,项目目录里 5 个 0 字节 0444 占位文件已经不在。
import { describe, expect, test } from "bun:test";
import { closeSync, existsSync, openSync } from "fs";
import { join } from "path";
import { withHumanTui } from "./copresence-human-fixture";

const PLACEHOLDERS = [".grok", ".claude", ".cursor", ".mcp.json", ".envrc"];

describe("#1422 project placeholders are reclaimed before leader teardown", () => {
  test("teardownOwnedLeader observes an already-clean project dir", async () => {
    await withHumanTui(async ({ fixture, runtime }) => {
      for (const name of PLACEHOLDERS) {
        closeSync(openSync(join(fixture.cwd, name), "wx", 0o444));
      }
      const present = () => PLACEHOLDERS.filter((name) => existsSync(join(fixture.cwd, name)));
      expect(present()).toEqual(PLACEHOLDERS);

      const seenAtLeaderTeardown: string[][] = [];
      const original = (runtime as any).teardownOwnedLeader.bind(runtime);
      (runtime as any).teardownOwnedLeader = async () => {
        seenAtLeaderTeardown.push(present());
        return original();
      };

      await runtime.close();
      expect(seenAtLeaderTeardown).toHaveLength(1);
      expect(seenAtLeaderTeardown[0]).toEqual([]);
      expect(present()).toEqual([]);
    });
  });
});

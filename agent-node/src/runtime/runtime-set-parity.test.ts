// #1298 — 跨包等价门。
//
// daemon 的 create_node 有三道闸，历史上三道各自硬编码了同一份三元组，于是
// grok-build-cli / codex-app-server / opencode-cli 三个共存 runtime 在 CLI 上
// 可用、在 daemon 上一个都创建不出来。收敛之后 canonical 只有一处：
//   agent-network/src/normalize-runtime.ts → SUPPORTED_RUNTIME_NAMES
//
// 但 agent-node 不依赖 agent-network（两个 npm 包，无 workspace），所以
// create-node-daemon.ts 里那份有效性集合只能是副本。本仓已有的镜像做法
// （im/access-resolve.ts）只有一句「MUST stay in sync」注释、没有门 —— 那正是
// 产生这个 bug 的机制。这条测试就是那道门：改了 canonical 而没同步副本，它红。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SUPPORTED_RUNTIME_NAMES } from "../../../agent-network/src/normalize-runtime";
import { _internals } from "./create-node-daemon";

describe("#1298 runtime 集合跨包一致", () => {
  test("daemon 的 VALID_RUNTIMES 与 canonical 逐字相等", () => {
    const daemon = [..._internals.VALID_RUNTIMES].sort();
    const canonical = [...SUPPORTED_RUNTIME_NAMES].sort();
    // 用 toEqual 而不是比长度：长度相等但内容不同的漂移必须也能红。
    expect(daemon).toEqual(canonical);
  });

  test("三个 TUI 共存 runtime 都在里面（这是 #1298 的验收面）", () => {
    for (const rt of ["grok-build-cli", "codex-app-server", "opencode-cli"]) {
      expect(_internals.VALID_RUNTIMES.has(rt)).toBe(true);
      expect(SUPPORTED_RUNTIME_NAMES).toContain(rt as any);
    }
  });

  test("anet daemon init 写进配置的能力声明引用 canonical，而不是又一份手写数组", () => {
    // 判据落在源码文本上：这里要断言的是「没有第二份清单」这件结构事实，
    // 而运行 daemon init 需要 hub + 登录态，在单测里够不到。
    const cliSrc = readFileSync(join(import.meta.dir, "../../../agent-network/bin/cli.ts"), "utf8");
    expect(cliSrc).toContain("runtimes_supported: [...SUPPORTED_RUNTIME_NAMES]");
    // 旧的硬编码三元组不能再出现在能力声明里
    expect(cliSrc).not.toContain('runtimes_supported: ["claude-agent-sdk", "codex-sdk", "grok-build-acp"]');
  });
});

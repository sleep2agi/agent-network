// #2224 —— 防回归：`agent-node/src` 里**裸 `renameSync(`** 只允许出现在白名单里。
//
// 背景（2026-10-25 现场）：
//   Windows 上把 tmp 覆盖到“正被别的句柄打开”的目标会失败（EPERM/EBUSY/EACCES），
//   而 POSIX 永远成功 —— 于是同一段原子写在 Linux 全绿、在 Windows 上偶发红（#2222）。
//   `shared/windows-rename-retry.ts` 的 `renameOverExistingSync()` 就是为此：仅 win32、
//   仅这三个错误码、退避 10/25/50/100/200ms（5 次），其它错误一律原样抛。
//
// 为什么要有这道测试：
//   #2222 修了 1 处、.158 又改了一批，但**下一个人**只要写一句 `renameSync(tmp, path)`
//   就会把同一个平台 bug 种回来，而 CI（Linux）看不见它。这里把“还能出现裸 renameSync
//   的位置”变成一份**带理由的白名单**：新增一处不加理由就红。
//
// 加白名单的门槛：必须能说清“为什么这里**不该**重试”。说不清 = 它其实该换成
// `renameOverExistingSync()`。

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dir, "..");

/** 允许保留裸 `renameSync(` 的位置，每一条都必须给理由。 */
const ALLOWED: Record<string, string> = {
  "runtime/opencode-copresence/v1-scoped-mcp.ts":
    "恢复/回滚路径：rename 是把备份搬回配置；重试会把“一次失败”拖成更慢的错误决策，且调用点已有 same() 校验与 refuse() 兜底。",
  "runtime/opencode-acp/child-env.ts":
    "目录级 quarantine / 还原 launchRoot：目录 rename 的失败语义与“文件被占用”不同，重试会掩盖真正的权限/布局问题。",
  "runtime/opencode-copresence/attach-tui.ts":
    "record → prev 的轮转：失败后该处直接 rm 兜底（下一次启动会重建），重试没有收益。",
  "runtime/stop-daemon.ts":
    "依赖注入口（deps.renameDir）：调用方语义由测试与 daemon 生命周期决定，不在本卡的“私有状态原子写”范围内。",
  "codex-auth-fingerprint.ts":
    "#3017 承诺：本文件与 agent-network 里那份必须**逐字节相同**、且只 import node 内置模块；引入 shared helper 会破坏该约束。改动需同时改两份并更新 pin。",
  "runtime/codex-app-server/start-resource-gate.ts":
    "把过期的 lock 搬进 grave：这是**清理**动作，失败就当作“没清掉”返回 false，调用方会继续用新鲜 lock；重试没有意义。",
  "runtime/grok-build-cli-home.ts":
    "quarantine 目录搬运（唯一一处残留是 path → quarantine）：目录级、且之后有校验；与文件被占用不是同一类失败。",
  "shared/windows-rename-retry.ts":
    "helper 自身（内部就是要调用一次裸 rename）。",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      walk(full, out);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("#2224 windows rename coverage", () => {
  test("裸 renameSync( 只出现在带理由的白名单里", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file).replaceAll("\\", "/");
      const body = readFileSync(file, "utf8");
      // 只看真实的调用，不看 import 与注释里的字样
      const lines = body.split("\n");
      for (const [i, line] of lines.entries()) {
        if (!/\brenameSync\s*\(/.test(line)) continue;
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
        if (/import\s*\{[^}]*\brenameSync\b/.test(body) && /^import /.test(line)) continue;
        if (ALLOWED[rel]) continue;
        offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("白名单里的文件仍然存在（防止改名后白名单悄悄失效）", () => {
    for (const rel of Object.keys(ALLOWED)) {
      expect(() => statSync(join(SRC, rel))).not.toThrow();
    }
  });
});

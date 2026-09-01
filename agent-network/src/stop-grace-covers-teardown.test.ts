import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// #1522 —— `anet node stop` 先 SIGTERM 再等一个宽限，然后 SIGKILL。
// 如果那个宽限**小于** agent-node 拆卸链的最坏耗时，清理代码就会在最坏路径上
// 被 SIGKILL 打断，留下 post-stop 残留（实测断言：
// `post-stop cleanup retained pinned project sandbox placeholder: .grok`）。
//
// 这条不等式此前**没有任何守卫**：两个常量分在两个包里，谁调小任何一边都不会有人发现。
// 修的时候容易只改一处；这条测试把两边绑在一起。
//
// 🔴 注意方向：要修必须**抬 CLI 侧的宽限**，不要去缩 leader-lifecycle 的 timeoutMs ——
//    那 2 秒之后紧跟着 `assertIdentityStillOwnsListener`，是 SIGKILL 升级前重做
//    完整身份绑定的窗口，用来挡同 UID 的 PID 复用竞态（Node 无 pidfd_send_signal）。

const CLI = readFileSync(join(import.meta.dir, "..", "bin", "cli.ts"), "utf-8");
const LIFECYCLE = readFileSync(
  join(import.meta.dir, "..", "..", "agent-node", "src", "runtime", "grok-copresence", "leader-lifecycle.ts"),
  "utf-8",
);

// 数字字面量允许 `_` 分隔符：`10_000` 用 `[0-9][0-9_]*` 才抓得到，`[0-9]+` 会抓成 `10`。
function num(text: string, re: RegExp, what: string): number {
  const m = text.match(re);
  if (!m) throw new Error(`找不到 ${what} —— 它可能被改名或改写了，先确认再调这条测试`);
  return Number(m[1].replaceAll("_", ""));
}

describe("#1522 stop 宽限必须盖得住拆卸链", () => {
  const termGraceMs = num(CLI, /const termDeadline = Date\.now\(\) \+ ([0-9][0-9_]*);/, "CLI 的 termDeadline");
  const leaderStepMs = num(
    LIFECYCLE,
    /export async function terminateOwnedGrokLeader\([\s\S]{0,200}?timeoutMs = ([0-9][0-9_]*),/,
    "terminateOwnedGrokLeader 的 timeoutMs",
  );

  // 一次调用最坏 = SIGTERM 等 timeoutMs + SIGKILL 等 timeoutMs；该函数在拆卸链里被调用两次。
  const worstTeardownMs = leaderStepMs * 2 * 2;

  it("两个常量都还在（改名了要来更新这条测试，而不是让它静默失效）", () => {
    expect(termGraceMs).toBeGreaterThan(0);
    expect(leaderStepMs).toBeGreaterThan(0);
  });

  it("CLI 宽限 > 拆卸链最坏耗时", () => {
    expect(worstTeardownMs).toBe(leaderStepMs * 4);
    expect(termGraceMs).toBeGreaterThan(worstTeardownMs);
  });
});

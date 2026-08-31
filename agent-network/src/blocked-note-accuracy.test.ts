import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// `anet status` 的 Needs attention 一节里，关于 blocked 的说明原本写着
// 「只有 report_completion 会把 status 清回 idle」。**那句是错的**：
//
//   server/src/tools.ts 的 report_status upsert 里
//     status = ?10                       ← 无条件覆盖（同句其余二十来个字段全是 COALESCE）
//
// 所以 report_status(status="idle") 就能清。真正让 grok 共存节点出不来的是
//   agent-node/src/runtime/grok-copresence/liveness.ts
//     if (!liveness.usable && (requested === "idle" || requested === "working")) return "blocked";
// —— agent-node 每 3 分钟上报的 idle 在发出前被改写成 blocked（#1606）。
//
// 🔴 这条测试只钉「不要再断言那个错的机制」和「要提到共存这种可能」，
//    **不钉任何建议动作** —— 在 #1606 定案前，任何「调 X 就能清」都会误导。

const CLI = readFileSync(join(import.meta.dir, "..", "bin", "cli.ts"), "utf-8");

describe("anet status 对 blocked 的说明", () => {
  it("🔴 不再声称只有 report_completion 能清", () => {
    expect(CLI).not.toContain("report_completion");
  });

  it("说明 grok 共存节点的 blocked 可能是「共存运行时不可用」", () => {
    expect(CLI).toContain("共存运行时不可用");
    expect(CLI).toContain("#1606");
  });

  it("保留两条经得起复核的事实", () => {
    expect(CLI).toContain("blocked ≠ 停了");      // 实测：blocked 节点仍能秒回任务
    expect(CLI).toContain("发一条任务试试");        // 唯一安全的验活方式
  });
});

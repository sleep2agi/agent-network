// cancel 的端到端实测暴露：control 行既不是 task 也不是 message，
// SSE new_message 在 copresence 模式下只唤醒「信息通道」（只排空 type=message），
// 工作通道只在 new_task/broadcast 唤醒 ⇒ control 行两条 lane 都不收。
// 现场：通信猫回合进行中发出 control，回合结束后该行仍 acked=0，节点再也没取。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("control 消息必须唤醒工作通道", () => {
  const src = readFileSync(join(import.meta.dir, "cli.ts"), "utf8");
  test("SSE new_message 分支里，带 control 的事件同时唤醒工作通道", () => {
    const i = src.indexOf('if (ev.type === "new_message" && RUNTIME === "opencode" && opencodeMode === "copresence")');
    expect(i).toBeGreaterThan(-1);
    const block = src.slice(i, i + 1100);
    expect(block).toContain("scheduleInformationalInboxDrain()");
    // control 事件既唤醒串行工作通道（fallback），又并发取 control 行立刻打断（不串在回合后面）。
    expect(block).toContain("if ((ev as any).control)");
    expect(block).toContain("processControlInstruction");
  });
  test("工作通道的分派里认识 control（不把它当任务跑）", () => {
    expect(src).toContain('if ((msg.type || "task") === "control")');
    expect(src).toContain("parseControlOp");
  });
});

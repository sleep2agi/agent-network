// #4685 —— send_message(steer:true) 在节点侧的接线（源码守护，行为已由 Hub 侧测试钉住）。
// 钉住：meta.delivery==="steer" 的消息必须走 runtime.steer，而不是排队 / 丢弃。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("steer 消息必须并进当前轮次（不排队、不丢弃）", () => {
  const src = readFileSync(join(import.meta.dir, "cli.ts"), "utf8");

  test("wantsSteer 只认 meta.delivery==='steer'", () => {
    expect(src).toContain('meta?.delivery === "steer"');
  });

  test("message 消费里有 steer 分支，且调 session.steer", () => {
    const i = src.indexOf('if ((msg.type || "task") === "message" && RUNTIME === "opencode" && opencodeMode === "copresence" && wantsSteer(msg))');
    expect(i).toBeGreaterThan(-1);
    const block = src.slice(i, i + 1200);
    expect(block).toContain("session.steer(");
    expect(block).toContain("delivered: \"steer\"");
    expect(block).toContain('steer ${JSON.stringify(outcome)}');
  });

  test("没有在跑的一轮 / 不支持时判 missed（丢弃，不静默）", () => {
    const i = src.indexOf('&& wantsSteer(msg))');
    const block = src.slice(i, i + 1200);
    expect(block).toContain('delivered: "missed", reason: "no-running-turn"');
  });
});

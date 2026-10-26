// #2363 —— 心跳与刷新都要有抖动：Hub 的内存与“同时在飞的请求数”成正比（隔离实验：
// 50/100/200 并发 → 249/446/689 MB，`send_message` 与 `get_inbox` 一样），而 367 个会话若在
// 同一秒发心跳，就会周期性制造一批同时在飞的请求。这里用源码断言钉住“排期带抖动”这件事，
// 防止以后有人把 `setTimeout` 改回 `setInterval`（那样抖动就没了）。

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dir, "..", "cli.ts"), "utf8");

describe("#2363 heartbeat jitter", () => {
  test("heartbeat 走“setTimeout + 重新排期”，并且加随机抖动", () => {
    expect(src).toContain("const scheduleHeartbeat = (): void => {");
    expect(src).toContain("setTimeout(() => { heartbeatTick(); scheduleHeartbeat(); }, STATUS_HEARTBEAT_MS + jitter)");
    expect(src).toContain("Math.floor(Math.random() * STATUS_HEARTBEAT_JITTER_MS)");
    expect(src).toContain("scheduleHeartbeat();");
  });

  test("心跳抖动有环境变量覆盖，且测试可以关掉（=0）", () => {
    expect(src).toContain('process.env.ANET_STATUS_HEARTBEAT_JITTER_MS');
    expect(src).toContain("if (Number.isFinite(raw) && raw >= 0 && raw <= 60_000) return raw;");
  });

  test("会话控制刷新也带抖动（不再是裸的 30s setInterval）", () => {
    expect(src).toContain("const refreshWithJitter = (): void => {");
    expect(src).toContain("30_000 + Math.floor(Math.random() * 9_000)");
    expect(src).not.toContain("setInterval(refreshSessionControl, 30_000)");
  });

  test("心跳 tick 本体仍然保持原来的三种分支（满载 / 回合中 / idle）", () => {
    expect(src).toContain('live.task.startsWith("模型满载，")');
    expect(src).toContain("if (activeTurnTask) { // board668-keep-working");
    expect(src).toContain('reportStatus("idle").catch(() => {});');
  });
});

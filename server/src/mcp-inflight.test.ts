// #2363 —— MCP 在飞计数的单测 + 源码断言。
//
// 计数值本身很小，但它是“RSS 尖峰能不能被解释”的唯一在线指标：`sse_connections`
// 只反映长连接，看不到同秒打进来的一批短请求。这里钉住三件事：
//   1. enter/leave 必须配平（含重复 leave 不把计数打成负数）；
//   2. 峰值要能记住高水位，并能被显式重置；
//   3. server.ts 必须在**任何 await 之前**进入计数，并且在“正常关闭 / 抛异常”
//      两条路径上都退出计数——少一条就会让指标永远偏高，比没有指标更糟。

import { describe, expect, test, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  enterMcpInflight,
  leaveMcpInflight,
  getMcpInflightStats,
  resetMcpInflightPeak,
} from "./mcp-inflight.js";

beforeEach(() => {
  // 模块级单例：每个用例从 0 开始，避免用例顺序影响。
  while (getMcpInflightStats().inflight > 0) leaveMcpInflight();
  resetMcpInflightPeak();
});

describe("#2363 mcp inflight counter", () => {
  test("enter/leave 配平，peak 记住高水位且不自己回落", () => {
    expect(getMcpInflightStats()).toEqual({ inflight: 0, peak: 0 });
    enterMcpInflight();
    enterMcpInflight();
    enterMcpInflight();
    expect(getMcpInflightStats()).toEqual({ inflight: 3, peak: 3 });
    leaveMcpInflight();
    leaveMcpInflight();
    // 当前只有 1 条在飞，但峰值仍是 3 —— 峰值是“撞过悬崖没有”的证据。
    expect(getMcpInflightStats()).toEqual({ inflight: 1, peak: 3 });
    leaveMcpInflight();
    expect(getMcpInflightStats()).toEqual({ inflight: 0, peak: 3 });
  });

  test("多余的 leave 不会把计数打成负数", () => {
    leaveMcpInflight();
    leaveMcpInflight();
    expect(getMcpInflightStats().inflight).toBe(0);
  });

  test("reset 把峰值对齐到当前在飞数（不会把峰值压到低于现况）", () => {
    enterMcpInflight();
    enterMcpInflight();
    expect(getMcpInflightStats().peak).toBe(2);
    leaveMcpInflight();
    resetMcpInflightPeak();
    expect(getMcpInflightStats()).toEqual({ inflight: 1, peak: 1 });
  });
});

describe("#2363 server wiring (source assertions)", () => {
  const src = readFileSync(join(import.meta.dir, "server.ts"), "utf8");

  test("进入计数发生在创建 transport 之前（请求体解析阶段也要计入）", () => {
    const enterAt = src.indexOf("enterMcpInflight();");
    const transportAt = src.indexOf("new WebStandardStreamableHTTPServerTransport({", enterAt);
    expect(enterAt).toBeGreaterThan(0);
    expect(transportAt).toBeGreaterThan(enterAt);
  });

  test("两条退出路径都在：handleRequest 抛异常时、以及 MCP server 关闭后", () => {
    // 抛异常路径
    expect(src).toContain("settleMcpInflight();\n        throw e;");
    // 正常路径（setImmediate 里 close 完成后结算，且重复调用安全）
    expect(src).toContain("mcpServer.close().catch(() => {}).finally(settleMcpInflight)");
    // 幂等闸门：只允许真正减一次
    expect(src).toContain("if (mcpInflightSettled) return;");
  });

  test("/health 暴露的是聚合值（匿名也安全），且没有 new 的按会话明细", () => {
    expect(src).toContain("mcp_inflight: getMcpInflightStats().inflight,");
    expect(src).toContain("mcp_inflight_peak: getMcpInflightStats().peak,");
    expect(src).not.toContain("mcp_inflight_sessions");
  });

  test("这一版只观测：/mcp 入口不得出现 429 / 拒绝分支", () => {
    const mcpStart = src.indexOf('if (url.pathname === "/mcp") {');
    const mcpEnd = src.indexOf("// ── #461 SSE network observer stream ──", mcpStart);
    expect(mcpStart).toBeGreaterThan(0);
    expect(mcpEnd).toBeGreaterThan(mcpStart);
    const block = src.slice(mcpStart, mcpEnd);
    expect(block).not.toContain("429");
    expect(block).not.toContain("hub_busy");
    expect(block).not.toContain("Retry-After");
  });
});

// 负责人 2026-11-21 真机：agy 节点配了 claude-sonnet-5-5-high，真实任务自报 "Gemini 4 Neon"。
// 根因是 `processWithAntigravity` 调用 runAgyAcpTurn 时**从来没传 model**，
// applyConfiguredModel 拿到空 requested 就直接按会话默认模型跑。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const cli = readFileSync(new URL("../../cli.ts", import.meta.url), "utf8");

/** 取出 processWithAntigravity 的函数体（到下一个顶层 async function 为止）。 */
function antigravityBody(): string {
  const start = cli.indexOf("async function processWithAntigravity");
  expect(start).toBeGreaterThan(0);
  const rest = cli.slice(start);
  const end = rest.indexOf("\nasync function ", 10);
  return end > 0 ? rest.slice(0, end) : rest;
}

describe("agy runtime receives the configured model", () => {
  it("passes model: MODEL to runAgyAcpTurn", () => {
    const body = antigravityBody();
    expect(body).toContain("runAgyAcpTurn(");
    expect(body).toContain("model: MODEL || undefined");
  });

  it("passes it before mcpServers (same shape grok uses)", () => {
    const body = antigravityBody();
    const call = body.slice(body.indexOf("runAgyAcpTurn("));
    const modelAt = call.indexOf("model: MODEL || undefined");
    expect(modelAt).toBeGreaterThan(0);
    expect(modelAt).toBeLessThan(call.indexOf("mcpServers"));
  });
});

import { describe, expect, test } from "bun:test";
import { describeCopresenceStartupFailure } from "./copresence-startup-diagnosis";

const base = {
  attachScript: "/p/.anet/nodes/n1/opencode-attach.sh",
  bridgeLog: "/p/.anet/nodes/n1/logs/copresence-bridge.log",
  nodeLogDir: "/p/.anet/nodes/n1/logs",
  bridgeAlive: false,
  waitedSeconds: 30,
  logTail: "",
  paneTail: "",
};

describe("共存启动失败的诊断文案", () => {
  test("🔴 bridge 死了和 bridge 还活着，说的是两件不同的事", () => {
    const dead = describeCopresenceStartupFailure(base).join("\n");
    const alive = describeCopresenceStartupFailure({ ...base, bridgeAlive: true }).join("\n");
    expect(dead).toContain("bridge 已经退出");
    expect(alive).toContain("bridge 还在跑");
    expect(dead).not.toContain("bridge 还在跑");
    expect(alive).not.toContain("bridge 已经退出");
  });

  test("🔴 会话已死时，落盘日志仍然能把死因带出来（pane 此时必然是空）", () => {
    const out = describeCopresenceStartupFailure({
      ...base,
      logTail: "MCP error -32602: expected string, received null at host.ip",
      paneTail: "",
    }).join("\n");
    expect(out).toContain("host.ip");
    expect(out).toContain("bridge 最后的输出");
  });

  test("落盘日志为空时退回 pane 尾巴", () => {
    const out = describeCopresenceStartupFailure({ ...base, paneTail: "pane says boom" }).join("\n");
    expect(out).toContain("pane says boom");
  });

  test("两边都没有时，明说「没有输出」，不留空白让人读成「没异常」", () => {
    const out = describeCopresenceStartupFailure(base).join("\n");
    expect(out).toContain("bridge 没有留下任何输出");
  });

  test("总是给出两个可去的位置和等待时长", () => {
    const out = describeCopresenceStartupFailure(base).join("\n");
    expect(out).toContain(base.bridgeLog);
    expect(out).toContain(base.nodeLogDir);
    expect(out).toContain(base.attachScript);
    expect(out).toContain("30s");
  });

  // 🔴 这两条来自 #1225 的第一版：按字节取尾拿到的是一行 minified bundle 的
  //    中段，屏幕滚了半屏乱码，真正的 `MCP error` 反而被挤出去了。
  test("🔴 一行超长的 minified 代码不会把真正的报错挤掉", () => {
    const noise = "a".repeat(40_000);
    const out = describeCopresenceStartupFailure({
      ...base,
      logTail: `${noise}\nMCP error -32602: expected string, received null at host.ip`,
    }).join("\n");
    expect(out).toContain("host.ip");
    expect(out).toContain("本行另有");
    expect(out.length).toBeLessThan(5_000);
  });

  test("按行取尾：只留最后 20 行", () => {
    const many = Array.from({ length: 100 }, (_, i) => `line-${i}`).join("\n");
    const out = describeCopresenceStartupFailure({ ...base, logTail: many }).join("\n");
    expect(out).toContain("line-99");
    expect(out).toContain("line-80");
    expect(out).not.toContain("line-79");
  });

  test("尾部空行不算内容 —— 否则「有输出」会被空白撑成 true", () => {
    const out = describeCopresenceStartupFailure({ ...base, logTail: "boom\n\n\n   \n" }).join("\n");
    expect(out).toContain("boom");
    expect(out).not.toContain("bridge 没有留下任何输出");
  });

  test("只陈述观测到的事实，不猜原因", () => {
    const out = describeCopresenceStartupFailure({ ...base, logTail: "boom" }).join("\n");
    for (const guess of ["可能是", "也许", "大概", "opencode 没装", "请重装"]) {
      expect(out).not.toContain(guess);
    }
  });
});

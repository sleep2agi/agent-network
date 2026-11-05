// #3952 —— 节点侧把每轮的 token 用量报给 Hub。
//
// 为什么需要源码契约测试：用量上报是**旁路** —— 报不上时回合照样成功、心跳照样绿。
// 于是它漏了也没人喊（这正是它此前一直只写日志的原因）。判据只能钉在「调用点还在不在、
// 是不是挂在拿到数字之后」。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dir, "cli.ts"), "utf8");

function fnBody(signature: string): string {
  const start = src.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  // 顶层函数以列 0 的 `}` 收尾（不数括号：签名里有对象类型字面量）
  const end = src.indexOf("\n}\n", start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end + 3);
}

describe("#3952 节点上报 token 用量", () => {
  test("上报函数存在，且失败被吞掉（不阻塞回合）", () => {
    const body = fnBody("function reportTokenUsage(");
    expect(body).toContain('callCommHub("report_token_usage"');
    expect(body).toMatch(/\.catch\(/);
    // 镜像否定：不许 await —— 记账不该让回合等待
    expect(body).not.toMatch(/await callCommHub\("report_token_usage"/);
  });

  test("claude 与 codex 两条路径都接了（只接一条 = 另一种运行时永远没有数据）", () => {
    expect(src).toContain("reportTokenUsage(MODEL, u.input_tokens, u.output_tokens");
    expect(src).toContain("reportTokenUsage(MODEL, outcome.usage?.input_tokens, outcome.usage?.output_tokens)");
  });

  test("claude 路径把 turns / cost 一起带上（它们本来就在 result message 里）", () => {
    const idx = src.indexOf("reportTokenUsage(MODEL, u.input_tokens, u.output_tokens");
    const tail = src.slice(idx, idx + 400);
    expect(tail).toContain("turns:");
    expect(tail).toContain("costUsd:");
  });

  test("只报计数：调用点附近不出现 prompt / content / message 之类的字段", () => {
    const idx = src.indexOf("reportTokenUsage(MODEL, u.input_tokens, u.output_tokens");
    const tail = src.slice(idx, idx + 400);
    expect(tail).not.toMatch(/prompt|content|message_id|credential/i);
  });
});

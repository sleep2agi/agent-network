import { describe, expect, test } from "bun:test";
import { GET_TASK_TOOL_LINE, POLL_DISCIPLINE_LINES, POLL_STEP_LINES } from "./poll-discipline-guidance";

// #3001 —— 提示词也要能被断言钉住。
// 现场：cli.ts 里原来只写「用 get_task 轮询子任务直到 replied/failed」，**没有间隔约定**，
// 于是一个节点在空闲等待里以约 13 次/分钟连续拉了 8 小时 get_task（约 6000 次），
// 每次都是一整轮 LLM —— 成本全花在「看有没有好」。
describe("#3001 轮询纪律", () => {
  test("工具清单那行明确写出 60 秒间隔", () => {
    expect(GET_TASK_TOOL_LINE).toContain("get_task");
    expect(GET_TASK_TOOL_LINE).toContain("至少隔 60 秒");
  });

  test("流程第 3 步同时给出间隔与成本理由", () => {
    const text = POLL_STEP_LINES.join("\n");
    expect(text).toContain("至少隔 60 秒");
    expect(text).toContain("一整轮 LLM");
  });

  test("纪律小节包含实测数字与「不会丢结果」的安抚", () => {
    const text = POLL_DISCIPLINE_LINES.join("\n");
    expect(text).toContain("13 次/分钟");
    expect(text).toContain("6000 次");
    // 关键：必须告诉 agent「不盯着也不会丢」——否则它仍会紧轮询
    expect(text).toContain("chain 回上游");
  });

  test("不再出现「连续轮询直到完成」这种没有间隔的措辞", () => {
    const all = [GET_TASK_TOOL_LINE, ...POLL_STEP_LINES, ...POLL_DISCIPLINE_LINES].join("\n");
    expect(all).not.toContain("要连续轮询");
    expect(all).not.toContain("立刻重试");
  });
});

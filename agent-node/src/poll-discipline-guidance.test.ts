import { describe, expect, test } from "bun:test";
import { GET_TASK_TOOL_LINE, IDENTITY_POLL_DISCIPLINE_LINES, POLL_DISCIPLINE_LINES, POLL_STEP_LINES } from "./poll-discipline-guidance";

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

// #3119 —— 与 #3001 同族：把「不要在空闲里烧调用」写进提示词，并钉住它不会退回原样。
describe("#3119 不要反复确认自己", () => {
  const text = IDENTITY_POLL_DISCIPLINE_LINES.join("\n");

  test("明确说 whoami 答案在启动时就定了", () => {
    expect(text).toContain("org_whoami");
    expect(text).toContain("进程启动时就定了");
  });

  test("给出实测数字（否则它只是意见）", () => {
    expect(text).toContain("6,474");
    expect(text).toContain("5,738");
    expect(text).toContain("56%");
  });

  test("把 list_tasks / get_task 也算进同一族，并给出四项合计比例", () => {
    expect(text).toContain("list_tasks");
    expect(text).toContain("get_task");
    expect(text).toContain("84.9%");
  });

  test("说明「活是推来的」，并给出间隔底线", () => {
    expect(text).toContain("推");
    expect(text).toContain("至少隔 5 分钟");
  });

  test("cli 的提示词里真的注入了这一段（不是只写在常量里）", () => {
    const cli = require("node:fs").readFileSync(
      new URL("./cli.ts", import.meta.url), "utf8") as string;
    // 必须断言**展开那一行**（三个点），只匹配常量名会被 import 行满足 —— 实测撞到
    expect(cli).toContain("...IDENTITY_POLL_DISCIPLINE_LINES");
  });
});

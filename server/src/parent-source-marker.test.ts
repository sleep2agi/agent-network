// #669 —— parent_task_id 的来源必须可区分（显式 / 推断）。
//
// 没有这个标记时，那张卡要求的前置统计做不出来：tasks 表只存 parent_task_id，
// 不记它是怎么来的（实测近 7 天 949 条里 0 条可区分）。
//
// 这里不测完整派发链路，只钉住「来源判定 + 写进 meta」这一段的行为：
//   · 显式带了 parent_task_id        → parent_source = "explicit"
//   · 没带但被推断命中最近 delivered → parent_source = "inferred"
//   · 两者都没有                     → meta 里没有 parent_source
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./tools.ts", import.meta.url), "utf8");

describe("#669 parent source marker", () => {
  test("显式 parent 记为 explicit，推断命中时改写为 inferred", () => {
    expect(src).toContain('let parentSource: "explicit" | "inferred" | null = parentIn ? "explicit" : null;');
    expect(src).toContain('if (recent?.task_id) { parentTaskId = recent.task_id; parentSource = "inferred"; }');
  });

  test("来源只在确实有 parent 时写进 meta，且序列化失败不影响派发", () => {
    const block = src.slice(src.indexOf("let metaJsonWithParent = metaJson;"), src.indexOf("// round5 F2 fix"));
    expect(block).toContain("if (parentSource && parentTaskId)");
    expect(block).toContain("try {");
    expect(block).toContain("parent_source: parentSource");
    expect(block).toContain("catch {}");
  });

  test("两条 INSERT（inbox / tasks）都用合并后的 meta", () => {
    const inserts = src.split("\n").filter((l) => l.includes("targetAlias, priority, task") || l.includes("effectiveNetId ?? null, parentTaskId"));
    expect(inserts.some((l) => l.includes("metaJsonWithParent"))).toBe(true);
  });

  // 这条原本断言「REST 里根本没有 parent_source」——理由是「REST 不走推断，
  // 不要造第二真相」。方向对，但结论错了一半：REST 确实**不该推断**，
  // 可它建的子任务同样是显式父子关系，不标就会被统计漏掉。
  //
  // 实测（2026-10-29，.195 上线后 90 分钟）：3 条带 parent 的任务全部走 REST、
  // 全部没有 parent_source。而 MCP 那条路是标的 ⇒ 分母只含 MCP，
  // explicit 占比会被系统性压低。#669 要统计的正是这个比例。
  test("REST /api/task 标「显式」，但不推断", () => {
    const rest = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
    expect(rest).toContain("body.parent_task_id ?? null");
    expect(rest).toContain('parent_source: "explicit"');
    // 不能出现第二份推断：REST 里没有「找最近 delivered」这种 SQL。
    const restBlock = rest.slice(rest.indexOf("const metaWithParent"), rest.indexOf("const metaWithParent") + 400);
    expect(restBlock.toLowerCase()).not.toContain("delivered");
    expect(rest).not.toContain('parentSource = "inferred"');
  });
});

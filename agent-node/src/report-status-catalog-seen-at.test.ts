// #3144 —— 节点侧要**真的**把采集时刻带上去。
//
// 为什么需要源码契约测试：Hub 侧的 schema 与投影早就有了（build-commit-report-http.test.ts /
// api-nodes-shape.test.ts 都断言过），缺的一直是**发送端**。而发送端少一格时，
// 界面上只是「没有那个提示」，不报错 —— 于是它可以一路错到有人想起来。
//
// 判据用**守卫位置**而不是行数窗口：模型清单与采集时刻必须在同一个对象字面量里，
// 且采集时刻必须挂在 `reportedCatalog.seenAt ?` 这个条件上（空串时不发，见 catalogReport）。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dir, "cli.ts"), "utf8");

/** 从 `...(reportedCatalog ? {` 起，取到与之配对的 `} : {})`（含）。 */
function catalogBlock(): string {
  const start = src.indexOf("...(reportedCatalog ? {");
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error("catalog block is not balanced");
}

describe("#3144 节点上报 opencode_catalog 与 opencode_catalog_seen_at 同进同出", () => {
  test("同一个对象字面量里既有清单也有采集时刻", () => {
    const block = catalogBlock();
    expect(block).toContain("opencode_catalog: reportedCatalog.models");
    expect(block).toContain("opencode_catalog_seen_at: reportedCatalog.seenAt");
  });

  test("采集时刻挂在 seenAt 为真的条件下 —— 空串时不发，不把「不知道多旧」报成时刻", () => {
    const block = catalogBlock();
    // 守卫位置：seen_at 那一行必须在 `reportedCatalog.seenAt ?` 成立的分支里。
    expect(block).toMatch(/reportedCatalog\.seenAt\s*\?\s*\{[^}]*opencode_catalog_seen_at:/);
    // 镜像否定：不允许无条件地写这一行（那会发出空串，Hub 侧就分不出「没采到」与「时刻坏了」）。
    expect(src).not.toMatch(/^\s*opencode_catalog_seen_at:/m);
  });

  test("清单不再是旧的「整对象」写法（那种写法下时刻无处安放）", () => {
    // 旧写法：opencode_catalog: reportedCatalog —— 那时的 reportedCatalog 是 string[]，
    // 没有地方带时刻。改成对象后，这一行必须指向 .models。
    expect(src).not.toContain("opencode_catalog: reportedCatalog,");
    expect(src).not.toContain("opencode_catalog: reportedCatalog }");
  });
});

/** `async function reportedOpenCodeCatalog(...) { … }` 的函数体（含签名）。 */
function reportedCatalogFn(): string {
  const start = src.indexOf("async function reportedOpenCodeCatalog(");
  expect(start).toBeGreaterThan(-1);
  // 顶层函数以列 0 的 `}` 收尾（这里不能数括号：签名里有 `{ url: string }` 这种类型字面量，
  // 数括号会在签名处就配平，取到的只有一行）。
  const end = src.indexOf("\n}\n", start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end + 3);
}

describe("#3144 读失败不许把清单抹掉（接线，不是只测纯函数）", () => {
  test("成功分支走 keepLastCatalog，失败分支返回上一份而不是 undefined", () => {
    const fn = reportedCatalogFn();
    expect(fn).toContain("keepLastCatalog(lastCatalogReport, catalogReport(snapshot))");
    expect(fn).toMatch(/catch\s*\{[\s\S]*return lastCatalogReport;/);
  });

  test("镜像否定：失败分支不许回到 `catch { return undefined; }`（那正是这次要修的行为）", () => {
    expect(reportedCatalogFn()).not.toMatch(/catch\s*\{\s*return undefined;\s*\}/);
  });
});

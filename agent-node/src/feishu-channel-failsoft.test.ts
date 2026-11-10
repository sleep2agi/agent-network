// #3682 —— **加一个渠道不许把节点搞挂**。
//
// 原来的 initFeishuChannel 在缺 .env / access.json 时 process.exit(1)。
// 那在手工配置的机器上没问题，但对"远端节点试点"是致命的：
// 给节点加 channels 与把文件送到那台机器是两件事，只要顺序稍有错位，
// 节点就在中间那段时间完全离线 —— 看起来像"加个渠道把节点搞挂了"，
// 而且没有任何一行日志说明"只是缺一个文件"。
//
// 现在：缺文件 ⇒ warn + 跳过这个渠道，节点照常起来；补上文件后重启即生效。
// 判据用**源码契约**（守卫位置）：这里没有 process.exit，且有 return null。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dir, "cli.ts"), "utf8");

function initFeishuFn(): string {
  const start = src.indexOf("function initFeishuChannel(");
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf("\n}\n", start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end + 3);
}

describe("#3682 飞书渠道初始化：缺文件不 fatal", () => {
  test("函数体内没有**语句级**的 process.exit（缺文件时不许让节点退出）", () => {
    // 不能用裸 substring：注释里写着"原来的行为是 process.exit(1)"（那是历史，不是代码）。
    // 判据只认行首的调用语句。
    expect(initFeishuFn()).not.toMatch(/^\s*process\.exit\(/m);
  });

  test("缺 access.json 时返回 null 并 warn（守卫在 return 之前）", () => {
    const fn = initFeishuFn();
    const guard = fn.indexOf("if (!existsSync(join(dir, \"access.json\"))) {");
    expect(guard).toBeGreaterThan(-1);
    const tail = fn.slice(guard);
    expect(tail).toContain("warn(");
    expect(tail).toContain("return null;");
    // 镜像肯定断言：warn 必须在 return 之前（反了就变成"静默跳过"）。
    expect(tail.indexOf("warn(")).toBeLessThan(tail.indexOf("return null;"));
  });

  test("CHANNELS 的 feishu 分支会过滤掉 null（否则类型与运行时都会漏一个洞）", () => {
    expect(src).toContain(".filter((ch): ch is FeishuChannel => ch !== null)");
  });
});

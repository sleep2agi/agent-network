import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { nodeCountLine } from "./doctor-node-count";

describe("nodeCountLine", () => {
  test("有节点时是 ok,detail 就是个数", () => {
    const r = nodeCountLine(3);
    expect(r.ok).toBe(true);
    expect((r as { detail: string }).detail).toBe("3 node(s)");
  });

  test("🔴 0 个节点不算 ok —— 但也不能算 error", () => {
    // 这条是整个模块的立论:doctor 只有一个数字,分不出「新装」和「配置没了」。
    const r = nodeCountLine(0);
    expect(r.ok).toBe(false);
    const info = (r as { info: string }).info;
    expect(info).toContain("全新安装");
    expect(info).toContain("anet node create");
    expect(info).toContain("配置目录不见了");
  });

  test("🔴 两种现实都要出现 —— 只说一种就是替用户挑了一个", () => {
    const info = (nodeCountLine(0) as { info: string }).info;
    // 只讲「新装正常」会让配置丢失的人以为没事;
    // 只讲「配置不见了」会吓到刚装好的人。
    expect(info.includes("全新安装") && info.includes("本来有节点")).toBe(true);
  });

  test("坏值按 0 处理,不抛", () => {
    for (const bad of [-1, NaN, Infinity]) {
      expect(nodeCountLine(bad as number).ok).toBe(false);
    }
  });
});

describe("接线守卫", () => {
  // 剥注释行再断言 —— 源码里既有那个东西,也有关于它的说明。
  const cli = readFileSync(new URL("../bin/cli.ts", import.meta.url), "utf8")
    .split("\n")
    .filter(l => { const c = l.trim(); return !c.startsWith("//") && !c.startsWith("*") && !c.startsWith("/*"); })
    .join("\n");

  test("🔴 旧的「0 个就报错」写法不再存在", () => {
    expect(cli).not.toContain('check("Nodes configured", ids.length > 0');
  });

  test("而且确实调用了 nodeCountLine —— 「没有旧写法」也可能是整段被删了", () => {
    expect(cli).toContain("nodeCountLine(ids.length)");
  });
});

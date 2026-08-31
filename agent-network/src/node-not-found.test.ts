import { describe, expect, it } from "bun:test";
import { nodeNotFoundMessage } from "./node-not-found";

describe("nodeNotFoundMessage", () => {
  it("一个节点都没有时,说的是「去建一个」而不是「找不到」", () => {
    const m = nodeNotFoundMessage("通信牛", [], null);
    expect(m).toContain("No nodes are configured here yet");
    expect(m).toContain("anet node create");
    // 🔴 这一格不该报出一串空名单
    expect(m).not.toContain("0 node(s)");
  });

  it("有相近名字时,直接把真名给他", () => {
    const m = nodeNotFoundMessage("通信妞", ["通信牛", "通信马"], "通信牛");
    expect(m).toContain('Did you mean "通信牛"?');
    expect(m).toContain("anet node ls");
  });

  it("有节点但没有相近的,列出真名而不是只说 not found", () => {
    const m = nodeNotFoundMessage("zzz", ["a", "b"], null);
    expect(m).toContain("2 node(s) here: a, b");
    expect(m).toContain("anet node ls");
  });

  it("节点很多时截断,并说清一共多少个 —— 不要刷屏", () => {
    const many = Array.from({ length: 271 }, (_, i) => `n${i}`);
    const m = nodeNotFoundMessage("zzz", many, null);
    expect(m).toContain("n0, n1, n2, n3, n4");
    expect(m).not.toContain("n5,");
    expect(m).toContain("(271 total)");
  });

  it("原来的那句话仍在开头 —— 不破坏既有脚本对前缀的匹配", () => {
    expect(nodeNotFoundMessage("x", [], null).startsWith('Node "x" not found.')).toBe(true);
  });

  it("名字里的引号被转义,不会把消息拼坏", () => {
    expect(nodeNotFoundMessage('a"b', ["c"], null)).toContain('"a\\"b"');
  });

  it("空串/非法项不算进节点数", () => {
    const m = nodeNotFoundMessage("x", ["", "real"], null);
    expect(m).toContain("1 node(s) here: real");
  });
});

// ── 接线守卫：判据对了不代表它被接上 ──
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("cli.ts 的接线", () => {
  // 🔴 先去掉注释行再断言：本文件和 cli.ts 的注释里都引用了那句原话,
  // 不剥的话守卫会命中我自己写的说明。
  const cli = readFileSync(join(import.meta.dir, "..", "bin", "cli.ts"), "utf-8")
    .split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

  it("没有任何一处还在光秃秃地打印 not found（带下一步的那些不算）", () => {
    const bare = [...cli.matchAll(/console\.error\(`Node "\$\{\w+\}" not found\.`\)/g)];
    expect(bare.map(m => m[0])).toEqual([]);
  });

  it("确实接上了 —— nodeNotFound 被多处调用（正控：0 处说明我没接）", () => {
    const calls = [...cli.matchAll(/console\.error\(nodeNotFound\(/g)];
    expect(calls.length).toBeGreaterThanOrEqual(16);
  });

  it("建议的候选集覆盖 resolveNodeRef 认的全部键,不只是显示名", () => {
    const fn = cli.slice(cli.indexOf("function nodeNotFound("), cli.indexOf("function normalizeNodeName("));
    for (const key of ["node_id", "node_name", "alias"]) expect(fn).toContain(key);
    // resolveNodeRef 也认目录 id 本身
    expect(fn).toMatch(/candidates\.add|\[id,/);
  });

  it("带 Create it first 的那些提示没被误伤", () => {
    expect(cli).toContain("not found. Create it first");
    expect(cli).toContain("--runtime codex-sdk");
  });
});

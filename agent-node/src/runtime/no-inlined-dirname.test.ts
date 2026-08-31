import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// #1433 的复发防线。
//
// `bun build --target node` 把 `__dirname` **内联成构建期常量**(同样的 flags
// 做过最小实验:产物换个目录运行,`import.meta.url` 跟着走,`__dirname` 不动)。
// 所以在会被打包进 dist/cli.js 的源码里,`__dirname` 拿去当路径**永远指向构建机**。
//
// 实测代价:三处中招,其中两处在 @openai/codex-sdk 的加载路径上,一处是
// Linux 自动装 claude 的 `npm --prefix` —— 全都恒失效且不出声。
//
// 判据:`__dirname` 只允许出现在 `??` 的**右侧**(即"运行时拿不到时的兜底")。
// 任何别的用法都要红。

const SRC = join(import.meta.dir, "..");

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (p.endsWith(".ts") && !p.includes(".test.")) out.push(p);
  }
  return out;
}

/** 一行里的 `__dirname` 是不是「只作为 ?? 的右侧兜底」。 */
export function dirnameUseIsFallbackOnly(line: string): boolean {
  // 注释里提到不算 —— 行注释、块注释、JSDoc 都要剥。
  const code = line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "").replace(/^\s*\*.*$/, "");
  if (!/\b__dirname\b/.test(code)) return true;
  // 兜底的两种写法都允许,判据是「同一条语句里必须**先有**运行时解析的结果」:
  //   `packageRoot ?? __dirname + "/../"`      —— 空值合并
  //   `packageRoot ? … : __dirname`            —— 三元
  return /\bpackageRoot\b/.test(code) || /\?\?\s*__dirname\b/.test(code);
}

describe("agent-node/src 里不许把 __dirname 当路径用（#1433）", () => {
  it("判据正控:一个真会中招的写法要判 false", () => {
    expect(dirnameUseIsFallbackOnly('  prefix: __dirname + "/../",')).toBe(false);
    expect(dirnameUseIsFallbackOnly("  resolveAgentNodeDir(__dirname),")).toBe(false);
  });

  it("判据反控:作为 ?? 的兜底、或只在注释里提到,都判 true", () => {
    expect(dirnameUseIsFallbackOnly("  return packageRoot ?? __dirname;")).toBe(true);
    expect(dirnameUseIsFallbackOnly("  return packageRoot ? packageRoot + \"/dist\" : __dirname;")).toBe(true);
    expect(dirnameUseIsFallbackOnly("  /** Resolve … from `__dirname`. */")).toBe(true);
    expect(dirnameUseIsFallbackOnly('  prefix: packageRoot ?? __dirname + "/../",')).toBe(true);
    expect(dirnameUseIsFallbackOnly("  // __dirname 会被内联成常量")).toBe(true);
    expect(dirnameUseIsFallbackOnly("  const x = 1;")).toBe(true);
  });

  it("取集正控:确实扫到了 agent-node/src 下成规模的源文件", () => {
    const files = tsFiles(SRC);
    expect(files.length).toBeGreaterThanOrEqual(20);
    expect(files.some(f => f.endsWith("/cli.ts"))).toBe(true);
  });

  it("没有任何一处把 __dirname 当路径用", () => {
    const bad: string[] = [];
    for (const f of tsFiles(SRC)) {
      const lines = readFileSync(f, "utf-8").split("\n");
      lines.forEach((l, i) => {
        if (!dirnameUseIsFallbackOnly(l)) bad.push(`${f.slice(SRC.length + 1)}:${i + 1}`);
      });
    }
    expect(bad).toEqual([]);
  });
});

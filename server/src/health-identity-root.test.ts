// `git_identity_root: module_dir | cwd | build_info` 的**值域 == 生产者集合**。
//
// ## 为什么这一格要一条断言
//
// 这个字段存在的唯一理由，是让读者区分「这份身份是从**包内**读到的」与
// 「是从**启动目录里另一个仓库**读到的」——两者在 `git_commit` 上完全同形。
//
// 于是它自己也就有了同一个毛病：
//   · 声明了某个取值、但没有任何分支会产生它 ⇒ 读者按它设计一条不存在的修法
//   · 某个分支产生了一个没声明的取值 ⇒ 读的人拿到一个不认识的字符串
//
// ## 这份断言是文本级，且**明确它能看见什么**
//
// 两处产生形态：
//   ① 字面量直接写：`root_kind: "build_info"`
//   ② 经由变量写：  `root_kind: rootKind`，而 `rootKind` 的值域由它自己的类型注解给出
// ② 必须跟着走一跳，否则会把「经变量产生」误判成「没人产生」——
// 第一版正是这样：声明了 cwd，而文本里找不到 `root_kind: "cwd"`，于是报了假阳。
//
// 它**看不见**两跳以上的变量链，也看不见运行期拼出来的值。
// ⇒ 结论读作「文本级（含一层变量解析）0 处未声明 / 0 处未产生」，
//    不是「运行期不可能出现别的值」。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./server.ts", import.meta.url), "utf8");

/** 联合类型里声明的取值。 */
export function declaredRootKinds(source: string): string[] {
  const m = source.match(/root_kind:\s*([^;]+);/);
  if (!m) return [];
  return [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
}

/** `root_kind: "x"` 形式的产生点。 */
export function literalRootKinds(source: string): string[] {
  return [...source.matchAll(/root_kind:\s*"([a-z_]+)"/g)].map((m) => m[1]);
}

/** `root_kind: ident` 形式的产生点 ⇒ 跟着一跳，取 ident 自己声明的值域。 */
export function variableRootKinds(source: string): Array<{ ident: string; values: string[] }> {
  const out: Array<{ ident: string; values: string[] }> = [];
  for (const m of source.matchAll(/root_kind:\s*([A-Za-z_]\w*)\s*[,}]/g)) {
    const ident = m[1];
    // `const ident: "a" | "b" = …` —— 一行内能看到的两处字面量就是它的值域
    const decl = source.match(new RegExp(`const\\s+${ident}\\s*:\\s*([^=]+)=`));
    const values = decl ? [...decl[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]) : [];
    out.push({ ident, values });
  }
  return out;
}

describe("git_identity_root 值域 == 生产者集合", () => {
  test("声明集合非空且无重复（否则下面几条会在空集上恒真）", () => {
    const declared = declaredRootKinds(src);
    expect(declared.length).toBeGreaterThanOrEqual(3);
    expect(new Set(declared).size).toBe(declared.length);
  });

  test("① 每个产生点都在声明范围内（含经变量的那一类）", () => {
    const declared = new Set(declaredRootKinds(src));
    const produced = new Set([
      ...literalRootKinds(src),
      ...variableRootKinds(src).flatMap((v) => v.values),
    ]);
    expect([...produced].filter((x) => !declared.has(x))).toEqual([]);
  });

  test("② 每个声明值都有产生点（没有死值）", () => {
    const declared = declaredRootKinds(src);
    const produced = new Set([
      ...literalRootKinds(src),
      ...variableRootKinds(src).flatMap((v) => v.values),
    ]);
    expect(declared.filter((x) => !produced.has(x))).toEqual([]);
  });

  test("③ 三个取值各自的产生方式（向量，不是一个计数）", () => {
    const via = variableRootKinds(src);
    const shape: Record<string, string> = {};
    for (const k of literalRootKinds(src)) shape[k] = "literal";
    for (const v of via) for (const k of v.values) shape[k] = `via ${v.ident}`;
    // 改动这里要有理由：多一条落到同一取值的路径，正是「两个来源同形」的入口。
    expect(shape).toEqual({
      build_info: "literal",
      module_dir: "via rootKind",
      cwd: "via rootKind",
    });
  });

  test("④ 经变量的那一类必须能被解析出值域（否则 ①② 会静默漏掉它）", () => {
    const via = variableRootKinds(src);
    expect(via.length).toBeGreaterThan(0);
    for (const v of via) {
      expect(v.values.length).toBeGreaterThan(0);
    }
  });
});

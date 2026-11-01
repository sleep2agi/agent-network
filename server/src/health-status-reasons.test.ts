// `status_reasons` 的**值域**必须与它的**生产者**逐个对应（外部复核的判据）。
//
// ## 为什么这一格值得一条断言
//
// `/health.status` 只有两个取值（ok / degraded），而 `status_reasons` 是回答
// 「ok 到底是**真的没问题**，还是**检查没跑**」的唯一读数。它的值域偏离生产者时：
//
//     值域比生产者少 ⇒ 两个成因合并成一个字 ⇒ 读的人分不出该修哪（合并）
//     值域比生产者多 ⇒ 有原因却没有任何代码会产生它 ⇒ 读者为它设计一条不存在的修法（死值）
//
// 两种都不红：`status` 照样是 ok/degraded，`status_reasons` 照样是数组。
//
// ## 为什么这一份是**声明**而不是引用
//
// push 点保留字面量（`statusReasons.push("db_unreadable")`），`STATUS_REASONS` 只做靶子。
// 改成 `push(STATUS_REASONS[0])` 之后，抽取只能看见下标、看不见成因，
// 而「哪一行推了什么」正是这条检查要看的东西。
//
// ## 断言
//
//   ① 源码里所有 `statusReasons.push("X")` 的字面量集合 == STATUS_REASONS
//   ② push 点数 == 不同字面量数（同一个成因不许有两处 push —— 那会让「一个成因」看起来像两个）
//   ③ 每个 STATUS_REASONS 的成员都真的在某处被 push（无死值）
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./server.ts", import.meta.url), "utf8");

/** 源码里所有 `statusReasons.push("literal")` 的字面量（保序、允许重复）。 */
export function pushedReasonLiterals(source: string): string[] {
  return [...source.matchAll(/statusReasons\s*\.\s*push\(\s*"([a-z0-9_]+)"\s*\)/g)].map((m) => m[1]);
}

describe("#status_reasons 值域 == 生产者集合", () => {
  test("① push 的字面量集合与 STATUS_REASONS 相等", async () => {
    const { STATUS_REASONS } = await import("./server.js");
    const pushed = new Set(pushedReasonLiterals(src));
    expect([...pushed].sort()).toEqual([...STATUS_REASONS].sort());
  });

  // ② 报成**向量**而不是一个数：`1,1` 与 `1,2` 在「点数 == 不同值数」这条上都会红，
  // 但前者是「新增了一类成因」，后者是「同一个成因被推了两次」—— 处置相反。
  // 单条计数断言把这两种压成一格，而它读起来更严格。
  test("② 每个成因恰好一个生产者（报向量，不是一个数）", () => {
    const all = pushedReasonLiterals(src);
    const counts: Record<string, number> = {};
    for (const r of all) counts[r] = (counts[r] ?? 0) + 1;
    const vector = Object.entries(counts).sort().map(([k, v]) => `${k}=${v}`).join(" · ");
    expect(vector).toBe(
      "db_unreadable=1 · license_unreadable=1",
    );
    // 上面那条是**精确向量**：新增一类或某类多一处，都会让它红，
    // 而且失败信息里直接看得出是哪种（多了一个 `x=1` 还是某个变成 `=2`）。
  });

  // ⑤ 域不能是空集，也不能是全集 —— 否则上面几条会在空集上恒真。
  // 这正是「取反后仍然绿」的那一格：把 STATUS_REASONS 清空，①（集合相等）与 ③（无死值）
  // 都会通过，因为没有东西可比；而它们看起来仍然在守东西。
  test("⑤ 值域非空且不是全集（至少两类可区分）", async () => {
    const { STATUS_REASONS } = await import("./server.js");
    const pushed = new Set(pushedReasonLiterals(src));
    // 下界：这个字段存在的理由就是区分「真的没问题」与「检查没跑」——至少要两类。
    expect(STATUS_REASONS.length).toBeGreaterThanOrEqual(2);
    // 上界：值域的成员必须都在源码里出现（否则是死值，由 ③ 报）——
    // 这里再钉一条「域不比生产者宽」，因为「全集」正是那种能让谓词恒真的情形。
    expect(STATUS_REASONS.length).toBeLessThanOrEqual(pushed.size + 0 * 0 + 0);
    expect(pushed.size).toBeGreaterThan(0);
  });

  test("③ 没有死值：STATUS_REASONS 每个成员都在源码里被 push 过", async () => {
    const { STATUS_REASONS } = await import("./server.js");
    const pushed = new Set(pushedReasonLiterals(src));
    for (const r of STATUS_REASONS) expect(pushed.has(r)).toBe(true);
  });

  test("④ status 由 reasons 派生，不是独立写的第二个真相", async () => {
    const { statusFromReasons } = await import("./server.js");
    // 空 ⇒ ok；任一 ⇒ degraded。这条同时钉住「ok 不代表检查跑过」——
    // 它只代表「没有成因被推上来」。
    expect(statusFromReasons([])).toBe("ok");
    expect(statusFromReasons(["db_unreadable"])).toBe("degraded");
    expect(statusFromReasons(["db_unreadable", "license_unreadable"])).toBe("degraded");
  });
});

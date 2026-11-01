// `degraded[].origin: node | hub` —— 值域 == 生产者，**并且**那一格对它声明的事真的成立。
//
// ## 这格存在的原因
//
// `app_server.reason` 有两个生产者：
//   · 节点上报的 `last_error`（≤200 任意串）
//   · Hub 自己合成的字面量 `"unreachable"`（节点没报错误摘要时）
//
// 两者写进同一个字段 ⇒ 读者分不出「节点说它 unreachable」与「Hub 根本没能问到节点」。
// 而且**上游可以原样声明 `"unreachable"`** ⇒ 靠改名或拆 catch 都拦不住，
// 判别力只能来自这个独立的来源字段。
//
// ## 两条断言，缺一不可
//
//   ① 值域 == 生产者（声明了没人产生 = 死值；产生了没声明 = 读者拿到不认识的串）
//   ② **行为**：`origin` 说的那句必须真的成立 —— 有 `last_error` ⇒ node；
//      没有（Hub 用了兜底串）⇒ hub。只做 ① 时，把兜底那行的 origin 改成 node
//      仍然「值域齐全」，而这一格的含义就没了。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { degradedLayers } from "./node-health-guard.js";

const src = readFileSync(new URL("./node-health-guard.ts", import.meta.url), "utf8");

/** 声明的值域。 */
export function declaredOrigins(source: string): string[] {
  const m = source.match(/origin:\s*([^;]+);/);
  return m ? [...m[1].matchAll(/"([a-z]+)"/g)].map((x) => x[1]) : [];
}

/**
 * 源码里 `origin:` 之后的**所有**字面量取值（保序、允许重复）。
 *
 * 不能只认 `origin: "x"`：兜底那一行写的是三目 `origin: last_error ? "node" : "hub"`。
 * 只认字面量形式时，它整个人消失 —— 于是最重要的那一格（Hub 合成的兜底串）
 * 会被读成「没人产生 hub」，而它其实是唯一产生 hub 的地方。
 * 这正是 git_identity_root 那次的同一个坑（经变量/表达式产生）。
 */
export function producedOrigins(source: string): string[] {
  const out: string[] = [];
  for (const line of source.split("\n")) {
    const m = line.match(/origin:\s*(.+)$/);
    if (!m) continue;
    // 类型声明那一行（`origin: "node" | "hub";`）是**声明**，不是产生点。
    // 不排除它，声明就会被算成一次产生 —— 于是「每个值都有产生点」这条永远为真。
    if (m[1].includes("|")) continue;
    for (const lit of m[1].matchAll(/"([a-z]+)"/g)) out.push(lit[1]);
  }
  return out;
}

describe("degraded[].origin 值域 == 生产者", () => {
  test("① 声明集合非空且无重复", () => {
    const declared = declaredOrigins(src);
    expect(declared.length).toBeGreaterThanOrEqual(2);
    expect(new Set(declared).size).toBe(declared.length);
  });

  test("② 产生点都在声明内，且每个声明值都有产生点", () => {
    const declared = new Set(declaredOrigins(src));
    const produced = new Set(producedOrigins(src));
    expect([...produced].filter((x) => !declared.has(x))).toEqual([]);
    expect([...declared].filter((x) => !produced.has(x))).toEqual([]);
  });

  test("③ 每个 origin 值的产生次数（向量）", () => {
    const counts: Record<string, number> = {};
    for (const o of producedOrigins(src)) counts[o] = (counts[o] ?? 0) + 1;
    // `node` 是多数（每层自带），`hub` 只有一处：app_server 的兜底串。
    // 数字变了要能说出「多出来的那一处是哪个层」。
    expect(counts).toEqual({ hub: 1, node: 3 });
  });

  // ② 的**行为**那一半：origin 说的那句必须真的成立。
  test("④ 有 last_error ⇒ origin=node，reason 逐字是节点给的", () => {
    const out = degradedLayers({
      app_server: { ok: false, last_error: "ECONNREFUSED 127.0.0.1:1729" },
    } as any);
    const layer = out.find((l) => l.layer === "app_server")!;
    expect(layer.origin).toBe("node");
    expect(layer.reason).toBe("ECONNREFUSED 127.0.0.1:1729");
  });

  test("⑤ 没有 last_error ⇒ origin=hub，且 reason 是 Hub 合成的 unreachable", () => {
    const out = degradedLayers({ app_server: { ok: false } } as any);
    const layer = out.find((l) => l.layer === "app_server")!;
    expect(layer.origin).toBe("hub");
    expect(layer.reason).toBe("unreachable");
  });

  // 上游可以原样声明 unreachable —— 这一条钉住「只有 origin 能分辨」这件事。
  test("⑥ 节点自己报 unreachable 时，origin 仍是 node（不是 hub）", () => {
    const out = degradedLayers({ app_server: { ok: false, last_error: "unreachable" } } as any);
    const layer = out.find((l) => l.layer === "app_server")!;
    expect(layer.reason).toBe("unreachable");
    expect(layer.origin).toBe("node"); // 靠 reason 分不出来，靠 origin 才能
  });
});

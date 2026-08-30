import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { claudeAttemptsDetail, codexTimeoutDetail } from "./sdk-timeout-detail";

describe("codexTimeoutDetail (#1645)", () => {
  test("0 事件 → 指向连接/握手层", () => {
    // 这就是 2026-08-31 实测那次:rmcp worker 因 `unknown variant \`max\`` 致命退出,
    // 一个事件都没流出来。
    expect(codexTimeoutDetail(0, 0)).toBe("期间 0 个事件(连接/握手层就没通)");
  });

  test("有事件 → 指向 turn 自己,并带上停了多久", () => {
    expect(codexTimeoutDetail(12, 287_000)).toBe("期间 12 个事件,最后一个在 287s 前(turn 中途停住)");
  });

  test("两种情形必须给出**不同**的字符串 —— 否则这个函数没有存在意义", () => {
    expect(codexTimeoutDetail(0, 0)).not.toBe(codexTimeoutDetail(12, 287_000));
  });

  test("🔴 不再提 OPENAI_BASE_URL / vendor 负载 —— 实测中它们没被牵涉", () => {
    for (const s of [codexTimeoutDetail(0, 0), codexTimeoutDetail(5, 1_000)]) {
      expect(s).not.toContain("OPENAI_BASE_URL");
      expect(s).not.toContain("vendor");
    }
  });

  test("1 个事件也走「有事件」那支(边界,不是生产值)", () => {
    expect(codexTimeoutDetail(1, 999)).toContain("1 个事件");
    expect(codexTimeoutDetail(1, 999)).toContain("turn 中途停住");
  });
});

describe("claudeAttemptsDetail (#1645 的兄弟)", () => {
  const T = 300_000;

  test("每次都跑满超时 → 说「期间没有任何响应」", () => {
    const s = claudeAttemptsDetail([{ ms: 300_100, timedOut: true }, { ms: 300_050, timedOut: true }, { ms: 300_200, timedOut: true }], T);
    expect(s).toContain("每次都跑满了超时");
    expect(s).toContain("300s 超时 / 300s 超时 / 300s 超时");
  });

  test("🔴 有一次很快就失败 → 必须说「不只是 vendor 没响应」", () => {
    // 这是整条的立论:很快失败和一直没响应,要查的东西完全不同。
    const s = claudeAttemptsDetail([{ ms: 12_000, timedOut: false }, { ms: 300_100, timedOut: true }], T);
    expect(s).toContain("并非每次都跑满超时");
    expect(s).toContain("12s 报错");
  });

  test("超时略大于阈值仍算「跑满」(定时器实测值总是略大)", () => {
    expect(claudeAttemptsDetail([{ ms: 300_001, timedOut: true }], T)).toContain("每次都跑满了超时");
    // 但明显短于阈值的不算 —— 边界用边界值校准
    expect(claudeAttemptsDetail([{ ms: 280_000, timedOut: true }], T)).toContain("并非每次都跑满超时");
  });

  test("🔴 不再提 ANTHROPIC_BASE_URL / vendor 负载", () => {
    const s = claudeAttemptsDetail([{ ms: 300_100, timedOut: true }], T);
    expect(s).not.toContain("ANTHROPIC_BASE_URL");
    expect(s).not.toContain("vendor 负载");
  });

  test("空数组不抛,如实说没记录到", () => {
    expect(claudeAttemptsDetail([], T)).toBe("没有记录到任何一次尝试");
  });
});

describe("接线守卫", () => {
  // 🔴 纯函数的单测**看不见调用点**。本 PR 的第一版就栽在这:改动根本没落地
  //    (python 在写文件前抛了),而这些测试照样全绿。所以这里读 cli.ts 的字节。
  const cliRaw = readFileSync(new URL("../cli.ts", import.meta.url), "utf8");
  // 🔴 必须先剥掉注释行再断言。第一版没剥,守卫命中了**我自己在注释里引用的那句旧串**,
  //    基线就红 —— 「源码里既有那个东西,也有关于它的说明」,今天第 5 次踩这个。
  const cli = cliRaw
    .split("\n")
    .filter(l => { const c = l.trim(); return !c.startsWith("//") && !c.startsWith("*") && !c.startsWith("/*"); })
    .join("\n");

  test("两条超时报错都不再提 BASE_URL / vendor 负载", () => {
    expect(cli).not.toContain("检查 OPENAI_BASE_URL / vendor 负载");
    expect(cli).not.toContain("ANTHROPIC_BASE_URL endpoint 或 vendor 负载");
  });

  test("而且确实调用了两个判别函数 —— 「没有旧串」也可能是整段被删了", () => {
    expect(cli).toContain("codexTimeoutDetail(evSeen");
    expect(cli).toContain("claudeAttemptsDetail(claudeAttempts");
  });

  test("🔴 计数器必须声明在**函数作用域**,不能在重试循环内", () => {
    // 本 PR 第一版就是把 codex 那两个计数器声明进了 try 块,catch 里读不到,
    // typecheck 棘轮门(83 > 基线 81)才抓到。
    //
    // 🔴 第一版守卫写的是「decl 的 indexOf < push 的 indexOf」—— 那查的是**文本顺序**,
    //    不是作用域:把声明挪进循环、放在 push 上一行,它文本上仍然更靠前,守卫照样绿。
    //    实测过:那个变异下 13 pass 0 fail。改成查缩进 —— 函数级是 2 个空格,
    //    循环体内至少 6 个。
    expect(cli).toContain("\n  const claudeAttempts:");
    expect(cli).not.toContain("\n      const claudeAttempts:");
    expect(cli).toContain("claudeAttempts.push(");
    expect(cli).toContain("claudeAttemptsDetail(claudeAttempts");
  });
});

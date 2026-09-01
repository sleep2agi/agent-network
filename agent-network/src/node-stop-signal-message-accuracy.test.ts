import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// `anet node stop` / `anet node rename` 的杀进程路径原本是**静默**的，而它的
// 报错文案又比实际做的事多说了一步：
//
//   agent-network/bin/cli.ts  terminateNodeProcess(pid, force)
//     SIGTERM → 等 8000ms → if (force) { SIGKILL → 等 3000ms }
//                            ↑ SIGKILL **只在 --force 时发**
//
//   而 renameCommand 里的失败文案原文是：
//     `✗ old agent process (pid …) did not exit after SIGTERM + SIGKILL.`
//                                                              ↑ 非 force 时根本没发
//
// 后果不是"文案不好看"：test225 的诊断行据此写了「拆卸链没跑完就被 SIGKILL 了」，
// 而那次是否发过 SIGKILL **日志里读不到**（#1422 复现记录）。
// 一个说反的报错会把每一个读它的人朝同一个方向带偏。
//
// 🔴 这条测试只钉**源码文本**（文案与分支的对应关系），它证明不了命令真能跑 ——
//    `terminateNodeProcess` 未导出，只有真跑 CLI 才能验行为。别把它当行为测试。

const CLI = readFileSync(join(import.meta.dir, "..", "bin", "cli.ts"), "utf-8");

/** 取集：把 terminateNodeProcess 的函数体单独取出来，避免命中文件里别处的同名字串。 */
function terminateBody(src: string): string {
  const start = src.indexOf("async function terminateNodeProcess(");
  if (start < 0) throw new Error("找不到 `terminateNodeProcess(` —— 函数被改名或删了");
  const end = src.indexOf("\n}\n", start);
  if (end < 0) throw new Error("取不到 `terminateNodeProcess` 的函数边界");
  return src.slice(start, end);
}

describe("node stop / rename 的信号文案与实际分支一致", () => {
  it("取集正控：函数体取到了，且包含它那三个已知常量", () => {
    const body = terminateBody(CLI);
    // 分母不是从"我打算扫什么"算的 —— 这三个是独立已知的事实。
    expect(body).toContain('process.kill(pid, "SIGTERM")');
    expect(body).toContain("8000");
    expect(body).toContain("3000");
    expect(body.length).toBeLessThan(2000); // 取到的是一个函数，不是半个文件
  });

  it("🔴 没有任何文案在非 force 分支上无条件宣称发过 SIGKILL", () => {
    // 原缺陷形态：`did not exit after SIGTERM + SIGKILL.` 是死字串。
    expect(CLI).not.toContain("did not exit after SIGTERM + SIGKILL");
  });

  it("该文案按 force 分叉，并在没发时明确说出「要 --force 才升级」", () => {
    expect(CLI).toContain('did not exit after SIGTERM${force ? " + SIGKILL"');
    expect(CLI).toContain("no SIGKILL — that needs --force");
  });

  it("两个分支都会说话 —— 8s 宽限走完之后不再静默", () => {
    const body = terminateBody(CLI);
    const warns = [...body.matchAll(/console\.warn\(/g)].length;
    expect(warns).toBe(2); // force 一条、非 force 一条
    expect(body).toContain("escalating to SIGKILL (--force)");
    expect(body).toContain("escalation requires --force");
  });

  it("happy path 仍然安静：SIGTERM 在 8s 内收掉时不打日志", () => {
    const body = terminateBody(CLI);
    // 第一个 return true（8000ms 那次）必须出现在第一条 console.warn 之前。
    const firstReturn = body.indexOf("if (await waitForPidExit(pid, 8000)) return true;");
    const firstWarn = body.indexOf("console.warn(");
    expect(firstReturn).toBeGreaterThan(-1);
    expect(firstWarn).toBeGreaterThan(firstReturn);
  });

  it("钉住 SIGKILL 仍是 --force 专属（行为没被这次改动带偏）", () => {
    const body = terminateBody(CLI);
    const kill = body.indexOf('process.kill(pid, "SIGKILL")');
    const forceGate = body.indexOf("if (force) {");
    expect(forceGate).toBeGreaterThan(-1);
    expect(kill).toBeGreaterThan(forceGate);
  });
});

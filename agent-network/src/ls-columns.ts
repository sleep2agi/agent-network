import { displayWidth } from "./display-width";

// `anet node ls` 的 RUNTIME 列宽原先写死 14,而 runtime 名字最长 **16**
// (`claude-agent-sdk` / `codex-app-server`),`claude-code-cli` 也有 15。
// 于是这三种 runtime 的行会把 STATUS 往右顶 1–2 列,和表头对不上 ——
// 而 `claude-code-cli` 恰好是最常见的那个。
//
// 🔴 修法不是把 14 改成 16,那是下一次加 runtime 时再漂一遍。列宽从
// `SUPPORTED_RUNTIME_NAMES`(唯一真源)算出来,加一个新 runtime 时表自己变宽。
//
// 表头和分隔线也从同一个宽度生成 —— 原先它们是两个各自写死的字符串字面量,
// 三处宽度靠人对齐,任何一处改了另外两处不会跟。

export function runtimeColumnWidth(names: readonly string[], header = "RUNTIME"): number {
  let w = displayWidth(header);
  for (const n of names) {
    if (typeof n !== "string") continue;
    const d = displayWidth(n);
    if (d > w) w = d;
  }
  return w;
}

const NAME_W = 20;
const STATUS_W = 8;
const SSE_W = 4;

export function lsHeaderRow(runtimeWidth: number): string {
  return `  ${"NAME".padEnd(NAME_W)} ${"RUNTIME".padEnd(runtimeWidth)} ${"STATUS".padEnd(STATUS_W)} ${"SSE".padEnd(SSE_W)} SESSION`;
}

export function lsSeparatorRow(runtimeWidth: number): string {
  const bar = (n: number) => "─".repeat(n);
  return `  ${bar(NAME_W)} ${bar(runtimeWidth)} ${bar(STATUS_W)} ${bar(SSE_W)} ${bar(8)}`;
}

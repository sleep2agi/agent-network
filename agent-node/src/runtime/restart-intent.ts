// 2026-10-31 —— 「重启意图」持久标记：用**状态文件**替代「用退出码表达意图」。
//
// ## 为什么不用退出码
//
// 现在的做法是：收到 restart 级配置 ⇒ 写配置 ⇒ ack `restarting` ⇒ `process.exit(75)`，
// 然后**指望**外面的包装（anet start / pm2 / systemd）认识 75 并重新拉起。
// 三个致命点（对方点出，我全认）：
//   ① 只有 8 bit，且**语义由接收方解释** —— 同一个 75 在 systemd、pm2、自研 wrapper 那里含义不同
//   ② **不持久** —— 进程退出后这个信号就消失了，没有「它曾经想重启」的记录
//   ③ 于是判断「会不会被拉起」只能靠**猜包装**，而猜错的下场是节点静默下线
//
// ⇒ 改成：退出前写一个**持久标记**；wrapper 启动时读它；
//    命中 ⇒ 知道「这是按计划的退出」，并且**读完就清**。
//    systemd / pm2 / 自研 re-fork 读的是**同一条判据**，不再各解释一个退出码。
//
// ## 三条设计约束（每条对应一个已踩过的坑）
//
//   ① **三态**：absent / present / unreadable。
//      文件存在但解析失败 ≠ 没有意图 —— 把后者折成前者会让「查不到」变成「没发生」。
//   ② **不做时间过期**：标记的失效只由「成功启动后清除」触发。
//      用 TTL 的话，「多久算过期」又变成一个要被解释的数（今晚那个时钟问题的翻版）。
//   ③ **原子写**：先写临时文件再 rename。否则崩溃在写一半会留下一个不可解析的标记 ⇒ 见 ①。
//
// ## 它不做什么
//
// 它不判断「该不该重启」——那是 config-apply 的职责。它只负责**把意图持久化**，
// 让「计划内的退出」在事后仍然可读。

import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const RESTART_INTENT_FILE = "restart-intent.json";

export interface RestartIntent {
  /** 为什么想重启（例如 apply_restart_tier / model_changed）。自由文本，但必须是可枚举的来源。 */
  reason: string;
  /** 写入时刻（ms）。**只用于人读与排序，不用于过期判断。** */
  at: number;
  /** 写入者的 pid 与 boot_id：让读的人能判断「这是上一代的意图还是这一代的」。 */
  pid: number;
  boot_id: string | null;
}

export type ReadResult =
  | { kind: "absent" }
  | { kind: "present"; intent: RestartIntent }
  | { kind: "unreadable"; error: string };

/** 写标记。原子：临时文件 + rename。 */
export function writeRestartIntent(dir: string, intent: RestartIntent): void {
  const target = join(dir, RESTART_INTENT_FILE);
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(intent)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, target);
}

/**
 * 读标记。**三态**：不存在 / 存在且可解析 / 存在但不可解析。
 * 第三种绝不允许被折成第一种 —— 否则「读失败了」看起来像「没有计划重启」。
 */
export function readRestartIntent(dir: string): ReadResult {
  const target = join(dir, RESTART_INTENT_FILE);
  let raw: string;
  try {
    raw = readFileSync(target, "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return { kind: "absent" };
    return { kind: "unreadable", error: String(error?.code ?? error) };
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "unreadable", error: "invalid_json" };
  }
  if (!parsed || typeof parsed !== "object" || typeof parsed.reason !== "string") {
    return { kind: "unreadable", error: "invalid_shape" };
  }
  return {
    kind: "present",
    intent: {
      reason: parsed.reason,
      at: typeof parsed.at === "number" ? parsed.at : 0,
      pid: typeof parsed.pid === "number" ? parsed.pid : 0,
      boot_id: typeof parsed.boot_id === "string" ? parsed.boot_id : null,
    },
  };
}

/** 清除标记。只应在**成功启动之后**调用（此时意图已经被兑现）。 */
export function clearRestartIntent(dir: string): void {
  try {
    unlinkSync(join(dir, RESTART_INTENT_FILE));
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
}

/**
 * wrapper 启动时的判据。
 *
 * 🔴 `unreadable` 的处置是**不启动**吗？不是 —— 那会让一个坏文件把节点永久钉死。
 *    但它也**不能**当成「没有意图」直接启动：那样等于把「有人按计划重启过」这个事实丢掉。
 *    ⇒ 所以它返回 `needs_review`，由调用方决定（记一条告警 + 照常启动）。
 *    这与「兜底可以静默，但落点必须是『我不知道』」同一条。
 */
export type StartDecision =
  | { start: true; planned: false }
  | { start: true; planned: true; intent: RestartIntent }
  | { start: true; needs_review: true; error: string };

export function decideStart(dir: string): StartDecision {
  const r = readRestartIntent(dir);
  if (r.kind === "absent") return { start: true, planned: false };
  if (r.kind === "present") return { start: true, planned: true, intent: r.intent };
  return { start: true, needs_review: true, error: r.error };
}

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
//   ② **时效判据：先比内核 boot_id，再比时间**（2026-10-31 修订）。
//      我原来写的是「不做 TTL」，理由是「多久算过期又是一个要被解释的数」。
//      但那只反驳了「TTL 单独够用」，没反驳「没有时效判据」：
//      一个陈旧标记会把**崩溃/重启机器**引起的启动误标成「按计划重启」——静默的误归因。
//      ⇒ 两级：boot_id 不同 ⇒ 这次启动**不可能**由那条意图造成（与时间无关，不需要阈值）；
//         boot_id 相同 ⇒ 才轮到时间（同一 boot 内 `at` 与 `now` 同钟域，比较是安全的）。
//      ⇒ TTL 只在「同 boot 且时间可比」这一支里出现，不是全局的魔数。
//   ③ **原子写**：先写临时文件再 rename。否则崩溃在写一半会留下一个不可解析的标记 ⇒ 见 ①。
//
// ## 生产者分工（2026-10-31 修正：我原来只做了一个生产者，而且选错了一半）
//
//   **intent**（本文件，子进程写）：我打算按计划退出并重启。
//   **outcome**（缺，应由父/包装器写）：我真的把它拉起来了吗 / 它是被我拉起来的吗。
//
// 🔴 为什么必须两个生产者：
//   子进程只有在**自愿退出**时才有机会写字；SIGKILL / OOM-kill 没有执行机会。
//   所以「读不到标记」同时表示两件事：
//      ① 没人要求过重启
//      ② 请求过，但进程被硬杀，来不及记
//   ⇒ 一个字段承载了两个事实，而且**无法在后验里分开**。
//   ⇒ 这不是判据写得不好，是**字段定义处就折叠掉了**（与「Restart 折叠了 LoadState」同形）。
//
//   补 outcome 需要改启动器（anet start / systemd / pm2 写一行），本次不做；
//   但在读侧必须把这条歧义**说出来**，而不是让 absent 读成「没要求过」。
//
// ## 它不做什么
//
// 它不判断「该不该重启」——那是 config-apply 的职责。它只负责**把意图持久化**，
// 让「计划内的退出」在事后仍然可读。

import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { renameOverExistingSync } from "../shared/windows-rename-retry";
import { join } from "node:path";

export const RESTART_INTENT_FILE = "restart-intent.json";

export interface RestartIntent {
  /** 为什么想重启（例如 apply_restart_tier / model_changed）。自由文本，但必须是可枚举的来源。 */
  reason: string;
  /** 写入时刻（ms）。**只在与内核 boot_id 相同的前提下**才用于时效判断（同 boot 内同钟域）。 */
  at: number;
  /** 写入者的 pid 与 boot_id：让读的人能判断「这是上一代的意图还是这一代的」。 */
  pid: number;
  /** **内核口径**的 boot_id（`/proc/sys/kernel/random/boot_id`），不是自报。读不到就是 null。 */
  boot_id: string | null;
  /** 触发这次重启的那条指令（config_update 的 update_id），用于把「意图」对回「谁让它重启的」。 */
  instruction_id?: string | null;
  /** 目标版本（如果有）：让「重启后是不是到了该到的版本」可对账。 */
  target_version?: string | null;
}

/** 同 boot 内的时效上限：超过它就不再把这次启动归因给那条意图，但**照样启动**。 */
export const RESTART_INTENT_TTL_MS = 10 * 60 * 1000;

/** 内核口径的 boot_id。读不到 ⇒ null（**不是**「没有 boot」）。 */
export function currentBootId(): string | null {
  try {
    const raw = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
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
  // 2026-10-31 —— 这里原来是裸 `renameSync(tmp, target)`：#2224 的整类（Windows 上目标被别的
  // 句柄打开时 EPERM/EBUSY/EACCES，POSIX 永远成功 ⇒ Linux CI 看不见）。
  // 这正是 `windows-rename-retry.ts` 存在的理由 —— 换成有界重试版本。
  renameOverExistingSync(tmp, target);
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
      instruction_id: typeof parsed.instruction_id === "string" ? parsed.instruction_id : null,
      target_version: typeof parsed.target_version === "string" ? parsed.target_version : null,
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

/**
 * 启动时调用一次：读标记 → 清掉（或把坏文件改名保留）→ 返回一行可打日志的结论。
 *
 * 🔴 为什么由**本进程**读而不是只留给 wrapper：
 *    wrapper 只关心「要不要拉起」，而节点自己关心「我这次是被按计划重启的吗」——
 *    后者对排障有价值（能区分「计划内重启」与「崩溃后自愈」）。
 *    ⇒ 读了就清：标记的生命周期是「一次退出 → 下一次启动」，不是一段时间。
 *
 * 坏文件不删，改名保留：`restart-intent.json.bad-<ts>` ⇒ 既不会再触发 needs_review，
 * 也留下了现场（与「读失败 ≠ 没有」同一条）。
 */
export type ConsumedRestart = {
  /** 「这次启动是被那条意图造成的吗」的**判定**（不是「要不要启动」——启动永远照常）。 */
  verdict: "planned" | "stale" | "stale_reboot" | "unknown_age" | "absent" | "unreadable";
  planned: boolean;
  note: string;
};

/**
 * 启动时调用一次：读标记 → 判定归因 → 清掉（或把坏文件改名保留）→ 返回一行可打日志的结论。
 *
 * 🔴 **它从不阻止启动。** 标记是观测用的，不是闸门 ——
 *    一个「命中就不起服务」的设计会把「exit 75 后没人拉起」换成「标记一直在，永远不起」，
 *    更难发现（机器看起来正常，只是不回来）。若将来真有 launcher 拿它当闸门，
 *    那时必须同时有 TTL 失效与 `--force` 覆盖 + audit，缺一不可。
 *
 * 🔴 归因分三支（这是本轮修掉的**静默误归因**）：
 *    · boot_id 不同 ⇒ `stale_reboot`：机器重启过，这次启动不可能由那条意图造成
 *    · boot_id 相同但超 TTL ⇒ `stale`：同 boot 内的旧意图，不再归因
 *    · boot_id 任一侧未知 ⇒ `unknown_age`：**落点是「我不知道」，不是「计划重启」**
 *    · 只有「同 boot + 未超 TTL」才叫 `planned`
 */
export function consumePlannedRestart(
  dir: string,
  opts: { now?: () => number; bootId?: () => string | null; ttlMs?: number } = {},
): ConsumedRestart {
  const now = opts.now ?? Date.now;
  const readBoot = opts.bootId ?? currentBootId;
  const ttlMs = opts.ttlMs ?? RESTART_INTENT_TTL_MS;

  const d = decideStart(dir);
  // 🔴 先按 `needs_review` 窄化，再谈 `planned`。
  //    `StartDecision` 的判别位是 `start: true` + 可选成员，所以 `d.planned` 并不存在
  //    于所有分支上 —— 直接读它（原来的写法）会被 tsc 判成 TS2339，
  //    而在运行期它只是「恰好 undefined」⇒ 靠运气对。窄化顺序 = 类型与运行期同一份判据。
  if ("needs_review" in d) {
    const bad = join(dir, `${RESTART_INTENT_FILE}.bad-${now()}`);
    try {
      renameSync(join(dir, RESTART_INTENT_FILE), bad);
    } catch {
      /* 改名失败也不阻塞启动 */
    }
    return {
      verdict: "unreadable",
      planned: false,
      note: `restart_intent_unreadable:${d.error} (kept as ${bad})`,
    };
  }
  if (!d.planned) {
    return {
      verdict: "absent",
      planned: false,
      // ⚠️ 「没有标记」是两个事实的同一个形状：没人要求过重启，**或**请求过但被硬杀来不及记。
      //    这一条不能在生产侧分开（子进程被 SIGKILL 就没有执行机会），
      //    只能在这里如实说出歧义，而不是让读者默认「没要求过」。
      note: "no_planned_restart (ambiguous: nothing was requested, OR the process was killed before it could record one)",
    };
  }

  const i = d.intent;
  const who = `reason=${i.reason} instruction=${i.instruction_id ?? "unknown"} target=${i.target_version ?? "unknown"} pid=${i.pid}`;
  clearRestartIntent(dir);

  const current = readBoot();
  if (!current || !i.boot_id) {
    return {
      verdict: "unknown_age",
      planned: false,
      note: `restart_intent_cannot_attribute (boot_id ${current ? "present" : "unreadable"} vs marker ${i.boot_id ? "present" : "missing"}; same-boot unprovable) ${who}`,
    };
  }
  if (current !== i.boot_id) {
    return {
      verdict: "stale_reboot",
      planned: false,
      note: `restart_intent_from_previous_boot (marker boot ${i.boot_id.slice(0, 8)} ≠ current ${current.slice(0, 8)}; this start was NOT caused by it) ${who}`,
    };
  }
  // `at` 缺失/为 0 ⇒ 时间不可比 ⇒ 不能证明「新鲜」，落点是 unknown 而不是 stale
  //（stale 是「我知道它旧了」，unknown 是「我不知道它多旧」）。
  if (!Number.isFinite(i.at) || i.at <= 0) {
    return {
      verdict: "unknown_age",
      planned: false,
      note: `restart_intent_age_unknown (written_at unrecorded in marker) ${who}`,
    };
  }
  const age = now() - i.at;
  if (!Number.isFinite(age) || age < 0 || age > ttlMs) {
    return {
      verdict: "stale",
      planned: false,
      note: `restart_intent_stale (age ${Number.isFinite(age) ? Math.round(age / 1000) + "s" : "unknown"} > ttl ${Math.round(ttlMs / 1000)}s; not attributed) ${who}`,
    };
  }
  return {
    verdict: "planned",
    planned: true,
    note: `planned_restart:${i.reason} (age ${Math.round(age / 1000)}s, same boot, written at ${new Date(i.at).toISOString()}) ${who}`,
  };
}

export function decideStart(dir: string): StartDecision {
  const r = readRestartIntent(dir);
  if (r.kind === "absent") return { start: true, planned: false };
  if (r.kind === "present") return { start: true, planned: true, intent: r.intent };
  return { start: true, needs_review: true, error: r.error };
}

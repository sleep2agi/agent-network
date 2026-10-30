// #2721 —— 广播扇出：把「一条广播 = 几百次同步写 + 同一秒全员唤醒」摊开。
//
// 现场（2026-10-27 07:10–07:15，生产 `.165`，触发者是我自己的一条广播）：
//   一条广播 → 384 行 inbox（每行一次 autocommit INSERT）
//   → 07:11:16 起连续四次 timer 饥饿：3.5s / 20.0s / **143.9s** / 10.0s
//   → RSS 639MB → 979MB → 2507MB → 2910MB，3 分钟后自行排空
//   → `requests_since_last_tick` 分别是 145 / 123 / **1175** / 294
//     ⇒ 当时的循环是**被打满**（8 req/s 持续），不是被阻塞。
//
// 这里只改**节奏**，不改语义：仍然逐行入库、仍然给每个收件人推事件，
// 但每 50 个收件人一批、批间让出事件循环，把「同一毫秒 384 次 commit」
// 变成「8 批、每批一次事务」。
//
// 2026-10-30 补下半句：**通知（SSE 推送）也必须在批内**。
// 上半句只摊开了入库，通知仍是「所有批次之后一次性循环」——
// 于是 384 个 agent 还是在同一个 tick 里被唤醒。入库摊开对客户端几乎无感，
// 唤醒摊开才是「随机大停顿」的解法。
//
// 为什么有用：真正的负载大头是收件 agent 随后各自的 report_status/get_inbox/send_reply
// （实测一条广播 ≈ 500+ 次调用）。把入库摊开几百毫秒，能让唤醒时刻自然分散，
// 而不是让 384 个 agent 在同一秒同时醒来。

import { db } from "./db.js";

/** 一批多少个收件人。50 是“一次事务不至于太长、又明显少于一次全量”的折中。 */
export const BROADCAST_CHUNK = 50;

/**
 * #2721 —— 最近一次广播的「事后可对上时间的」记录。
 *
 * 为什么要有：07:11 那次事故里，我花了不少时间才把“143.9 秒停顿”与“07:10 那条广播”
 * 对上 —— 因为停顿记录（`event_loop.recent_stalls`）里只有时间与 RSS，没有“当时发生了什么”。
 * 广播是唯一一种能一次性唤醒几百个 agent 的动作，值得在 `/health` 里留一格。
 */
export type BroadcastRecord = {
  at: string;
  recipients: number;
  chunks: number;
  took_ms: number;
};

let lastBroadcast: BroadcastRecord | null = null;

export function broadcastRecentState(): BroadcastRecord | null {
  return lastBroadcast;
}

export type BroadcastTarget = { alias: string; node_id: string | null; network_id: string | null };
export type BroadcastDelivered = { alias: string; netId: string | null };

export type BroadcastDeps = {
  /** RFC-027 §2.3：非 active 的收件人静默跳过（广播是 best-effort）。 */
  isActive: (alias: string, netId: string | null) => boolean;
  /** 入库之后给该收件人推一次事件（原实现用 pushEvent + pendingInboxCount）。 */
  notify: (alias: string, netId: string | null) => void;
  /** 测试缝：批间的让出动作。 */
  yieldBetweenChunks?: () => Promise<void>;
  chunkSize?: number;
};

export async function enqueueBroadcast(
  targets: readonly BroadcastTarget[],
  message: string,
  fromSession: string,
  effectiveNetId: string | null,
  deps: BroadcastDeps,
): Promise<{ ids: string[]; delivered: BroadcastDelivered[] }> {
  const startedMs = Date.now();
  const chunk = deps.chunkSize && deps.chunkSize > 0 ? deps.chunkSize : BROADCAST_CHUNK;
  const ids: string[] = [];
  const delivered: BroadcastDelivered[] = [];
  const yieldNow = deps.yieldBetweenChunks ?? (() => Bun.sleep(0));

  for (let i = 0; i < targets.length; i += chunk) {
    const slice = targets.slice(i, i + chunk);
    const batch: BroadcastDelivered[] = [];
    // 一批一个事务：把 N 次 autocommit 变成 1 次，既快又不会长时间占写锁。
    db.transaction(() => {
      for (const t of slice) {
        const netId = effectiveNetId ?? t.network_id ?? null;
        if (!deps.isActive(t.alias, netId)) continue;
        const id = crypto.randomUUID();
        db.run(
          `INSERT INTO inbox (id, session_name, node_id, type, priority, content, from_session, network_id)
           VALUES (?1, ?2, ?3, 'broadcast', 'normal', ?4, ?5, ?6)`,
          [id, t.alias, t.node_id ?? null, message, fromSession, netId],
        );
        ids.push(id);
        const d = { alias: t.alias, netId };
        delivered.push(d);
        batch.push(d);
      }
    });
    // #2721 下半 —— 通知也必须在批内做。
    // 原来这句循环在**所有批次之后**：入库摊开了，但 384 次 SSE 推送又落回同一个 tick，
    // 于是「同一秒全员唤醒」这个真正的问题一点没变 —— 只是把 INSERT 挪开了。
    // 推送失败绝不能中断后续批次：原来通知在所有入库之后，抛错时「入库已全」；
    // 现在挪进批内，一次推送异常会让剩下的人**收不到广播**。这里逐条兜住。
    for (const d of batch) {
      try {
        deps.notify(d.alias, d.netId);
      } catch (e) {
        console.error(`[broadcast] notify failed alias=${d.alias}: ${(e as Error).message}`);
      }
    }
    // 批间让出：没有这一句，384 行仍然是在同一个 tick 里写完的。
    await yieldNow();
  }

  lastBroadcast = {
    at: new Date().toISOString(),
    recipients: delivered.length,
    chunks: Math.ceil(targets.length / chunk),
    took_ms: Date.now() - startedMs,
  };
  return { ids, delivered };
}

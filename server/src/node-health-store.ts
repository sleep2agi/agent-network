// #448 —— agent-node 上报的分层健康(`report_status.health`)的 Hub 侧透传。
//
// 「在线」只说明桥进程还活着:现场 ~40 台 codex 共存节点里,有的在 Hub 上 idle / in_flight=0,
// 实际 app-server 端口没人监听、TUI pane 变成 `sleep infinity`、或登录态 "refresh token revoked"。
// 节点把这几层分开报上来;这里只负责**收下、按节点存最新一份、在 /api/status 和 status_update 里带出去**。
//
// 刻意只放内存,不加列:它是**几秒钟一变的观测值**,不是需要跨重启保留的状态 —— Hub 重启后下一次
// 心跳(≤3 分钟,翻转时立即)就会补上;持久化一份旧观测值反而会在节点死掉后继续说「app_server ok」。
// 同理,超过 TTL 的那份按「没报」处理(null),不按「健康」处理。

import { z } from "zod/v4";

export const NODE_HEALTH_TTL_MS = 10 * 60_000;

// 🔴 `.catch(undefined)`:这一格是纯诊断信息,**任何形状都不许拒掉整份 report_status**
//    (zod 对象里一个已知字段验证失败 = 整份被拒 = 节点在 Hub 上失联,#1225 的形状)。
//    合法的透传,其余一律当没报。子对象不 strict:新节点多报的键丢掉即可。
export const nodeHealthSchema = z.object({
  bridge: z.literal("ok").optional(),
  app_server: z.object({
    ok: z.boolean(),
    rtt_ms: z.number().nullable().catch(null),
    last_error: z.string().max(200).nullable().catch(null),
  }).optional().catch(undefined),
  tui: z.object({
    ok: z.boolean(),
    reason: z.string().max(40),
  }).optional().catch(undefined),
  model_auth: z.enum(["ok", "revoked", "expired", "unknown"]).optional().catch(undefined),
}).optional().catch(undefined);

export type NodeHealth = NonNullable<z.infer<typeof nodeHealthSchema>>;

const store = new Map<string, { health: NodeHealth; at: number }>();
const keyOf = (networkId: string | null | undefined, alias: string) => `${networkId ?? "default"}\0${alias}`;

// #431 —— /api/status 的记忆化(status-read-cache.ts)按这两样判断正文还对不对:任何一次上报 → 版本 +1;
// 任何一份报告过 TTL 的那一刻(degraded / health 字段会消失)→ 由 nodeHealthNextExpiryAt 给出的时刻失效。
let version = 0;
export function nodeHealthVersion(): number { return version; }
/** 最早一份还没过期的报告的过期时刻(ms);一份都没有 → Infinity。 */
export function nodeHealthNextExpiryAt(now = Date.now()): number {
  let next = Infinity;
  for (const v of store.values()) {
    const at = v.at + NODE_HEALTH_TTL_MS;
    if (at >= now && at < next) next = at;
  }
  return next;
}

export function recordNodeHealth(networkId: string | null | undefined, alias: string, health: NodeHealth, now = Date.now()): void {
  version++;
  store.set(keyOf(networkId, alias), { health, at: now });
  // 有界:按 TTL 顺手清掉过期的,别让改过名/删掉的节点在内存里攒着。
  if (store.size > 256) {
    for (const [k, v] of store) if (now - v.at > NODE_HEALTH_TTL_MS) store.delete(k);
  }
}

/** 最新一份;没有或已过 TTL → null(读的人必须把它当「不知道」,而不是「健康」)。 */
export function readNodeHealth(
  networkId: string | null | undefined, alias: string, now = Date.now(),
): { health: NodeHealth; observed_ms_ago: number } | null {
  const hit = store.get(keyOf(networkId, alias));
  if (!hit) return null;
  const age = now - hit.at;
  if (age > NODE_HEALTH_TTL_MS) { store.delete(keyOf(networkId, alias)); return null; }
  return { health: hit.health, observed_ms_ago: Math.max(0, age) };
}

/** 测试用。 */
export function clearNodeHealthStore(): void { store.clear(); version++; }

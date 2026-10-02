// #462(#448 的子项)—— 节点模型登录失效时通知节点主人。
//
// 现场:codex 节点的 refresh token 被作废 / 过期后,节点自己知道(report_status.health.model_auth),
// Hub 也会拒绝给它派活(#460 node-health-guard.ts),但**没有人被告诉** —— 主人要等到某次派活被 409
// 才发现。这里在 report_status 收下健康报告的那一刻看 model_auth 的翻转:进入 revoked / expired 时
// 给节点主人发**一条**消息,说是哪个节点、出了什么事、怎么重新登录。
//
// 🔴 只检测 + 通知。不自动换号、不拷别的节点的 auth.json、不重新 stage 凭据(owner 定的边界)。
//
// 去重:每次「进入坏状态」只发一条;回到 ok 才重新上膛。unknown / 没报 model_auth 既不发也不上膛
//   (一次模型调用都还没跑的节点报 unknown,不能把它当「恢复了」,否则 expired→unknown→expired 会刷屏)。
//   revoked ⇄ expired 互相切换不算新的翻转 —— 修法是同一条命令。
// 状态在内存里(同 node-health-store.ts);Hub 重启后第一次看到坏状态时,先查收件人有没有**还没读**的同类
//   消息,有就不再发 —— 否则每次升级 Hub 都会给还没修好的节点主人再发一遍。
//
// 收件人 = 节点主人:上报令牌绑定的 nodes.owner_user_id(RFC-036,建节点时定死),没有绑定(老令牌)就取
//   铸这个节点令牌的用户(api_tokens.user_id —— 新令牌里两者相同)。只发给这一个人;不在本网络了就不发。
// 怎么送:agent-notice.ts(user_inbox + /events/users/me,from_session = 节点别名)。

import { db } from "./db.js";
import { getUserNetworkRole } from "./auth.js";
import { sendAgentNotice } from "./agent-notice.js";
import { degradedLayers } from "./node-health-guard.js";
import type { NodeHealth } from "./node-health-store.js";

export const MODEL_AUTH_NOTICE_KIND = "node_model_auth";
const MAX_TRACKED = 5_000;

type ModelAuth = NodeHealth["model_auth"];
/** armed = 下一次进入坏状态要发;notified = 这一段坏状态已经发过。 */
export type NoticeMark = "armed" | "notified";

export const isBadModelAuth = (s: ModelAuth): s is "revoked" | "expired" => s === "revoked" || s === "expired";

/**
 * 纯函数:上一份标记 + 这一份 model_auth → 发不发、新标记。
 * prev = undefined 表示这个 Hub 进程还没见过这个节点(调用方另查库里有没有未读的旧通知)。
 */
export function decideModelAuthNotice(prev: NoticeMark | undefined, state: ModelAuth): { notify: boolean; mark: NoticeMark | undefined } {
  if (state === "ok") return { notify: false, mark: "armed" };
  if (isBadModelAuth(state)) {
    if (prev === "notified") return { notify: false, mark: "notified" };
    return { notify: true, mark: "notified" };
  }
  return { notify: false, mark: prev }; // unknown / 没报:保持原样
}

export function modelAuthNoticeText(alias: string, state: "revoked" | "expired"): { title: string; text: string } {
  const what = state === "revoked"
    ? "模型登录凭据已被作废(refresh token revoked),需要重新登录"
    : "模型登录已过期,且没能自动刷新";
  // 修法与派发被拒时(#460)给的同一句,别出现两套说法。
  const hint = degradedLayers({ model_auth: state })[0]?.hint ?? "";
  return {
    title: "节点登录失效",
    text: `节点 ${alias} 的${what}。在它恢复之前,派给它的任务会被拒绝。\n\n怎么修:${hint}。\n登录好之后节点会自动报告恢复,不用再做别的。`,
  };
}

const marks = new Map<string, NoticeMark>();
const keyOf = (networkId: string, alias: string) => `${networkId}\0${alias}`;

export function __resetModelAuthNoticesForTest(): void { marks.clear(); }

/** 上报令牌对应的节点主人。 */
function ownerOfNodeToken(tokenId: string, networkId: string): string | null {
  const row = db.get<{ user_id: string | null; owner_user_id: string | null }>(
    `SELECT t.user_id, n.owner_user_id FROM api_tokens t LEFT JOIN nodes n ON n.node_id = t.bound_node_id
      WHERE t.token_id = ?1 AND t.network_id = ?2`,
    tokenId, networkId,
  );
  return row?.owner_user_id || row?.user_id || null;
}

function hasUnreadNotice(userId: string, networkId: string, alias: string): boolean {
  return !!db.get(
    "SELECT 1 AS hit FROM user_inbox WHERE user_id = ?1 AND network_id = ?2 AND from_session = ?3 AND kind = ?4 AND acked = 0 LIMIT 1",
    userId, networkId, alias, MODEL_AUTH_NOTICE_KIND,
  );
}

/**
 * report_status 收下一份(已验过是本节点令牌报的)健康报告之后调用。返回这次通知到的 user_id(测试用;没发 = [])。
 * 任何异常都吞掉:这是附带的通知,不能让一份正常的 report_status 失败。
 */
export function noteModelAuthHealth(input: { networkId: string; alias: string; tokenId: string; health: NodeHealth }): string[] {
  try {
    const { networkId, alias, tokenId, health } = input;
    const state = health.model_auth;
    const key = keyOf(networkId, alias);
    const prev = marks.get(key);
    const { notify, mark } = decideModelAuthNotice(prev, state);
    if (mark) {
      marks.delete(key);
      marks.set(key, mark);
      if (marks.size > MAX_TRACKED) marks.delete(marks.keys().next().value!);
    }
    if (!notify || !isBadModelAuth(state)) return [];

    const owner = ownerOfNodeToken(tokenId, networkId);
    if (!owner || !getUserNetworkRole(owner, networkId)) return [];
    // Hub 重启后的第一眼:主人还有一条没读的同类消息 → 这是同一段坏状态,不再发。
    if (prev === undefined && hasUnreadNotice(owner, networkId, alias)) return [];

    const { title, text } = modelAuthNoticeText(alias, state);
    const sent = sendAgentNotice({
      networkId, userId: owner, fromAlias: alias, kind: MODEL_AUTH_NOTICE_KIND, title, text,
      meta: { model_auth_notice: { alias, state } }, idPrefix: "dm_auth_",
    });
    if (!sent) return [];
    return [owner];
  } catch (e: any) {
    console.error(`[model-auth-notify] ${input.alias}: ${e?.message ?? e}`);
    return [];
  }
}

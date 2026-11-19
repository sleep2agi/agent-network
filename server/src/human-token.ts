// 「这个令牌是不是人的」唯一判定（#4825 抽出来的；#3639 的 resolveInboxCaller 里有同一套逻辑）。
//
// 为什么不能只看 resolveNodeCaller(tokenId).ok：
//   绑定缺失 / 有歧义 / 属于别的网络时，resolveNodeCaller 返回的是 **不是 ok 的别的 reason**，
//   只看 ok 就会把它当成人的令牌放行，从而拿到主人的角色（节点令牌带 owner 的 userId）。
//
// 默认拒绝：
//   · resolveNodeCaller ok                        → 不是人（真节点令牌）
//   · 不 ok 且 reason 不是 not_a_node_token       → 不是人（身份不明的节点令牌）
//   · reason 是 not_a_node_token，但 api_tokens.name 以 "node:" 开头 → 不是人
//   · 其余（含没有 tokenId 的 legacy 全局令牌）    → 是人
import { db } from "./db.js";
import { resolveNodeCaller } from "./create-node.js";

export function isHumanToken(tokenId: string | null | undefined): boolean {
  if (!tokenId) return true;
  const resolved = resolveNodeCaller(tokenId);
  if (resolved.ok) return false;
  if (resolved.reason !== "not_a_node_token") return false;
  const row = db.get<{ name: string | null }>(
    "SELECT name FROM api_tokens WHERE token_id = ?1 AND revoked_at IS NULL",
    tokenId,
  );
  if (row?.name?.startsWith("node:")) return false;
  return true;
}

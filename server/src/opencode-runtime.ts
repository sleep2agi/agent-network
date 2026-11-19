/**
 * 「这台节点是不是 OpenCode 运行时」的唯一判定（#3641 / #4825 共用一份）。
 *
 * 宽进严出：runtime 为空（老行 / 刚注册 / 长期离线），或报了代际 / opencode_server，
 * 都算 OpenCode 节点（只是目录/会话还没采到）；**只有 runtime 非空且明确不是 opencode\*** 才判死。
 * 判死的代价是客户端永远不给重试入口 —— 之前 #4976 已经踩过一次没人愿意再踩。
 *
 * 两份实现必然漂移：所以 #3641 的 catalog_state 与 #4825 的 sessions 端点都调这里。
 */
export function runtimeIsOpencode(input: {
  runtime: string | null | undefined;
  generation?: "v1" | "v2" | null;
  opencodeServer?: string | null;
}): boolean {
  const rt = String(input.runtime ?? "");
  if (rt === "") return true;
  if (/^opencode/.test(rt)) return true;
  if (input.generation != null) return true;
  if (input.opencodeServer != null && input.opencodeServer !== "") return true;
  return false;
}

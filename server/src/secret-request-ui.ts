// #4827 —— agent「举手要密钥」的登记（admin 2026-11-20 需求）
//
// 契约（负责人 已定）：daemon_provider_snapshot 新增 action `secret_request_ui`，
// 入参 provider={node_id?, key, label?}，立刻返回 {ok:true,pending:true}，**不写任何值**。
// App 侧通过现有节点密钥 GET 响应的 `pending?: Array<{key,label?,requested_at,by_node_id}>` 发现它。
//
// 为什么用独立内存登记而不是现有 requests map：那条是「请求级」且 TTL 仅 120 秒
// （scoped-secrets.ts: expires_at = now + 120_000），人不可能保证 2 分钟内填完。
// 这里 TTL 30 分钟，进程内、不建表、不落库（重启丢失是可接受的降级：agent 再举手一次即可）。

export type PendingSecretRequest = {
  key: string;
  label?: string;
  requested_at: string;   // ISO-8601 UTC
  by_node_id: string;     // 举手的那个节点
};

const TTL_MS = 30 * 60 * 1000;
const MAX_PER_NODE = 8;
const KEY_MAX = 120;
const LABEL_MAX = 80;
/** node_id → (key → 请求) */
const store = new Map<string, Map<string, PendingSecretRequest & { expires_at: number }>>();

function sweep(now = Date.now()) {
  for (const [node, keys] of store) {
    for (const [key, r] of keys) if (r.expires_at <= now) keys.delete(key);
    if (keys.size === 0) store.delete(node);
  }
}

export function requestSecretUi(input: {
  nodeId: string;
  key: string;
  label?: string;
  byNodeId: string;
  now?: number;
}): { ok: true; pending: true } | { ok: false; error: "key_required" | "invalid_secret_input" } {
  const key = (input.key ?? "").trim();
  if (!key) return { ok: false, error: "key_required" };
  if (key.length > KEY_MAX || (input.label ?? "").length > LABEL_MAX) return { ok: false, error: "invalid_secret_input" };
  const now = input.now ?? Date.now();
  sweep(now);
  let keys = store.get(input.nodeId);
  if (!keys) { keys = new Map(); store.set(input.nodeId, keys); }
  keys.set(key, {
    key,
    ...(input.label ? { label: input.label } : {}),
    requested_at: new Date(now).toISOString(),
    by_node_id: input.byNodeId,
    expires_at: now + TTL_MS,
  });
  // 每节点上限，超了丢最旧（避免 agent 刷屏把响应撑爆）
  if (keys.size > MAX_PER_NODE) {
    const oldest = [...keys.values()].sort((a, b) => a.expires_at - b.expires_at)[0];
    keys.delete(oldest.key);
  }
  return { ok: true, pending: true };
}

/** 供 GET 节点密钥响应投影；无待填 ⇒ 返回 undefined（字段缺省，不是空数组）。 */
export function pendingSecretRequests(nodeId: string, now = Date.now()): PendingSecretRequest[] | undefined {
  sweep(now);
  const keys = store.get(nodeId);
  if (!keys || keys.size === 0) return undefined;
  return [...keys.values()]
    .sort((a, b) => a.requested_at.localeCompare(b.requested_at))
    .map(({ key, label, requested_at, by_node_id }) => ({ key, ...(label ? { label } : {}), requested_at, by_node_id }));
}

/** 用户提交（secret_put）成功后调用：清掉对应举手。 */
export function clearSecretRequest(nodeId: string, key: string): void {
  const keys = store.get(nodeId);
  if (!keys) return;
  keys.delete(key);
  if (keys.size === 0) store.delete(nodeId);
}

/** 仅供测试。 */
export function _resetForTest(): void { store.clear(); }

// 请求级 memo（2026-11-23）—— 和 McpServer 复用池配套的「不许跨请求」缓存。
//
// 背景：复用池让一台 McpServer 实例连续服务多个请求。注册时读库的权限快照会冻结到
// Hub 重启（负责人 review 阻断项），所以那些读库改成了「调用时现查」；但工具 handler
// 一次调用里可能问好几次同样的东西（restrictedNets / inboxSender …），每次都查库就
// 把查询放进了热路径。折中：**一个请求内算一次，跨请求清零**。
//
// 实现：WeakMap 以 McpServer 实例为键（弱引用，实例被 GC 时条目自然消失），
// `/mcp` 在 handleRequest 之前调用 resetRequestMemo(server) —— 池子复用同一实例时，
// 上一请求的值不会流到下一请求。
const memos = new WeakMap<object, Map<string, unknown>>();

/** 每个请求开始前清空该实例的 memo（`/mcp` 入口调用）。 */
export function resetRequestMemo(owner: object): void {
  memos.set(owner, new Map());
}

/** 同一个请求内按 key 只算一次；跨请求（reset 之后）重新算。 */
export function memoRequest<T>(owner: object, key: string, compute: () => T): T {
  let m = memos.get(owner);
  if (!m) { m = new Map(); memos.set(owner, m); }
  if (m.has(key)) return m.get(key) as T;
  const value = compute();
  m.set(key, value);
  return value;
}

/** 只给测试用：读当前 memo 的 key 集合（验证跨请求不残留）。 */
export function requestMemoKeysForTests(owner: object): string[] {
  return [...(memos.get(owner)?.keys() ?? [])];
}

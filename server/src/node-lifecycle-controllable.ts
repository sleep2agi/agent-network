/**
 * app#196 —— 哪些节点能走 stop_node / restart_node / delete_node。
 *
 * 抽成独立模块而不是写在 /api/nodes 的路由里,因为路由里的内联逻辑测不到 ——
 * 现有的 api-nodes-shape.test.ts 是直跑 handler 的 SQL,拿不到映射步骤。
 * 🔴 「不可测」本身就是一个设计信号,不是测试的问题。
 */

/** 子节点 id 由创建请求 id 确定性推导。
 *
 * 🔴 这条规则我用真实一对验过,不是只读注释:
 *    cr_59723b24-8372-4270-9b3c-1552e592a09f → node_59723b24-8372-4270-9b3c-…
 *    (2026-08-28 生产 hub 日志的 `create-node finalize` 行)
 *
 * 非 `cr_` 开头的一律返回 null —— 不猜,不截断。 */
export function childNodeIdForCreateRequest(requestId: unknown): string | null {
  if (typeof requestId !== "string") return null;
  if (!requestId.startsWith("cr_")) return null;
  const rest = requestId.slice(3);
  if (!rest) return null;
  return `node_${rest}`;
}

/** 由创建记录建出「child node_id → daemon node_id」的映射。 */
export function buildControllableMap(
  createRequests: Array<{ request_id?: unknown; daemon_node_id?: unknown }>,
): Map<string, string> {
  const m = new Map<string, string>();
  for (const cr of createRequests) {
    const child = childNodeIdForCreateRequest(cr?.request_id);
    if (!child) continue;
    m.set(child, typeof cr?.daemon_node_id === "string" ? cr.daemon_node_id : "");
  }
  return m;
}

/** 一个节点能不能走生命周期操作。
 *
 * 🔴 判据**不是 id 前缀**。前缀是实现细节;判据是 node_create_requests 里真有创建记录。
 *
 * 例外:daemon 自己(role=host_supervisor)也能被 restart/stop,而它在
 * node_create_requests 里**没有**记录(它不是被别的 daemon 创建的)—— 单独放行。
 * 漏掉这一条会把可控的 daemon 判成不可控。 */
export function isLifecycleControllable(
  nodeId: unknown,
  role: unknown,
  controllable: Map<string, string>,
): boolean {
  if (role === "host_supervisor") return true;
  return typeof nodeId === "string" && controllable.has(nodeId);
}

// #2363 —— MCP 在飞计数（先只观测，不拦请求）。
//
// 为什么需要它：隔离 Hub 上用**生产库副本**实测，RSS 与“同时在飞的 MCP 请求数”
// 成正比（≈1.2–1.4 MB/条；`send_message` 与 `get_inbox` 同形），而与吞吐无关——
// 顺序发 3,255 条/60s（≈54 条/秒）时 RSS 稳定在 151–156 MB，而 50/100/200 并发
// 的峰值是 249/446/689 MB。`/health` 里的 `sse_connections` 只反映长连接，看不到
// 这个量，所以生产上“为什么 RSS 突然抬到 450 MB”一直只能事后猜。
//
// 本模块只做计数与峰值，**不拒绝、不排队、不改任何响应**——限流（有界队列 + 429）
// 是另一步，需要先有一天的真实分布再定上限。见 docs/runbooks/hub-memory-and-sse.md。

let inflight = 0;
let peak = 0;

/** /mcp 进入时调用（在任何 await 之前，保证计入请求体解析阶段）。 */
export function enterMcpInflight(): void {
  inflight += 1;
  if (inflight > peak) peak = inflight;
}

/** /mcp 结束时调用（响应对象产出且 MCP server 已关闭）；重复调用安全。 */
export function leaveMcpInflight(): void {
  if (inflight > 0) inflight -= 1;
}

/**
 * 当前在飞数与**自上次 reset 以来的峰值**。
 * 峰值是“滚动高水位”，不会自己回落——运维看它判断是否撞到过悬崖，
 * 看 `inflight` 判断现在是否还在里面。
 */
export function getMcpInflightStats(): { inflight: number; peak: number } {
  return { inflight, peak };
}

/** 把峰值重置为当前在飞数（运维定位完一次尖峰后调用，或测试用）。 */
export function resetMcpInflightPeak(): void {
  peak = inflight;
}

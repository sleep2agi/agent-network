// GET /api/status 的「旧版 agent-node 找自己别名」读法识别(纯函数,可单测)。
//
// agent-node < 2.5.0-preview.93 的 CurrentAliasResolver 每 30 s 读一次全网完整 /api/status,只用
// sessions[].node_id / .alias,并且 2.5 s 硬超时。它的请求有一个别的客户端都不发的签名(2026-10-01 逐个核过
// 线上在用的 agent-node .32–.93 包、agent-network CLI 2.2.21 / 2.3.0-preview.76–.120 源码、dashboard、
// claude-code 节点的 .anet/node-server.js):
//   - 节点令牌(ntok_);
//   - Accept 恰好是 `application/json`(CLI 的 authHeaders 只带 Authorization;浏览器 / undici / bun 默认 `*/*`);
//   - 查询串里除了 network_id 什么都没有(不带 light / node_id / alias / full)。
// 命中 ⇒ 回 light 投影 + node_id(它读的就这两列)。`?full=1` 永远拿完整投影。

const ALLOWED_PARAMS = new Set(["network_id"]);

export function statusAliasResolverRead(params: URLSearchParams, token: string, accept: string | null): boolean {
  if (!token.startsWith("ntok_")) return false;
  if ((accept ?? "").trim().toLowerCase() !== "application/json") return false;
  for (const key of params.keys()) if (!ALLOWED_PARAMS.has(key)) return false;
  return true;
}

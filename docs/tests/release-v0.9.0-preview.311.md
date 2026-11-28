# commhub-server 0.9.0-preview.311

Since `.310`

## Install

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.311
```

## Upgrade

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.311
```

## What changed

```text
#3951（生产停顿止血）：广播 / 控制指令与不期待回复的行签收即终点，不再每 10 分钟回退成未读并重投。
  · rowExpectsResponse() 将 requires_response='none' 以及 type ∈ {message, reply, broadcast, control}
    判定为不期待回复，避免 363 会话规模广播反复触发 10 分钟回退重投风暴与 Hub 2–20s 停顿。
  · 新增任务粒度回复证据（repliedTasks，1h TTL）：正常顺序「先回执、后 ack」不再被误判为未确认回退。
  · send_message 写入普通聊天消息时显式标注 requires_response='none'。
#3950（性能，默认关闭）：McpServer 复用池，跳过每条 POST /mcp 重复注册 105 个工具的开销。
  · 默认关闭（发版本身零行为变化）；生产需在启动环境显式设置 COMMHUB_MCP_SERVER_POOL=1 开启，
    建议同时按在线节点规模配置 COMMHUB_MCP_SERVER_POOL_MAX（如 256，避免 150+ 节点下默认 64 发生 LRU 抖动）。
  · 复用键由 CreateServerOptions 全部 8 个字段（CREATE_SERVER_FIELDS）生成；鉴权与令牌吊销在进池前逐请求执行；
    5xx 与异常路径不回池；/health 鉴权侧暴露 mcp_server_pool 命中率读数。
  · 配套请求级 memo（request-memo.ts）与身份/权限现查，含用户令牌受限成员「非受限 ↔ 受限」双向即时生效修复。
只发 server；agent-node / CLI / App 不动。
```

## Verified

```text
POOL=1 组合回归 159/159（10 文件：acked-unconfirmed 19/19、ack-no-response-rows 7/7、mcp-server-pool-http 13/13、
mcp-pool-identity-freshness 2/2 含用户令牌受限双向复用、request-memo 3/3、mcp-inflight 7/7、broadcast-*、agent-acl-*）；
POOL=0 回归 144/144（8 文件）；storage-relay + package-self-contained 20/20；
160 身份 × 3 轮压测实测（MAX=256：命中率 72.9%、0 淘汰、CPU/请求 30.64→16.79ms，约 2.98 MB/实例）；
check-test-inventory（9531/9531）/ report-contract-pairs --assert / check-doc-version-claims /
check-no-live-tokens / check-no-memory-slugs / check-gates-wired 全过；#3951（82/82）与 #3950（86/86）CI 全绿合入 main。
```

# 节点环境变量

桌面端「节点设置 → 环境变量」管理每个节点自己的环境变量和 token（API key、网关地址等）。节点上的其它东西都从这里读：值存在**节点自己的 `config.json` 的 `env` 块**里，`agent-node` 启动时把它注入进程环境，`anet node start` 在拉起节点 / Claude Code 之前也读它。

为什么要有它：一个节点重启后掉线，原因是它的 API key 只存在于一条手敲的 shell 命令里，不在任何文件中。放进 `config.json` 之后，重启不再依赖任何人记得那条命令。

## 怎么用

- 列表里只显示键和「已设置 · N 位」，**值只写不读**：保存之后任何人（包括你自己）都看不到原值，只能覆盖或删除。
- 改动**重启节点后生效**。节点在 `anet node start` 的监督进程下时，桌面端的「保存并重启」走 `restart_node`；否则（直接起的 `agent-node`、Claude Code 会话）需要在节点所在机器上 `anet node stop <名>` 再 `anet node start <名>`。
- 列表里的「待重启生效」表示运行中的进程环境里不是这个值：还没重启，或者启动命令里有同名变量把它盖住了（外层环境优先）。

MCP 工具：`list_node_env` / `set_node_env` / `unset_node_env`，结果经 `get_rules_file_result` 轮询（与规则文件、技能、项目文件夹同一条门铃）。见 [MCP 工具](/api/mcp-tools)。

## 安全规则

| 规则 | 在哪里 |
|---|---|
| 只有用户登录能调用；节点 token 被拒（`node_token_cannot_manage_env`）；只能操作自己网络里的节点；结果只有发起请求的那个登录能读 | hub `server/src/tools.ts` |
| 键必须匹配 `^[A-Z_][A-Z0-9_]{0,127}$`，且不在保留名单里：`PATH`、`HOME`、`NODE_*`、`LD_*`、`DYLD_*`、`BUN_*`、`NPM_CONFIG_*`、`XDG_*`、`ANET_*`、`COMMHUB_*`、`*_BINARY`、`RUNTIME`、`ALIAS`、`MODEL`、`CODEX_HOME`、`GROK_HOME`、`SSL_CERT_FILE` 等会让节点起不来或被劫持的变量 | 唯一一份纯函数 `envKeyProblem`，hub 与节点各执行一次（逐字节相同，parity 测试钉住） |
| 值非空、UTF-8 不超过 8 KiB、不含 NUL | `envValueProblem` |
| 值不出现在任何回复、错误文案、审计日志或进程日志里；审计只记键和长度 | hub + 节点 |
| 节点 ack 的那一刻，hub 行里的值就被删掉（只留键）；超时、被拒、被顶替的请求同样当场清掉，另有 60 秒一次性定时器和 5 分钟后台兜底 | `purgeEnvRequestValues` |
| 节点写入：临时文件 → fsync → rename，权限 0600（原文件更严则保留），写前备份 `.prev`；拒绝软链接 / 硬链接 / 非本用户的 `config.json` | `agent-node/src/runtime/node-env.ts` |

## 传输闸：什么时候不允许写入密钥

远端节点目前经中继以明文 HTTP 连到 hub。`set_node_env` 只在**两段连接都加密或都在本机**时放行：

1. **这次调用**（桌面端 → hub）；
2. **目标节点**到 hub 的连接（节点每次上报时测一次；节点来拉请求时 hub 按拉取请求本身再判一次，明文拉取拿不到值，那条请求直接失败并清掉值）。

hub 对一段连接的判定：

- **loopback**：socket 对端地址是回环，**并且**对方拨的是回环地址（`Host` 头）。只看对端地址不够 —— frp 之类的隧道把中继过来的明文连接也从 `127.0.0.1` 送进来，但它们的 `Host` 是中继的地址。
- **https**：hub 自己以 TLS 提供服务；或者对端是回环、并带 `X-Forwarded-Proto: https`（本机上的反向代理 / 隧道端点替它终止了 TLS）。非回环对端带这个头不算数。
- 其它一律 **plain**。`X-Forwarded-For` 从不参与。

不满足时返回 `insecure_transport`，`leg` 为 `client` 或 `node`，桌面端显示「这个节点经未加密的中继连接，暂不允许写入密钥；等中继启用加密后自动可用」。`list_node_env` 与 `unset_node_env` 不带密钥，任何连接下都允许；`list_node_env` 的立即返回里有 `write_allowed` / `write_blocked`，桌面端据此在你输入密钥**之前**就把「添加」置灰。

**中继一旦启用 TLS 就自动解除**：节点的 hub 地址改成 `https://…`、终止 TLS 的那一跳带上 `X-Forwarded-Proto: https`，两段都判为 https，不需要改任何配置。

这道闸防的是「无意中把密钥走明文」，不是授权边界（授权边界是 token 与网络角色）：能伪造 `X-Forwarded-Proto` 的只有持有 token 的调用方自己，或明文链路上本来就看得见值的主动中间人。

## Claude Code 会话

`anet node start` 起的 Claude Code 会话也支持：启动器把 `config.json` 的 `env` 注入 `claude` 进程，会话的通道进程（node-server）改的是同一个文件。Claude Code 没有 exit-75 监督进程，所以列表里的重启方式总是「手动」。不是 `anet node start` 起的会话（找不到自己的 `config.json`）不上报 `env_capable`，桌面端直接说明原因。

## 版本

commhub-server `0.9.0-preview.61`、agent-node `2.5.0-preview.89`、anet（agent-network，Claude Code 会话需要）`2.3.0-preview.116` 起。旧节点不上报 `env_capable`，桌面端当场提示升级什么。

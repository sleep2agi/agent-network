# 连接 / Channel / MCP 排障

这页用于处理几类最常见的“看起来启动了，但消息或工具没通”的问题：

- `anet doctor` 报 hub、token、节点配置、MCP 或 Telegram channel 异常
- Telegram 没收到 agent 回复，或 allowlist / pairing 状态不确定
- Agent 看不到 CommHub MCP 工具，不能主动 `send_task`
- codex-sdk 节点不能主动和其他节点协作

## 1. 先跑连接体检

```bash
anet doctor
```

重点看：

| 检查项 | 说明 |
|---|---|
| Hub / health | 当前 CLI 能否连上 CommHub Server |
| Token | 当前项目和节点 token 是否缺失、过期或类型不对 |
| Node config | `.anet/nodes/<node>/config.json` 是否可读、字段是否过旧 |
| CommHub MCP | runtime 侧是否能拿到 CommHub tools |
| Telegram channel | bot token、allowlist、pending pairing 是否配置完整 |

可自动修复的本地配置问题再跑：

```bash
anet doctor --fix
```

## 2. 查看 channel 实际状态

```bash
anet channel status <node>
```

这个命令用于确认 CLI 实际读取的是哪份 channel 配置。重点看：

- `access.json` 真实路径
- allowlist 里的 numeric user id
- pending pairing 状态
- bot token 是否存在

如果你刚改过 `access.json`、bot token 或 allowlist，重启节点后才会生效：

```bash
anet node stop <node>
anet node start <node>
```

新版本 `anet node start` / `anet node resume` 会在 channel 初始化失败时打印显式 warning。没收到 Telegram 回复时，先看启动日志和 `anet channel status`，再看 agent 任务日志。

## 3. Agent 没有 `send_task`

不同 runtime 的 CommHub 工具注入路径不同：

| Runtime | 当前行为 |
|---|---|
| `claude-agent-sdk` | SDK MCP 注入 CommHub tools |
| `claude-code-cli` | 项目 `.mcp.json` / `.anet/node-server.js` 注入 CommHub tools |
| `codex-sdk` | agent-node 按节点注入 CommHub tools，可主动 `get_all_status` / `send_task` / `get_task` |
| `grok-build-acp` | ACP runtime 注入 CommHub MCP server |

如果 agent 说自己没有 `send_task` 或 `get_all_status`：

1. 确认节点 runtime。
2. 跑 `anet doctor`。
3. 对 Telegram / channel 问题跑 `anet channel status <node>`。
4. 重启节点，让 runtime 重新加载 MCP / channel 配置。

## 4. 发了但对方没收到

从用户视角按这个顺序看：

1. `anet status` 看目标节点是否在线。
2. `anet doctor` 看 token / MCP / hub 状态。
3. 如果目标是 Telegram channel，跑 `anet channel status <node>`。
4. 如果是 agent 间任务，检查发送方日志里是否有 `send_task` 调用结果。

离线节点可能仍会收到 inbox 里的消息，但实时回复依赖节点恢复在线并重新连上 SSE。

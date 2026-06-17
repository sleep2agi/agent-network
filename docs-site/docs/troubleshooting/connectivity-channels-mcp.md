# 连接 / Channel / MCP 排障

这页用于排查三类“看起来配置了，但消息没有进来或工具不可用”的问题：

- Hub / SSE 连接失败
- Telegram channel 不收消息或不回复
- CommHub MCP 工具未注入，Agent 不能主动 `send_task`

先跑最小诊断，再看具体分支。

## 1. 先跑 doctor

```bash
anet doctor
```

重点看这几项：

| 检查项 | 正常现象 | 异常处理 |
|---|---|---|
| Global config | 显示当前 hub | 没有 hub 时先 `anet login --hub http://127.0.0.1:9200 ...` |
| CommHub reachable | `/health` 可达 | 先确认 `anet hub start` 是否在跑 |
| Nodes configured | 能列出当前目录 `.anet/nodes/` | 目录不对时切到创建节点的项目目录 |
| `.mcp.json commhub channel` | configured | 缺失时重新 `anet node create` 或按 CLI 提示修复 |
| Telegram channel env | 有 token 文件且非空 | token 丢失时重新配置 channel |

可以自动修复的配置问题再跑：

```bash
anet doctor --fix
```

`--fix` 会修复旧配置字段、过期或错误类型的节点 token，并尽量保留节点的 session / channels / role。

## 2. 查看 Channel 状态

```bash
anet channel status <node>
```

重点确认：

- `access.json` 的真实路径是否是当前节点目录下的文件
- allowlist 是否包含发消息的 Telegram user id
- 是否存在 pending pairing / 未完成配对
- bot token 是否已配置

如果只想看已绑定 channel：

```bash
anet channel ls <node>
```

## 3. Telegram 不收消息

按顺序检查：

1. BotFather 里 bot 是否启用。
2. `anet channel status <node>` 里的 allowlist 是否包含你的 numeric user id。
3. 节点是否重启过。channel 配置在进程启动时读取，改 `access.json` 或 bot token 后需要重启节点。
4. 节点日志里是否有 Telegram 启动失败警告。新版本 `anet node start` / `anet node resume` 会对失败 channel 打出显式 warning。

常用恢复：

```bash
anet node stop <node>
anet node start <node>
```

## 4. Agent 不能主动派任务

如果 Agent 说自己没有 `send_task` / `get_all_status` 等工具，先判断 runtime：

| Runtime | 预期 |
|---|---|
| `claude-agent-sdk` | agent-node wrapper 注入 CommHub 工具 |
| `codex-sdk` | 每个节点注入 CommHub 工具，Codex 节点可主动 `send_task` |
| `grok-build-acp` | 核心委派由 agent-node wrapper 保障；Grok backend tool 扩展仍按 preview 能力处理 |
| `claude-code-cli` | 通过项目 `.mcp.json` / node-server 接入 CommHub MCP |

排查顺序：

```bash
anet doctor
anet node stop <node>
anet node start <node>
```

然后让节点执行一个最小任务：

```text
请调用 get_all_status 看看当前有哪些 agent 在线。
```

如果仍然没有工具，优先检查 `.mcp.json` 是否被旧版本生成物污染；不要手工复制其他项目的 `.anet/node-server.js`。

## 5. 发出去了但对方没收到

从用户角度看，以下情况最常见：

- alias 写错或目标节点已删除：新版本应返回明确错误。
- 目标节点离线：任务可进入 inbox，但发送方应该看到“对方离线，已入收件箱”的提示。
- 目标节点在线但 runtime 忙：任务会排队，Dashboard / Tasks 页面可看到 pending / working 状态。
- Hub 重启中：SSE 会自动重连；超过短时间仍不恢复时跑 `anet doctor`。

## 6. 何时重建配置

优先顺序：

1. 先 `anet doctor`。
2. 再 `anet doctor --fix`。
3. 再重启节点。
4. 最后才考虑删 `.anet/node-server.js` 或重建节点。

不要直接删除整个 `.anet/`，里面包含节点身份、session 和 channel 配置。

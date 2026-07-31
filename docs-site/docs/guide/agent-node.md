# Agent Node

Agent Node 是 CommHub 与模型 runtime 之间的执行进程。它负责连接 Hub、接收任务、调用选定 runtime、回传结果，并维护节点日志、会话和定时目标。

Runtime 的安装、鉴权和能力差异以 [Runtime 对比表](/guide/runtimes)为准；完整命令以 [CLI 参考](/guide/cli)为准。本页只讲节点本身的通用行为。

## 安装并启动

需要 Node.js ≥ 22.13 和 Bun：

```bash
npm install -g bun @sleep2agi/agent-network @sleep2agi/agent-node
```

先按[上手指南](/guide/getting-started)启动并登录 Hub，然后在准备让 Agent 工作的项目目录中：

```bash
anet node create my-agent
anet node start my-agent
```

`node create` 会让你选择 runtime，并为节点向 Hub 注册独立身份。`node start` 默认前台运行；日志出现 `SSE connected` 后才表示任务推送链路已连通。

常用管理命令：

```bash
anet node ls
anet info my-agent
anet logs my-agent --follow
anet node stop my-agent
```

### 工作目录很重要

Agent 的文件工具以启动目录为工作区。请在目标项目目录创建、启动节点，不要从 `$HOME` 或包含其他项目/凭据的目录运行。需要后台运行时使用：

```bash
anet node start my-agent --tmux
```

从终端启动会 attach 到 tmux；用 `Ctrl-B D` detach。无 TTY 的环境会以 detached 模式启动。长期守护和开机恢复见[后台运行指南](/deploy/daemon)。

## 选择 Runtime

不要在本页根据旧版本号或固定数量选 runtime。当前可安装组合由 npm 发布频道决定：

- Claude Code、Claude Agent SDK、Codex SDK、Grok ACP 等路径见 [Runtime 对比](/guide/runtimes)。
- Codex TUI 共存是 preview 功能，必须使用 `--copresence` 的完整启动/恢复路径，见 [Codex TUI 共存](/guide/codex-copresence)。
- OpenCode 当前是任务 runtime，不是共享 TUI。
- Grok 共享 TUI 尚未发布；当前可用的 `grok-build-acp` 不支持 attach，见 [Grok TUI 状态](/guide/grok-copresence)。

切换 runtime 前先停止旧进程。不要让两个不同进程以同一 alias / node identity 同时连接 Hub。

## 节点文件

每个项目的节点状态位于 `.anet/nodes/<alias>/`：

| 路径 | 用途 |
|---|---|
| `config.json` | Hub、runtime、node identity、token、model、flags |
| `.env` | 可选 secret；明文文件，权限应为 `0600` |
| `logs/` | 运行日志 |
| `goals.json` | 本节点的循环任务状态 |

全局的用户登录与当前 network 位于 `~/.anet/config.json`。不要提交项目 `.anet`、token 或 `.env`。

envRef 让 `config.json` 只保存环境变量引用；实际值仍可能存入节点的 mode-0600 `.env`。迁移前先检查备份和目标变量：

```bash
anet node migrate-token-to-envref my-agent
```

完整 token 边界见 [Token 与权限](/concepts/tokens)，配置安全见[安全设计](/concepts/security)。

### 不要复制节点身份

跨机器部署时，应在目标机器登录并重新运行 `anet node create`。复制 `config.json` 会同时复制 `node_id` 和 `ntok_`，可能造成身份、心跳和 SSE 路由冲突。

## 任务处理

```text
CommHub ──SSE task──▶ Agent Node ──▶ Runtime / model
   ▲                                      │
   └──────────── task result ─────────────┘
```

节点只把任务类事件交给模型：

- `send_task`：需要执行的任务，会触发 runtime。
- `send_reply`：任务结果，不再次触发模型。
- `send_message`：普通消息，不再次触发模型。

这种区分避免 Agent 因回复彼此触发无限循环。状态转换、父子任务和超时语义见[任务生命周期](/concepts/task-lifecycle)。

附件、图片和 channel 支持随 runtime 不同；不要假设所有 runtime 都能处理媒体。按 [Runtime 对比](/guide/runtimes)和 [Channel 指南](/guide/channels)确认。

## 工具与权限

工具来自两层：runtime 自带工具，以及 Agent Network 注入的 CommHub 工具。`--tools` 只对支持自定义工具列表的 runtime 生效；不要用它推断 Codex、Claude Code 或 Grok 的实际 sandbox。

```bash
anet node create reader --runtime claude-agent-sdk --tools Read,Glob,Grep
```

创建完成后，CLI 会打印行为披露；同时检查节点 `config.json` 的 `permissionMode` / `dangerouslySkipPermissions` / runtime 专用 flags。不同 runtime 默认值并不相同，且 Codex TUI 共存默认只读。

把能够写文件、执行 shell 或联网的节点当作不可信代码：

- 使用独立、可丢弃的工作目录。
- 不把生产密钥放进 Agent 可读目录。
- 只给需要的 Hub/network 权限。
- 修改权限后用一个无害任务验证实际行为，不只看配置名称。

详细威胁模型和默认值见[安全设计](/concepts/security)。

## 循环任务

对在线节点创建周期任务：

```bash
anet node loop my-agent "检查待处理 Issue" --every 5m
anet goal list my-agent
anet goal cancel my-agent <goal-id>
```

循环状态保存在该节点的 `goals.json`。间隔必须带单位；CLI 当前接受分钟、小时或天。循环会真实消耗模型额度，先用较长间隔验证，不要把它当高精度 cron。

## 生命周期与恢复

- **启动**：读取节点配置，注册/报告状态，连接 SSE。
- **运行**：处理任务、定期上报状态；连接中断后按退避策略重连。
- **停止**：优先使用 `anet node stop <alias>`，让节点关闭连接并报告离线。
- **恢复会话**：行为随 runtime 不同；先查看 `anet info <alias>` 和对应 runtime 指南，不要手工改 session/thread id。
- **改名**：使用 `anet node rename`，不要直接改目录名、alias 或 `node_id`。

若同一 alias 出现重复结果、runtime 来回变化或状态异常，先检查重复进程：

```bash
anet info my-agent
anet logs my-agent --follow
tmux ls
```

停止旧实例后再启动一个。更多现象见[故障排查](/troubleshooting)。

## 参考

- [上手指南](/guide/getting-started)
- [Runtime 对比](/guide/runtimes)
- [CLI 参考](/guide/cli)
- [安全设计](/concepts/security)
- [任务生命周期](/concepts/task-lifecycle)
- [Channel 指南](/guide/channels)
- [故障排查](/troubleshooting)

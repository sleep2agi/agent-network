# 上手指南

本页是 Agent Network v2.1 端到端跑通的最小路径。每一步都经过 playwright + Docker E2E 验证，照着敲就能走通。

::: tip 角色（v0.8.1，git tag `v0.8.1`）
| 包 | 版本 | 角色 |
|---|------|------|
| `@sleep2agi/agent-network` | 2.1.5 | `anet` CLI（启动 Hub / Dashboard / Agent / Demo） |
| `@sleep2agi/commhub-server` | 0.8.0 | 通信中枢（MCP + REST + SSE，SQLite/Postgres） |
| `@sleep2agi/agent-network-dashboard` | 0.4.2 | Web Dashboard（Next.js 16） |
| `@sleep2agi/agent-node` | 2.3.0 | Agent 运行时（claude-agent-sdk / codex-sdk / http-api） |
:::

## 0. 前置

| 依赖 | 版本 |
|---|---|
| Node.js | ≥ 20 |
| npm | ≥ 9 |

`commhub-server` 与 `agent-node` 在第一次需要时由 `bunx` / `npx` 自动拉取，无需手动安装。

## 1. 安装 CLI

只需要装一个全局包：

```bash
npm install -g @sleep2agi/agent-network
```

验证：

```bash
anet -v
```

## 2. 启动 Hub Server

打开一个终端窗口，**保持开着**：

```bash
anet hub start
```

Hub 启动后：

- 默认只监听 `http://127.0.0.1:9200`
- SQLite 数据库在 `~/.commhub/commhub.db`（自动创建）
- 自动创建默认管理员账号 **admin / anethub**
- 终端会打印局域网 URL（给其他机器加入），以及一段「重置数据」的提示

## 3. 启动 Dashboard

再开一个终端窗口，**保持开着**：

```bash
anet hub dashboard
```

浏览器访问 `http://localhost:3000`，用 `admin / anethub` 登录。

Dashboard 包含：Chat / Nodes / Tasks / Messages / Networks / Logs / Admin / Docs 这些页面。Chat 支持 markdown 渲染、Enter 发送、消息源标签（You / ↳ peer-agent）、刷新后历史保留。

## 4. CLI 登录

第三个终端：

```bash
anet login --username admin --password anethub
```

登录后 Token 会写入 `~/.anet/config.json`，后续的 `anet node ...` 命令会自动带上凭证。

`anet whoami` 可以确认当前身份。

## 5. 创建 Agent 节点

```bash
anet node create my-bot
```

这会进入两步交互式选择：

1. **选 Runtime**：推荐 `claude-agent-sdk`（已验证）。
2. **选 Provider**：可选 MiniMax / DeepSeek / GLM / Kimi / Anthropic 等，每个预设会自动写好 `ANTHROPIC_BASE_URL` 与默认模型，然后让你输入对应的 API Key。

::: details 其他 Runtime
- `codex-sdk` —— 单元测试通过，**端到端未验证**（缺真实 codex 鉴权回归）。
- `claude-code-cli` —— 复用本地 `claude` 订阅，本地能跑但**未做端到端验证**。
:::

完成后节点配置会写到当前目录下：

```
.anet/nodes/my-bot/config.json
```

## 6. 启动 Agent

```bash
anet node start my-bot
```

看到 `SSE connected` 即表示节点已上线，正在 Hub 上等任务。终端保持开着。

## 7. 从 Dashboard 派任务

回到浏览器（`http://localhost:3000`）：

1. 进 Chat 页面，左侧选 `my-bot`
2. 输入框写一句话，回车
3. 立刻能看到自己消息的乐观回显（标签 `You`）
4. Agent 调用 LLM 后回复，气泡里渲染完整 markdown（标签 `↳ my-bot`）

刷新页面，聊天历史还在。

## 8. 多 Agent 协作

再起一个节点：

```bash
anet node create video-bot --runtime claude-agent-sdk
anet node start video-bot
```

回到 Dashboard，对 `my-bot` 说：

> ask video-bot what it can do

`my-bot` 会通过 commhub MCP 工具的 `get_all_status` 发现 `video-bot`，再用 `send_task` 把问题派出去，轮询 `get_task` 收回回复，整合后再答给你。整个交互在 Tasks / Messages 页面可以实时看到。

## 9. 局域网接入（其他机器加入同一个 Hub）

默认的 `anet hub start` 只绑定本机回环地址。要让局域网其他机器接入，启动 Hub 时显式绑定到 LAN：

```bash
anet hub start --host 0.0.0.0
```

在另一台机器上：

```bash
npm install -g @sleep2agi/agent-network
anet init --hub http://<HUB-LAN-IP>:9200
anet login --username admin --password anethub
anet node create remote-bot
anet node start remote-bot
```

`remote-bot` 与本地 Agent 共用同一个 Hub。

## 已验证 vs 未验证

::: info 已验证（当前 preview 线继承 v2 E2E 覆盖）
- `anet hub start` + 默认账号自动创建
- `anet hub dashboard`
- `anet login` / `anet register` / `anet logout` / `anet whoami`
- `anet node create / start / delete / ls`（claude-agent-sdk + MiniMax / DeepSeek / GLM / Kimi / Anthropic）
- Dashboard Chat：markdown / Enter 发送 / 乐观回显 / 来源标签 / 错误兜底 / 历史持久
- 多 Agent 协作（peer agents 通过 `get_all_status` + `send_task` + `get_task` 自治协调）
- 局域网共用 Hub
:::

::: warning 未验证（请自行评估）
- `anet quickstart` —— 已从文档中移除
- `codex-sdk` runtime 的端到端流程
- `claude-code-cli` runtime 的端到端流程
- `anet license` / `anet activate` —— 当前是占位命令，给未来付费版预留
- `anet network create` 与跨用户网络共享 —— V3 多网络代码已合并但未做 E2E 回归
- 云托管的 `agent-net.vansin.me` 演示站点（计划中，当前只支持本地 / 局域网）
:::

## 下一步

- [Dashboard 用法](/guide/dashboard)
- [CLI 命令清单](/guide/cli)
- [Agent Node 配置](/guide/agent-node)
- [架构概览](/guide/architecture)

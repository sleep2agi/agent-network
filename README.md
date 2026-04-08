![Agent Comm Hub](assets/banner.png)

# Agent Comm Hub

> 开源的多 AI Agent Session 跨服务器编排方案。
> 源自 48+ 小时、4 台服务器、15+ 并发 Agent Session 的实战经验。
> **v0.4.1**: CommHub Channel (stdio) + SSE Push + 项目路径 .env 自动配置

---

## 这是什么？

一套经过实战验证的模式和工具，用于协调分布在多台服务器上的 AI 编程 Agent（Claude Code、Codex 等）。核心组件是 **CommHub Server**——一个基于 MCP Streamable HTTP 星型架构的跨服务器通信中枢。

## 快速开始

> ---
> **同名冲突警告**
>
> 同名 `commhub` 的 MCP Tool（http 类型）和 Channel 插件（stdio 类型）**不能同时配置**。Claude Code 按优先级只加载一个，另一个会被静默忽略。
>
> | 载体 | 正确配法 |
> |------|---------|
> | **Claude Code** | 全局 `~/.claude.json` stdio 类型 + 启动参数 `server:commhub`（方式 B） |
> | **Codex / OpenCode** | MCP Tool http 类型，名称用 `commhub-api`（方式 A） |
>
> **铁律：项目 `.mcp.json` 里不要配 commhub**（会覆盖全局配置导致 Channel 失效）。
> ---

### 方式 A：MCP Tool 接入（最简单，无推送）

```bash
# 1. 部署 CommHub（5 分钟）
cd server && bun install && bun run start

# 2. 每个 Agent 加一行配置即可连上
# ~/.claude/settings.json（注意用 commhub-api 避免和 Channel 冲突）
{ "mcpServers": { "commhub-api": { "url": "http://YOUR_IP:9200/mcp" } } }
```

> **注意**：方式 A 和方式 B 的 MCP Server 名不能都叫 `commhub`。如果同时使用两种方式，方式 A 改名为 `commhub-api`。方式 A 只提供工具，不提供 SSE 推送——适合 Codex、OpenCode 等无 Channel 的载体。

### 方式 B：Channel 插件接入（实时推送，推荐）

```bash
# 1. 安装 Channel 插件
cd channel && bun install

# 2. 复制 channel 插件到 Claude Code channels 目录
mkdir -p ~/.claude/channels/commhub
cp channel/server.ts ~/.claude/channels/commhub/server.ts

# 3. 配置共享 .env（CommHub Server 地址）
echo 'COMMHUB_URL=http://YOUR_IP:9200' > ~/.claude/channels/commhub/.env

# 4. 配置 session 别名（按项目路径创建 .env）
# 路径规则：项目绝对路径把 / 替换为 -
# 例如 /home/vansin/blueleap → -home-vansin-blueleap
mkdir -p ~/.claude/channels/commhub/-home-vansin-blueleap
echo 'COMMHUB_ALIAS=B站开发马' > ~/.claude/channels/commhub/-home-vansin-blueleap/.env

# 5. 在全局 ~/.claude.json 中注册 commhub MCP Server
# （在 mcpServers 字段中添加）
{
  "commhub": {
    "type": "stdio",
    "command": "bun",
    "args": ["/home/vansin/.claude/channels/commhub/server.ts"],
    "env": {}
  }
}

# 6. 启动 Claude Code（必须加 server:commhub 才有推送能力）
claude --dangerously-skip-permissions \
       --dangerously-load-development-channels server:commhub \
       --teammate-mode in-process
```

Channel 模式下，CommHub 通过 SSE 实时推送任务到 Agent 对话中，无需轮询。

> **重要**：`--dangerously-load-development-channels server:commhub` 是必须的！
> - 全局 `~/.claude.json` 中的 commhub 配置只提供 **工具**（send_task 等）
> - `server:commhub` 参数才赋予 **推送权限**（被动接收消息注入对话）
> - 两者缺一不可：全局配置提供工具，启动参数提供推送
>
> **注意**：项目目录的 `.mcp.json` 中**不要**配置 commhub，否则会覆盖全局 stdio 配置导致 channel 不加载。

详见 [`docs/quickstart.md`](docs/quickstart.md)，新电脑 5 步配完。

## 关键发现

> 这些是踩坑后总结的核心知识点，写在最前面防止重复踩坑。

### 1. `server:{name}` 查的是 .mcp.json 里的 MCP 条目

`--dangerously-load-development-channels server:commhub` 的含义是：从当前项目的 `.mcp.json`（或 `~/.claude/.mcp.json`）中找到名为 `commhub` 的 MCP Server 定义，然后以 Channel 模式启动它。

### 2. Channel 必须用 stdio 类型

Channel 本质是 Claude Code 启动的一个子进程，通过 stdin/stdout 双向通信。所以 MCP 配置**必须**是 `"type": "stdio"` + `"command"` + `"args"`：

```json
{
  "commhub": {
    "type": "stdio",
    "command": "bun",
    "args": ["run", "/path/to/channel/commhub-channel.ts"]
  }
}
```

**不能用 `"url": "http://..."` 的 http 类型**——http 类型不启动子进程，Channel 无法工作。

### 3. alias 从项目路径 .env 自动获取

Channel 插件的 alias（即 CommHub 中的 session 名称）按优先级解析：

| 优先级 | 来源 | 说明 |
|--------|------|------|
| 1 | `COMMHUB_ALIAS` 环境变量 | 手动指定，最高优先 |
| 2 | 项目路径 `.env` 文件 | `~/.claude/channels/commhub/{project-path}/.env` |
| 3 | tmux session 名称 | 自动检测 |
| 4 | hostname | 兜底 |

项目路径 `.env` 的位置规则：将项目绝对路径的 `/` 替换为 `-`。例如项目在 `/home/vansin/my-project`，对应的 `.env` 文件是：
```
~/.claude/channels/commhub/-home-vansin-my-project/.env
```

### 4. 同项目目录多 session 用 COMMHUB_ALIAS 区分

如果在同一个项目目录下开多个 Claude Code session，它们会解析出相同的 alias。用 `COMMHUB_ALIAS` 环境变量区分：

```bash
# Session 1
COMMHUB_ALIAS=dev-1 claude --dangerously-load-development-channels server:commhub

# Session 2
COMMHUB_ALIAS=dev-2 claude --dangerously-load-development-channels server:commhub
```

### 5. 共享配置和项目配置分离

```
~/.claude/channels/commhub/
├── .env                              # 共享配置（COMMHUB_URL, COMMHUB_TOKEN）
├── -home-vansin-project-a/
│   └── .env                          # 项目 A 的 alias 等
└── -home-vansin-project-b/
    └── .env                          # 项目 B 的 alias 等
```

共享 `.env` 示例：
```bash
COMMHUB_URL=http://YOUR_IP:9200
COMMHUB_TOKEN=your-secret-token
```

项目 `.env` 示例：
```bash
COMMHUB_ALIAS=my-agent-name
```

## 架构

**MCP Streamable HTTP 星型拓扑**——一个 CommHub Server 居中，所有 Session 通过 Streamable HTTP 连接接入。

```
                    ┌──────────────────────────────────┐
                    │     CommHub Server v0.4.1         │
                    │     your-server:9200              │
                    │                                   │
                    │   POST /mcp    → Streamable HTTP  │
                    │   GET  /events → SSE Push         │
                    │   GET  /api    → REST             │
                    └──────────┬─────────────────────────┘
                               │
          ┌────────┬───────┬───┴───┬────────┬──────────┐
          │        │       │       │        │          │
       Claude   Claude  Claude  MiniMax  Codex      Claude
       Code     Code    Code    M2.7     GPT-5.4    Code
       (Channel)(Channel)(MCP)  (MCP http)(Proxy)   (Channel)
       硅谷      Mac     96GB    96GB     硅谷       服务器D
```

### 三种接入方式

| 方式 | 接口 | 配置 | 延迟 | 适用场景 | 已验证 |
|------|------|------|------|---------|--------|
| **Channel 插件** | SSE Push | `"type": "stdio"` .mcp.json | 实时 <1s | Claude Code 推荐 | Claude Code (硅谷/Mac/96GB) |
| **MCP http** | `POST /mcp` | `"url": "http://..."` settings.json | Agent 主动调用 | 第三方模型 (MiniMax/Qwen) | MiniMax-M2.7 (96GB) |
| **commhub-proxy** | 长轮询 25s | `codex mcp add` stdio | 0-25s | Codex 推荐 | Codex GPT-5.4 (硅谷) |

### 核心设计决策

1. **星型拓扑** -- 30 个 Session = 30 条连接，不是 N^2 网状
2. **Streamable HTTP + SSE Push** -- MCP 用 Streamable HTTP，推送用 SSE 持久连接
3. **三接口** -- MCP Streamable HTTP + SSE Push + HTTP REST，各司其职
4. **跨模型通信** -- Claude Code <-> Codex 通过 CommHub 中转，无需直连
5. **单服务器** -- 一个进程、一个 SQLite 数据库，运维简单

### 技术栈

| 组件 | 选型 |
|------|------|
| 运行时 | Bun 1.2+ |
| 语言 | TypeScript |
| MCP SDK | `@modelcontextprotocol/sdk` |
| 数据库 | SQLite (`bun:sqlite`, WAL 模式) |
| 传输 | MCP Streamable HTTP + SSE Push + HTTP REST |
| 进程管理 | systemd |

## 要解决的核心问题

在多台服务器上用 tmux 跑多个 AI Agent 时，你会遇到：

1. **无结构化通信** -- `tmux send-keys` 分不清当前是 Shell 还是 Agent 界面
2. **跨服务器协调痛苦** -- SSH 嵌套、超时、ANSI 转义码乱码
3. **无消息队列** -- 发给忙碌 Agent 的命令直接丢失
4. **无状态感知** -- 只能靠截屏猜 Agent 状态

## 方案对比

| # | 方案 | 跨服务器 | 可靠性 | 状态 |
|---|------|---------|--------|------|
| 1 | tmux send-keys | 支持（SSH） | 20% | 遗留备选 |
| 2 | Codex MCP Tool | 仅本地 | 95% | 已验证 |
| 3 | Codex Plugin | 仅本地 | 95% | 已验证 |
| 4 | Agent Teams | 仅本地 | 90% | 已启用 |
| 5 | MCO (Multi-CLI Orchestrator) | 仅本地 | 90% | 可用 |
| 6 | oh-my-claudecode | 仅本地 | 85% | 社区 |
| **7** | **CommHub MCP (Streamable HTTP + SSE Push)** | **支持** | **99%** | **v0.4.1 已上线** |

## 核心发现

**MCP 调用比 tmux 高效 10 倍。** 一次 `mcp__codex__codex()` 调用 30 秒返回结构化结果。tmux 方式需要 3-5 分钟的 SSH + 窗口检测 + send-keys + capture-pane + ANSI 解析——而且经常失败。

**协议选型：纯 MCP。** Claude Code 和 Codex 原生支持 MCP，零适配成本。A2A（Google）和 ACP（IBM）解决的是 Agent 发现和编排，但我们的 30 个 Session 都是自己的、地址已知，不需要"发现"机制。详见 [`docs/protocol-decision.md`](docs/protocol-decision.md)。

## CommHub MCP 工具（9 个）

### 子 Agent 工具（4 个）

| 工具 | 用途 |
|------|------|
| `report_status` | 心跳 + 当前任务 + 进度（返回 inbox 数量） |
| `report_completion` | 任务完成，提交结果和产出物 |
| `get_inbox` | 拉取 Hub 下发的待办命令 |
| `ack_inbox` | 确认收到命令 |

### Hub 指挥工具（5 个）

| 工具 | 用途 |
|------|------|
| `get_all_status` | 全局状态面板 |
| `get_session_status` | 查看单个 Session 详情 |
| `send_task` | 带优先级下发任务 |
| `broadcast` | 群发消息（可按服务器/状态过滤） |
| `get_completions` | 获取已完成任务结果 |

## Channel 插件工具（2 个）

Channel 模式下 Agent 额外获得：

| 工具 | 用途 |
|------|------|
| `commhub_reply` | 回复 CommHub 任务（完成/进行中/阻塞/错误） |
| `commhub_report_status` | 更新 Session 状态（working/idle/blocked/error） |

> 注：Channel 模式下也可以通过 MCP Tool 模式的 `send_task` 向其他 Session 发任务（如果同时配了 MCP Tool 连接）。

## 工作流程

### MCP Tool 模式（Agent 主动拉取）

```
Hub (指挥室)                  CommHub              Agent (MCP Tool)
     │                            │                        │
     │  send_task("dev","修Bug")   │                        │
     │───────────────────────────▶│  写入 inbox             │
     │                            │                        │
     │                            │     report_status()    │
     │                            │◀───────────────────────│
     │                            │  返回 inbox_count=1    │
     │                            │───────────────────────▶│
     │                            │                        │
     │                            │     get_inbox()        │
     │                            │◀───────────────────────│
     │                            │  返回 [修 Bug 任务]    │
     │                            │───────────────────────▶│
     │                            │                        │
     │                            │  report_completion()   │
     │                            │◀───────────────────────│
     │                            │                        │
     │  get_completions()         │                        │
     │───────────────────────────▶│                        │
     │  ◀── [修 Bug 完成, 结果]    │                        │
```

### Channel 插件模式（SSE 实时推送）

```
Hub (指挥室)                  CommHub              Agent (Channel)
     │                            │                        │
     │                            │◀── SSE /events/agent ──│  长连接建立
     │                            │                        │
     │  send_task("agent","修Bug") │                        │
     │───────────────────────────▶│  写入 inbox             │
     │                            │── SSE push ──────────▶│  任务秒达！
     │                            │                        │  注入 Claude Code 对话
     │                            │                        │
     │                            │  (Agent 自动执行...)    │
     │                            │                        │
     │                            │  commhub_reply()       │
     │                            │◀───────────────────────│  Channel Tool 回报
     │                            │                        │
     │  get_completions()         │                        │
     │───────────────────────────▶│                        │
     │  ◀── [修 Bug 完成, 结果]    │                        │
```

Channel 模式优势：**任务从 Hub 发出到 Agent 看到 < 1 秒**，无需 Agent 轮询 inbox。

## 文档

- [`docs/quickstart.md`](docs/quickstart.md) -- **新电脑 5 步配完**
- [`docs/codex-commander-plan.md`](docs/codex-commander-plan.md) -- Codex 指挥室方案：Claude Code 备用中控
- [`docs/commhub-codex-bridge.md`](docs/commhub-codex-bridge.md) -- CommHub-Codex Bridge 协议设计 + 最小实现
- [`docs/channel-research.md`](docs/channel-research.md) -- Channel 通信方案调研：mcp-wechat-server + codex-plugin-cc 源码分析
- [`docs/codex-app-server.md`](docs/codex-app-server.md) -- Codex App-Server 调研：协议、能力、混合方案
- [`docs/commhub-limitations.md`](docs/commhub-limitations.md) -- 已知限制和注意事项
- [`docs/protocol-decision.md`](docs/protocol-decision.md) -- 协议选型：为什么用 MCP（不用 A2A、不用 ACP）
- [`docs/architecture-decision.md`](docs/architecture-decision.md) -- 架构决策记录：MCP Streamable HTTP 星型拓扑
- [`docs/commhub-mcp-design.md`](docs/commhub-mcp-design.md) -- CommHub Server 详细设计
- [`docs/orchestration-guide.md`](docs/orchestration-guide.md) -- 全方案对比 + 成本分析
- [`docs/experience.md`](docs/experience.md) -- 48 小时实战报告：教训和原则

## CommHub Channel 插件

Channel 插件让 CommHub 任务直接注入 Claude Code 对话——无需轮询，任务秒达。

```
channel/
├── commhub-channel.ts     # Channel 插件主代码（stdio 类型）
└── package.json
```

### 安装

```bash
cd channel && bun install
```

### 配置（两步）

**第一步：安装 Channel 插件**
```bash
cp channel/server.ts ~/.claude/channels/commhub/server.ts
```

**第二步：配全局 MCP 工具**（`~/.claude.json`）
```json
{
  "mcpServers": {
    "commhub": {
      "type": "stdio",
      "command": "bun",
      "args": ["run", "/absolute/path/to/agent-comm-hub/channel/server.ts"]
    }
  }
}
```

> **警告**：不要在项目 `.mcp.json` 里配 commhub，会和 Channel 冲突。MCP 工具层配在全局 `~/.claude.json`，推送层由 Channel 插件提供，两者缺一不可。

### 启动

```bash
claude --dangerously-skip-permissions \
       --dangerously-load-development-channels server:commhub
```

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `COMMHUB_URL` | `http://127.0.0.1:9200` | CommHub Server 地址 |
| `COMMHUB_ALIAS` | (自动解析) | 手动指定 Session 名称 |
| `COMMHUB_TOKEN` | (空) | 认证 Token（匹配服务端 `COMMHUB_AUTH_TOKEN`） |
| `COMMHUB_TMUX` | (自动检测) | 手动指定 tmux session 名称 |

## CommHub Proxy（Codex 专用）

Codex 不支持 Channel，用 commhub-proxy 代替——一个长轮询 MCP stdio Server，参考 mcp-wechat-server 的阻塞模式。

```
proxy/
├── commhub-proxy.ts    # 长轮询 MCP Server（Codex 用）
└── package.json
```

### 配置（一行命令）

```bash
codex mcp add commhub-proxy \
  --env COMMHUB_URL=http://YOUR_IP:9200 \
  --env COMMHUB_ALIAS=codex-my-agent \
  -- bun /path/to/agent-comm-hub/proxy/commhub-proxy.ts
```

### 启动

```bash
codex --dangerously-bypass-approvals-and-sandbox \
  "LOOP FOREVER: call commhub-proxy.get_task(wait=true), execute tasks, report_result. NEVER STOP."
```

### Proxy Tools（4 个）

| 工具 | 用途 |
|------|------|
| `get_task` | 长轮询 25s 等 CommHub 任务（阻塞到有任务或超时） |
| `report_result` | 任务完成回报 |
| `send_message` | 向其他 session 发消息 |
| `get_status` | 查看全局状态 |

## 实战验证结果

| Agent | 模型 | 服务器 | 接入方式 | 状态 |
|-------|------|--------|---------|------|
| 通信哥 | Claude Opus 4.6 | 硅谷 | Channel (SSE) | 运行中 |
| codex-硅谷 | GPT-5.4 | 硅谷 | commhub-proxy (长轮询) | 自动轮询中 |
| minimax-96g | MiniMax-M2.7 | 96GB | MCP http | idle 待命 |
| 指挥室 | Claude Opus 4.6 | 硅谷 | Channel (SSE) | 调度中 |
| 知识哥 | Claude Opus 4.6 | Mac | Channel (SSE) | 待命 |
| 书小生 | Claude Opus 4.6 | Mac | Channel (SSE) | 视频生成中 |

**跨模型通信已验证**: Claude Code <-> Codex GPT-5.4 <-> MiniMax M2.7 全部通过 CommHub 双向通信。

## 落地路径

### Phase 1（已完成）
1. ~~Codex MCP Tool 做本地代码审查~~
2. ~~Agent Teams 做本地并行任务~~

### Phase 2（已完成）
3. ~~**部署 CommHub Server**~~ -- v0.4.1 上线
4. ~~所有 Session 配上 MCP URL~~
5. ~~**CommHub Channel 插件**~~ -- SSE 实时推送已验证
6. ~~**Channel stdio 模式确认**~~ -- server:commhub + .mcp.json 配置已验证
7. ~~**commhub-proxy for Codex**~~ -- 长轮询 MCP Server 已验证
8. ~~**跨模型通信**~~ -- Claude <-> Codex <-> MiniMax 全部测通

### Phase 3：进行中
9. Dashboard 监控面板
10. 完全退役 tmux send-keys
11. 更多服务器接入

## 社区项目参考

- [oh-my-claudecode](https://github.com/yeachan-heo/oh-my-claudecode) -- 5+ 并行 Claude Code 实例 + Git worktree 隔离
- [Citadel](https://github.com/SethGammon/Citadel) -- 企业级 4 层路由 + `/do` 命令
- [claude-octopus](https://github.com/nyldn/claude-octopus) -- 8+ 模型提供商协调 + 共识门控
- [MCO](https://github.com/mco-org/mco) -- Multi-CLI Orchestrator 多模型并行审查

> [sleep2agi](https://github.com/sleep2agi) — 专注 AI Agents 编排、群体智能、视频生成，帮助普通人跨越到 AGI。

## License

MIT

# Agent Orchestra

> 开源的多 AI Agent Session 跨服务器编排方案。
> 源自 48+ 小时、4 台服务器、15+ 并发 Agent Session 的实战经验。
> **v0.4.0**: Streamable HTTP + SSE Push + Channel 插件 + REST API

---

## 这是什么？

一套经过实战验证的模式和工具，用于协调分布在多台服务器上的 AI 编程 Agent（Claude Code、Codex 等）。核心组件是 **CommHub Server**——一个基于 MCP Streamable HTTP 星型架构的跨服务器通信中枢。

## 快速开始

### 方式 A：MCP Tool 接入（最简单）

```bash
# 1. 部署 CommHub（5 分钟）
cd server && bun install && bun run start

# 2. 每个 Agent 加一行配置即可连上
# ~/.claude/settings.json
{ "mcpServers": { "commhub": { "url": "http://YOUR_IP:9200/mcp" } } }
```

### 方式 B：Channel 插件接入（实时推送）

```bash
# 1. 安装 Channel 插件
cd channel && bun install

# 2. 启动 Claude Code 并加载 Channel
COMMANDER_URL=http://YOUR_IP:9200 COMMANDER_SESSION=my-agent \
  claude --dangerously-skip-permissions \
         --dangerously-load-development-channels server:commhub
```

Channel 模式下，CommHub 通过 SSE 实时推送任务到 Agent 对话中，无需轮询。

详见 [`docs/quickstart.md`](docs/quickstart.md)，30 分钟完成全部部署。

## 架构

**MCP Streamable HTTP 星型拓扑**——一个 CommHub Server 居中，所有 Session 通过 Streamable HTTP 连接接入。

```
                    ┌─────────────────────────────────┐
                    │   CommHub Server v0.4.0    │
                    │   your-server:9200               │
                    │                                   │
                    │   POST /mcp    → Streamable HTTP  │
                    │   GET  /events → SSE Push         │
                    │   GET  /api    → REST              │
                    └──────────┬────────────────────────┘
                               │
          ┌────────┬───────┬───┴───┬───────┬────────┐
          │        │       │       │       │        │
       Claude   Claude  Claude  Codex   Codex   Claude
       Code #1  Code #2 Code #N  #1      #2     Code #M
       (MCP)    (MCP)   (Channel)(MCP)  (MCP)   (Channel)
       服务器A   服务器B  服务器C  服务器A  服务器B  服务器D
```

### 两种接入方式

| 方式 | 接口 | 延迟 | 适用场景 |
|------|------|------|---------|
| **MCP Tool** | `POST /mcp` | Agent 主动调用 | 简单部署，轮询 inbox |
| **Channel 插件** | `GET /events/:session` | 实时推送 <1s | 任务秒达，注入对话 |

### 核心设计决策

1. **星型拓扑** -- 30 个 Session = 30 条连接，不是 N^2 网状
2. **Streamable HTTP + SSE Push** -- MCP 用 Streamable HTTP，推送用 SSE 持久连接
3. **三接口** -- MCP Streamable HTTP + SSE Push + HTTP REST，各司其职
4. **跨模型通信** -- Claude Code ↔ Codex 通过 CommHub 中转，无需直连
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
| **7** | **CommHub MCP (Streamable HTTP + SSE Push)** | **支持** | **99%** | **v0.4.0 已上线** |

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

### Channel 插件模式（SSE 实时推送，v0.4.0 新增）

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
     │                            │  commhub_reply()     │
     │                            │◀───────────────────────│  Channel Tool 回报
     │                            │                        │
     │  get_completions()         │                        │
     │───────────────────────────▶│                        │
     │  ◀── [修 Bug 完成, 结果]    │                        │
```

Channel 模式优势：**任务从 Hub 发出到 Agent 看到 < 1 秒**，无需 Agent 轮询 inbox。

## 文档

- [`docs/quickstart.md`](docs/quickstart.md) -- **从这里开始**：部署 CommHub + 连接 30 个 Session，30 分钟搞定
- [`docs/protocol-decision.md`](docs/protocol-decision.md) -- 协议选型：为什么用 MCP（不用 A2A、不用 ACP）
- [`docs/architecture-decision.md`](docs/architecture-decision.md) -- 架构决策记录：MCP Streamable HTTP 星型拓扑
- [`docs/orchestration-guide.md`](docs/orchestration-guide.md) -- 全方案对比 + 成本分析
- [`docs/commhub-mcp-design.md`](docs/commhub-mcp-design.md) -- CommHub Server 详细设计
- [`docs/experience.md`](docs/experience.md) -- 48 小时实战报告：教训和原则

## CommHub Channel 插件

Channel 插件让 CommHub 任务直接注入 Claude Code 对话——无需轮询，任务秒达。

```
channel/
├── commhub-channel.ts   # Channel 插件主代码
├── package.json
└── .mcp.json              # 本地开发配置
```

### 安装

```bash
cd channel && bun install
```

### 启动

```bash
# 方式 1：使用 Claude Code 开发模式加载
COMMANDER_URL=http://YOUR_IP:9200 \
COMMANDER_SESSION=my-agent \
  claude --dangerously-skip-permissions \
         --dangerously-load-development-channels server:commhub

# 方式 2：使用 .mcp.json 配置
cp channel/.mcp.json ~/.claude/.mcp.json  # 编辑 URL 和 SESSION
```

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `COMMANDER_URL` | `http://127.0.0.1:9200` | CommHub Server 地址 |
| `COMMANDER_SESSION` | hostname | 本 Session 名称 |
| `COMMANDER_TOKEN` | (空) | 认证 Token（匹配服务端 `COMMANDER_AUTH_TOKEN`） |

### Channel Tools（2 个）

| 工具 | 用途 |
|------|------|
| `commhub_reply` | 回复 CommHub 任务（完成/进行中/阻塞/错误） |
| `commhub_report_status` | 更新 Session 状态（working/idle/blocked/error） |

## 落地路径

### Phase 1：今天就能做（已完成）
1. ~~Codex MCP Tool 做本地代码审查~~
2. ~~Agent Teams 做本地并行任务~~

### Phase 2：本周（已完成）
3. ~~**部署 CommHub Server**~~ -- v0.4.0 上线
4. ~~所有 Session 配上 MCP URL~~
5. ~~**CommHub Channel 插件**~~ -- SSE 实时推送已验证

### Phase 3：进行中
6. Dashboard 监控面板（`/admin/commhub`）
7. 完全退役 tmux send-keys
8. 跨服务器 Channel 连接验证

## 社区项目参考

- [oh-my-claudecode](https://github.com/yeachan-heo/oh-my-claudecode) -- 5+ 并行 Claude Code 实例 + Git worktree 隔离
- [Citadel](https://github.com/SethGammon/Citadel) -- 企业级 4 层路由 + `/do` 命令
- [claude-octopus](https://github.com/nyldn/claude-octopus) -- 8+ 模型提供商协调 + 共识门控
- [MCO](https://github.com/mco-org/mco) -- Multi-CLI Orchestrator 多模型并行审查

## License

MIT

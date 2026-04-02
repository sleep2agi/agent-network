# Agent Orchestra

> 开源的多 AI Agent Session 跨服务器编排方案。
> 源自 48+ 小时、4 台服务器、15+ 并发 Agent Session 的实战经验。

---

## 这是什么？

一套经过实战验证的模式和工具，用于协调分布在多台服务器上的 AI 编程 Agent（Claude Code、Codex 等）。核心组件是 **Commander MCP Server**——一个基于 MCP SSE 星型架构的跨服务器通信中枢。

## 快速开始

```bash
# 1. 部署 Commander（5 分钟）
cd server && bun install && bun run start

# 2. 每个 Agent 加一行配置即可连上
# ~/.claude/settings.json
{ "mcpServers": { "commander": { "url": "http://YOUR_IP:9200/sse" } } }
```

详见 [`docs/quickstart.md`](docs/quickstart.md)，30 分钟完成全部部署。

## 架构

**MCP SSE 星型拓扑**——一个 Commander Server 居中，所有 Session 通过持久 SSE 连接接入。

```
                    ┌────────────────────────────┐
                    │   Commander MCP Server      │
                    │   your-server:9200          │
                    │                              │
                    │   MCP SSE  +  HTTP REST     │
                    │   （双接口）                  │
                    └──────────┬───────────────────┘
                               │
          ┌────────┬───────┬───┴───┬───────┬────────┐
          │        │       │       │       │        │
       Claude   Claude  Claude  Codex   Codex   Claude
       Code #1  Code #2 Code #N  #1      #2     Code #M
       (服务器A) (服务器B) (服务器C) (服务器A) (服务器B) (服务器D)
```

### 核心设计决策

1. **星型拓扑** -- 30 个 Session = 30 条 SSE 连接，不是 N^2 网状
2. **SSE 而非轮询** -- 持久连接、实时推送、不浪费 Token
3. **双接口** -- MCP SSE 供 Claude Code/Codex 原生接入 + HTTP REST 供监控面板和脚本
4. **跨模型通信** -- Claude Code ↔ Codex 通过 Commander 中转，无需直连
5. **单服务器** -- 一个进程、一个 SQLite 数据库，运维简单

### 技术栈

| 组件 | 选型 |
|------|------|
| 运行时 | Bun 1.2+ |
| 语言 | TypeScript |
| MCP SDK | `@modelcontextprotocol/sdk` |
| 数据库 | SQLite (`bun:sqlite`, WAL 模式) |
| 传输 | MCP SSE + HTTP REST |
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
| **7** | **Commander MCP (SSE 星型)** | **支持** | **99%** | **已确认架构** |

## 核心发现

**MCP 调用比 tmux 高效 10 倍。** 一次 `mcp__codex__codex()` 调用 30 秒返回结构化结果。tmux 方式需要 3-5 分钟的 SSH + 窗口检测 + send-keys + capture-pane + ANSI 解析——而且经常失败。

**协议选型：纯 MCP。** Claude Code 和 Codex 原生支持 MCP，零适配成本。A2A（Google）和 ACP（IBM）解决的是 Agent 发现和编排，但我们的 30 个 Session 都是自己的、地址已知，不需要"发现"机制。详见 [`docs/protocol-decision.md`](docs/protocol-decision.md)。

## Commander MCP 工具（9 个）

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

```
Hub (指挥室)                  Commander              Agent (子 Session)
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
     │                            │  (Agent 执行任务...)    │
     │                            │                        │
     │                            │  report_completion()   │
     │                            │◀───────────────────────│
     │                            │                        │
     │  get_completions()         │                        │
     │───────────────────────────▶│                        │
     │  ◀── [修 Bug 完成, 结果]    │                        │
```

## 文档

- [`docs/quickstart.md`](docs/quickstart.md) -- **从这里开始**：部署 Commander + 连接 30 个 Session，30 分钟搞定
- [`docs/protocol-decision.md`](docs/protocol-decision.md) -- 协议选型：为什么用 MCP（不用 A2A、不用 ACP）
- [`docs/architecture-decision.md`](docs/architecture-decision.md) -- 架构决策记录：MCP SSE 星型拓扑
- [`docs/orchestration-guide.md`](docs/orchestration-guide.md) -- 全方案对比 + 成本分析
- [`docs/commander-mcp-design.md`](docs/commander-mcp-design.md) -- Commander MCP Server 详细设计
- [`docs/experience.md`](docs/experience.md) -- 48 小时实战报告：教训和原则

## 落地路径

### Phase 1：今天就能做
1. Codex MCP Tool 做本地代码审查
2. Agent Teams 做本地并行任务

### Phase 2：本周
3. **部署 Commander MCP Server MVP** -- `cd server && bun install && bun run start`
4. 所有 Session 在 `settings.json` / `config.json` 配上 URL

### Phase 3：下周
5. HTTP REST 监控面板
6. 完全退役 tmux send-keys

## 社区项目参考

- [oh-my-claudecode](https://github.com/yeachan-heo/oh-my-claudecode) -- 5+ 并行 Claude Code 实例 + Git worktree 隔离
- [Citadel](https://github.com/SethGammon/Citadel) -- 企业级 4 层路由 + `/do` 命令
- [claude-octopus](https://github.com/nyldn/claude-octopus) -- 8+ 模型提供商协调 + 共识门控
- [MCO](https://github.com/mco-org/mco) -- Multi-CLI Orchestrator 多模型并行审查

## License

MIT

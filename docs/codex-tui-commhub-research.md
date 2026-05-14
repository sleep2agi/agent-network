# Codex TUI 接入 commhub — 基础消息收发可行性调研

| 字段 | 值 |
|------|----|
| **类型** | 调研报告（feasibility research） |
| **作者** | 通信SDK马 |
| **状态** | Draft v1（进行中） |
| **创建日期** | 2026-05-14 |
| **关联 issue** | [#97](https://github.com/sleep2agi/agent-network/issues/97) |
| **关联历史** | RFC-005 / RFC-006 / RFC-007（codex runtime 接入 6 轮 pivot） |
| **上游** | [codex #21551](https://github.com/openai/codex/issues/21551)（CLOSED）· [discussion #21558](https://github.com/openai/codex/discussions/21558) |
| **审阅** | 通信龙（review）· Vincent（要确定答案） |

---

## 摘要

Vincent 4594 想把 Codex 交互式 TUI 接入 anet commhub mesh —— 在 codex TUI 里干活的同时，这个实例能收发 commhub 消息（类似 claude-code-cli runtime：Claude Code 交互界面 + commhub 接入并存）。

本报告回答 issue #97 的 5 个问题，给出确定的可行性判断。**核心结论（v1 初判，§2-§4 详证）**：基础的 **send 完全可行**、**receive 可行但是 pull 不是 push** —— 通过 codex 已有的 `codex mcp add` 外部 MCP server 机制，anet commhub 的 MCP 端点可直接挂进 codex TUI。这**不是**重开被 falsify 的 Path B（live token co-presence），是更基础、且 codex 原生已支持的一层。

本报告仅调研，不实施（per /loop directive + 通信龙 边界）。

---

## §1 上游 context + codex CLI 入口面 + 5 问 framing

### 1.1 上游 #21551 — CLOSED，关键架构约束已明确

issue #97 的 blocker 引用是上游 [codex #21551](https://github.com/openai/codex/issues/21551)「App Server: peer-client co-presence with the live TUI thread」。**调研第一手发现：该 issue 已 CLOSED**（2026-05-07，OpenAI 维护者 etraut-openai 关闭）。

关闭理由与关键架构表态（etraut-openai 原文）：

> "There is a current assumption that **only one client will interact with a thread at a time**. ... each client starts a new instance of the app server, and these instances currently don't talk to each other."

→ 维护者把它当 "question rather than feature request" 关闭，后续讨论移到 [discussion #21558](https://github.com/openai/codex/discussions/21558)。

社区提交者（parkertoddbrooks）的 fork 做法：把单个 App Server 实例改成 multi-listener，broadcast 给 N 个 peer client —— **但这是 fork，不是上游**。

**对 #97 的意义**：
- ❌ **Path B（co-presence / 多 client 实时围观 live token）仍然 blocked** —— 上游 "one active client per thread" 假设没变，multi-listener 只在社区 fork。RFC-006/Path B falsified 状态成立。
- ✅ **但 #97 问的不是 Path B** —— #97 问的是「基础 send/receive」，不需要多 client 共享同一个 live thread。这是不同的 bar，下面 §1.2 的 codex CLI 入口面给出了原生答案。

### 1.2 codex CLI 入口面 —— `codex mcp` 是关键

实测 `codex --help`（codex CLI 0.130.0），subcommand 面：

| Subcommand | 作用 | 与 #97 关系 |
|-----------|------|------------|
| `codex`（无 subcommand） | 交互式 TUI | #97 的目标载体 |
| **`codex mcp`** | **管理 Codex 的外部 MCP servers** | **★ #97 的关键机制** |
| `codex mcp-server` | 把 Codex 作为 MCP server（stdio）启动 | Path C（RFC-007 final） |
| `codex app-server` | [experimental] 运行 app server | #21551 的层，co-presence 相关 |
| `codex remote-control` | [experimental] headless app-server + remote control | Path B territory |
| `codex exec` | 非交互执行 | codex-sdk 包装的底层 |
| `codex resume` / `fork` | 恢复/分叉历史 session | session 连续性 |

**关键发现**：`codex mcp` = "Manage external MCP servers for Codex"。codex **原生支持加载外部 MCP server**，且实测 `codex mcp add`：

```
codex mcp add <NAME> (--url <URL> | -- <COMMAND>...)
  --url <URL>    streamable HTTP server
  -- <COMMAND>   stdio server
  --env <K=V>    stdio server 的环境变量
```

即：codex 可以挂 stdio MCP server **或** streamable HTTP MCP server。这个配置写进 `~/.codex/config.toml` 的 `mcp_servers`，对所有 codex 模式生效 —— **包括交互式 TUI**。

**这正是 anet commhub 接入 codex TUI 的原生通道**：anet commhub server 已经暴露 MCP 端点（`POST /mcp` streamable HTTP，见 `server/CLAUDE.md`）。理论上 `codex mcp add anet-commhub --url <commhub>/mcp` 就能让 codex TUI 拿到 `commhub_send_task` / `commhub_get_inbox` 等工具。§2 详证。

### 1.3 与 claude-code-cli runtime 的类比

Vincent 的诉求明说「类似 claude-code-cli runtime」。claude-code-cli 是怎么接 commhub 的？—— Claude Code 通过 MCP 加载 commhub server，得到 `commhub_*` 工具（见本仓 `CLAUDE.md`：commhub_send_task / commhub_reply / commhub_report_status 都是 MCP 工具）。

**codex TUI 接 commhub 的对应物就是 `codex mcp add`**。机制同构：
- claude-code-cli：Claude Code + commhub MCP server → `commhub_*` 工具
- codex TUI（本 issue）：codex TUI + commhub MCP server（via `codex mcp add`）→ `commhub_*` 工具

差异点在 receive 的 push vs pull（§3 详）—— claude-code-cli runtime 有 SSE push 旁路（anet-node 监听 SSE 注入），codex TUI 纯 MCP 工具调用是 pull。

### 1.4 5 个待回答问题 framing

| # | 问题 | v1 初判 | 详证章节 |
|---|------|---------|---------|
| Q1 | TUI 能否**收到** commhub 消息 | 🟡 可行但 pull（MCP 工具 poll，无 push 注入） | §2 + §3 |
| Q2 | TUI 能否**主动发** commhub 消息 | ✅ 可行（MCP 工具 `commhub_send_task`） | §2 |
| Q3 | 可行 → UX 什么样 | MCP 工具调用 + 可选 sidecar 提示 | §3 |
| Q4 | 不可行 → 卡在哪 | push 注入是真限制（非 blocker，是 UX 降级） | §3 + §4 |
| Q5 | 与 Path C（mcp-server stdio）共存/复用 | ✅ 正交且互补（同一个 commhub MCP server） | §3 |

### 1.5 §1 小结

上游 #21551 已 CLOSED，"one client per thread" 架构约束确认 → Path B（co-presence）仍 blocked。但 #97 问的基础 send/receive 不需要 Path B —— codex CLI 原生的 `codex mcp add` 外部 MCP server 机制（stdio + streamable HTTP 都支持）是现成通道，anet commhub 已有 MCP 端点。机制与 claude-code-cli runtime 同构。核心待验证点是 receive 的 push vs pull 差异。

§2 详证 Q1/Q2（`codex mcp add` 机制 + 本地实测）；§3 详证 Q3/Q4/Q5；§4 给可行性判断 + 实施方案。

---

## §2 Q1/Q2 — TUI 收发可行性

> 🚧 待 R524+ /loop tick 推进（含本地实测）

---

## §3 Q3 UX + Q4 限制 + Q5 与 Path C 共存

> 🚧 待 R525+ /loop tick 推进

---

## §4 可行性判断 + 实施方案 / 替代路径

> 🚧 待 R526+ /loop tick 推进

---

## 附录

### A. 关联

- [issue #97](https://github.com/sleep2agi/agent-network/issues/97)
- [codex #21551](https://github.com/openai/codex/issues/21551)（CLOSED）
- [codex discussion #21558](https://github.com/openai/codex/discussions/21558)
- RFC-005 / RFC-006 / RFC-007（`docs/rfcs/`）

### B. 变更记录

| 版本 | 日期 | 作者 | 说明 |
|------|------|------|------|
| Draft v1 §1 | 2026-05-14 | 通信SDK马 | §1 上游 context（#21551 CLOSED）+ codex CLI 入口面（`codex mcp add` 发现）+ 5 问 framing，§2-§4 待续 |

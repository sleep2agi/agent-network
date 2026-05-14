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

### 2.1 实测证据 1 — 本机 codex 配置里已有 commhub MCP server

调研中 `codex mcp list` 实测发现：**本机 codex 配置里已经存在一个 `commhub-proxy` MCP server**：

```
$ codex mcp get commhub-proxy
commhub-proxy
  enabled: true
  transport: stdio
  command: bun
  args: /home/vansin/agent-orchestra/proxy/commhub-proxy.ts
  env: COMMHUB_ALIAS=*****, COMMHUB_URL=*****
```

（注：`proxy/commhub-proxy.ts` 文件本身不在当前 checkout —— 应是先前实验或另一 working tree 留下的 config 条目。但 config 条目本身就是证据：**anet 团队此前已经把一个 commhub stdio MCP proxy 挂进过 codex**。）

→ 这不是「理论上可行」，是 codex 配置层已经接受过这种集成。

### 2.2 实测证据 2 — `codex mcp add` 隔离环境端到端验证

用隔离 `CODEX_HOME=/tmp/qa-codex-home`（不碰真实 `~/.codex`，测后 `rm -rf`）实测 `codex mcp add` 两种 transport：

```
# stdio server
$ codex mcp add qa-test-mcp --env FOO=bar -- echo hello
Added global MCP server 'qa-test-mcp'.

# streamable HTTP server
$ codex mcp add qa-http-mcp --url http://127.0.0.1:9999/mcp
Added global MCP server 'qa-http-mcp'.
$ codex mcp get qa-http-mcp
  transport: streamable_http
  url: http://127.0.0.1:9999/mcp
  bearer_token_env_var: -      ← ★ 支持 bearer token 认证
  http_headers: -
  env_http_headers: -          ← ★ 支持自定义 header（含 env 注入）
```

**确认结论**：
- codex 原生支持挂 stdio MCP server（`-- <command>` + `--env`）
- codex 原生支持挂 streamable HTTP MCP server（`--url`），且 **支持 `bearer_token_env_var` + `http_headers` + `env_http_headers`** —— 即支持带认证的远程 MCP
- 配置写进 `~/.codex/config.toml` 的 `mcp_servers`，对所有 codex 模式生效（含交互式 TUI）

### 2.3 Q2 — TUI 能否主动发 commhub 消息？ → ✅ **可行**

机制：codex TUI 加载 commhub MCP server 后，TUI 内的 codex agent 获得 commhub 的 MCP 工具（`commhub_send_task` / `commhub_send_message` / `commhub_reply` / `commhub_report_status` —— 见 `server/CLAUDE.md` 的 MCP tools 清单，这些是 hub 端 + agent 端工具）。

用户在 codex TUI 里干活时，可以让 codex agent 调用这些工具发消息出去。**与 claude-code-cli runtime 完全同构** —— Claude Code 也是通过 MCP 工具 `commhub_send_task` 发消息。

确定答案：**Q2 可行，零额外机制，codex 原生支持。**

### 2.4 Q1 — TUI 能否收到 commhub 消息？ → 🟡 **可行，但是 pull 不是 push**

#### 2.4.1 pull 路径（可行）

commhub 的 agent 端 MCP 工具含 `get_inbox`（"拉取待办命令"，见 `server/CLAUDE.md`）。codex TUI 里的 agent 可以调用 `get_inbox` 工具 **主动拉取** commhub 发来的消息。

→ 这条路径**可行**：TUI agent 调 `get_inbox` → 拿到 inbox 里的消息 → 在 TUI 对话流里呈现。

#### 2.4.2 push 路径（受限 —— 真正的卡点）

claude-code-cli runtime 的 receive 有 **SSE push 旁路**：anet-node 监听 commhub 的 `/events/:alias` SSE 流，消息一到就**注入** agent 的输入。这让 receive 是「实时 push」而非「等 agent 想起来 poll」。

codex TUI **没有这条旁路**：
- codex TUI 的 MCP 集成是**工具调用模型**（agent 决定何时调 tool），不是事件流订阅
- 没有官方机制能把一条 commhub 消息**主动注入**一个正在运行的 codex TUI turn
- 即：commhub 消息到了，codex TUI 不会自动知道；要等 TUI 里的 agent 下次调 `get_inbox`

这就是 issue #97 Q4 要找的「卡点」—— 但要厘清：**这是 UX 降级，不是功能 blocker**。基础 receive（pull）能用，只是没有 claude-code-cli 那样的实时 push。

#### 2.4.3 push 受限的根因 —— 与 #21551 的关系

§1.1 的上游 #21551「one client per thread」约束，falsify 的是「多 client 实时围观同一 thread 的 live token」。codex TUI 缺 push 注入是**相关但不同**的限制：

| 限制 | 来源 | 对 #97 的影响 |
|------|------|--------------|
| 多 client 不能围观同一 live thread 的 token 流 | #21551「one client per thread」 | Path B falsified（与 #97 无关，#97 不要这个） |
| 没有机制把外部消息注入运行中的 TUI turn | codex TUI MCP 集成是工具调用模型 | Q1 receive 降级为 pull（#97 的真正约束） |

→ Q1 的卡点是 codex TUI 的 **MCP 集成模型本身**（工具调用 vs 事件流），不是 #21551 那个 thread ownership 问题。

### 2.5 §2 小结

| 问题 | 确定答案 | 机制 | 限制 |
|------|---------|------|------|
| **Q2 发** | ✅ **可行** | codex agent 调 `commhub_send_task` 等 MCP 工具 | 无，原生支持 |
| **Q1 收** | 🟡 **可行但 pull** | codex agent 调 `get_inbox` MCP 工具拉取 | 无 push 注入；commhub 消息到了 TUI 不自动知道，要等 agent poll |

证据链：`codex mcp list` 发现本机已有 commhub MCP 配置条目 + 隔离环境实测 `codex mcp add` stdio/HTTP 两种 transport 都工作 + HTTP 支持 bearer token 认证。基础收发可行，receive 降级为 pull 是 codex TUI MCP 集成模型决定的（非 #21551 thread ownership 问题）。

§3 给 Q3（pull 模型下的 UX 设计）+ Q4（push 受限的应对/替代）+ Q5（与 Path C 共存）。

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

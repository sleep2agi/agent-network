# Codex 指挥室方案：Claude Code 备用中控

> 日期: 2026-04-03
> 背景: Claude Code 有 token 限额，用完即停。需要 Codex 作为备用指挥室。
> 状态: 方案设计

---

## 1. 可行性分析

### 1.1 Codex 能不能接 Telegram？

**不能直接用 Claude Code 的 Telegram Channel 插件。** 原因：
- Telegram 插件（`claude-channel-telegram`）是 Claude Code Channel 插件，依赖 `notifications/claude/channel` 协议
- Codex 不支持 Channel 协议
- 插件用 `grammy` 库（Telegram Bot API），是 Claude Code 专有的集成

**替代方案：**

| 方案 | 可行性 | 工作量 |
|------|--------|--------|
| A. CommHub 中转 | **推荐** | 零代码 |
| B. Telegram MCP Server | 可行 | 1 天 |
| C. Telegram Bot HTTP 轮询 | 可行 | 半天 |

**方案 A（CommHub 中转）**：Claude Code 的 Telegram Channel 收到消息 → 通过 CommHub `send_task` 转发给 Codex 指挥室 → Codex 处理后通过 CommHub 回复。不需要 Codex 直连 Telegram。

**方案 B（Telegram MCP Server）**：把 Telegram 插件改造成独立 MCP Server（stdio），Codex 通过 `codex mcp add` 加载。核心改动：去掉 Channel 依赖，用 MCP Tool 暴露 `get_messages`（长轮询）+ `send_message`。

### 1.2 Codex 能不能调 CommHub MCP Tools？

**能。已验证。**

硅谷 Codex (codex-硅谷) 通过 commhub-proxy 成功：
- `get_task` → 长轮询收到 4 条任务
- `report_result` → 4 条全部回报成功
- `send_message` → 给指挥室发消息成功
- `get_status` → 查看全局状态成功

Paper Codex (P站姐) 通过 MCP http 直连：
- `report_status` → 注册成功
- `get_inbox` → 收到任务
- `send_task` → 给指挥室发消息成功

### 1.3 Codex 能不能调其他 MCP？

**能。** Codex 原生支持 MCP，两种方式：
- `codex mcp add name --url http://...` — HTTP MCP Server
- `codex mcp add name -- command args` — stdio MCP Server

已验证的 MCP 接入：
- commhub-proxy（stdio）：长轮询 CommHub
- commhub（HTTP）：直连 CommHub Server
- codex_apps（内置）：Codex 自带的 MCP

---

## 2. Codex 指挥室完整方案

### 2.1 架构

```
Vincent (Telegram)
     │
     ▼
Claude Code (Telegram Channel)  ←── 主指挥室（token 充足时）
     │
     │  token 用完 → 切换
     ▼
CommHub Server (:9200)
     │
     ▼
Codex 指挥室 (GPT-5.4)  ←── 备用指挥室
     │
     ├── send_task → 各 Agent session
     ├── get_all_status → 全局监控
     ├── get_completions → 查看完成记录
     └── broadcast → 群发通知
```

### 2.2 Codex 指挥室的 MCP 配置

```bash
# CommHub 直连（查看状态、派任务、收结果）
codex mcp add commhub --url http://127.0.0.1:9200/mcp

# CommHub Proxy（长轮询接收任务，用于被其他 session 调度）
codex mcp add commhub-proxy \
  --env COMMHUB_URL=http://127.0.0.1:9200 \
  --env COMMHUB_ALIAS=codex-指挥室 \
  -- bun /path/to/agent-orchestra/proxy/commhub-proxy.ts
```

### 2.3 启动命令

```bash
codex --dangerously-bypass-approvals-and-sandbox \
  "You are the CommHub Commander (codex-指挥室). Your job:

1. Call commhub.report_status(resume_id='codex-cmd', alias='codex-指挥室', status='idle', agent='codex', server='硅谷') to register.
2. Call commhub.get_all_status() to see all sessions.
3. LOOP FOREVER:
   a. Call commhub-proxy.get_task(wait=true, timeout_ms=60000) to wait for instructions.
   b. When you receive a task:
      - If it's a dispatch order: call commhub.send_task(alias=target, task=content)
      - If it's a status query: call commhub.get_all_status() and report back
      - If it's a completion query: call commhub.get_completions()
   c. After handling, call commhub-proxy.report_result(task_id, result)
   d. Loop back to step 3a.
4. NEVER STOP polling."
```

### 2.4 Codex 指挥室能做什么

| 功能 | 方法 | 状态 |
|------|------|------|
| 查看全局状态 | `commhub.get_all_status()` | ✅ 已验证 |
| 给 Agent 派任务 | `commhub.send_task(alias, task)` | ✅ 已验证 |
| 群发通知 | `commhub.broadcast(message)` | ✅ 可用 |
| 查看完成记录 | `commhub.get_completions()` | ✅ 可用 |
| 查看单 session | `commhub.get_session_status(alias)` | ✅ 可用 |
| 接收其他 session 消息 | `commhub-proxy.get_task(wait=true)` | ✅ 已验证 |
| 回复消息 | `commhub-proxy.report_result()` | ✅ 已验证 |
| 转发给 Vincent | `commhub.send_task(alias="通信哥", task="转发给 Telegram: ...")` | ✅ 间接 |
| 接 Telegram | 通过 CommHub 中转 | ⚠️ 需要 Claude Code 存活转发 |
| 代码审查 | `codex` 自身能力 | ✅ 原生 |
| 执行 Shell 命令 | `--dangerously-bypass-approvals-and-sandbox` | ✅ 原生 |

---

## 3. 与 Claude Code 指挥室的对比

| 维度 | Claude Code 指挥室 | Codex 指挥室 |
|------|-------------------|-------------|
| **模型** | Claude Opus 4.6 (1M context) | GPT-5.4 xhigh (1.5M context) |
| **推理质量** | 最强 | 强（代码域优秀） |
| **token 限额** | 有限（Max plan 额度） | 有限（Pro plan 额度） |
| **Telegram** | Channel 直连 | 通过 CommHub 中转 |
| **CommHub** | Channel (SSE push) | MCP http + Proxy (长轮询) |
| **延迟** | < 1s (SSE push) | 0-60s (长轮询) |
| **自循环** | 不自带，需 Channel push | 不自带，需 prompt 驱动 |
| **MCP 支持** | 完整 | 完整 |
| **代码审查** | 通过 Codex Plugin | 原生能力 |
| **多模型调度** | ✅ CommHub 路由 | ✅ CommHub 路由 |
| **工具审批** | 自动（bypass permissions） | 自动（bypass approvals） |
| **Channel 支持** | ✅ 原生 | ❌ 不支持 |
| **Plugin 生态** | Telegram/WeChat/Feishu | 无（只有 MCP） |

### 关键差异

1. **Telegram 接入**：Claude Code 直连，Codex 需中转
2. **任务推送延迟**：Claude Code SSE 秒达，Codex 轮询最长 60s
3. **模型特长**：Claude Opus 全面强，GPT-5.4 代码域优秀
4. **Context Window**：GPT-5.4 有 1.5M，Claude Opus 有 1M

---

## 4. 切换方案

### 4.1 自动切换（推荐）

```
Claude Code 指挥室
     │
     │  检测到 token 接近限额
     │  或 API 返回 rate limit error
     ▼
通过 CommHub send_task 给 codex-指挥室：
  "接管指挥室工作。当前状态：[get_all_status 结果]。
   待办任务：[pending tasks]。Vincent 在 Telegram 等回复。"
     │
     ▼
Codex 指挥室接管
     │
     │  定期 get_all_status 巡查
     │  收到 Vincent 通过 CommHub 转发的消息
     │  派任务给各 Agent
     ▼
Claude Code token 恢复后
     │
     ▼
Codex 指挥室 send_task 给 Claude Code：
  "token 恢复，交还指挥权。当前状态：[summary]"
```

### 4.2 手动切换（简单）

```bash
# Step 1: Claude Code token 用完，在硅谷服务器手动启动 Codex 指挥室
tmux new -s codex-commander
source ~/.nvm/nvm.sh && nvm use 20
codex --dangerously-bypass-approvals-and-sandbox "你是 codex-指挥室..."

# Step 2: 通过 CommHub 派任务
# Codex 自动 get_task 接收，然后 send_task 给各 Agent

# Step 3: Claude Code token 恢复后，Ctrl-C 关掉 Codex 指挥室
```

### 4.3 一键切换脚本

```bash
#!/bin/bash
# switch-commander.sh — 切换到 Codex 指挥室

export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
nvm use 20

# 获取当前状态快照
STATUS=$(curl -s http://127.0.0.1:9200/api/status)

tmux new-session -d -s codex-commander "codex --dangerously-bypass-approvals-and-sandbox \
  'You are codex-指挥室, backup commander. Current fleet status: $STATUS. \
  Register with CommHub, then LOOP: get_task → execute → report_result. NEVER STOP.'"

echo "Codex commander started in tmux:codex-commander"
```

---

## 5. Telegram 中转方案详解

### 5.1 架构

```
Vincent (Telegram)
     │
     ▼
Claude Code (Telegram Channel) ─── 存活时直接处理
     │
     │  token 用完 → 只做转发
     ▼
CommHub send_task("codex-指挥室", "Telegram消息: ...")
     │
     ▼
Codex 指挥室
     │  处理完
     ▼
CommHub send_task("通信哥", "回复 Telegram: ...")
     │
     ▼
Claude Code (通信哥) → Telegram reply
```

### 5.2 Claude Code 最低功耗模式

当 Claude Code token 接近限额时，切换到"转发模式"——只做 Telegram ↔ CommHub 消息转发，不做复杂推理：

```
收到 Telegram 消息 → send_task("codex-指挥室", message) → 等 Codex 回复 → Telegram reply
```

这样 Claude Code 每次只消耗极少 token（转发操作），把重活交给 Codex。

---

## 6. 风险和缓解

| 风险 | 缓解 |
|------|------|
| Codex token 也用完 | 预留 Codex token 只用于指挥，不做执行 |
| 长轮询延迟 60s | 紧急任务走 CommHub broadcast |
| Codex 不自循环 | prompt 中强调 NEVER STOP + 长超时 |
| Telegram 中转断链 | 通信哥 Channel 独立于指挥室，存活概率高 |
| GPT-5.4 推理偏差 | 关键决策加 verification step |

---

## 7. 实施清单

- [ ] 在硅谷准备 Codex 指挥室 tmux session
- [ ] 配好 commhub + commhub-proxy 双 MCP
- [ ] 写 switch-commander.sh 一键切换脚本
- [ ] 在 Claude Code 指挥室的 CLAUDE.md 加"低 token 时切换"规则
- [ ] 测试完整切换流程：Claude Code → Codex → Claude Code
- [ ] 测试 Telegram 中转：Vincent → Claude Code → CommHub → Codex → CommHub → Claude Code → Telegram

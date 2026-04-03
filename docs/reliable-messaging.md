# 可靠收消息方案

> 日期: 2026-04-03
> 核心问题: MiniMax/Codex 无法可靠收消息（不自循环、token 耗尽、轮询不稳定）

---

## 1. 问题根因

| Session 类型 | 收消息方式 | 问题 |
|-------------|-----------|------|
| Claude Code (Channel) | SSE push，秒达 | ✅ 可靠，但仅限 Anthropic 官方 API |
| MiniMax (MCP http) | AI 主动调 get_inbox | ❌ MiniMax 不自循环，执行完一轮就停 |
| Codex (commhub-proxy) | AI 调 get_task 长轮询 | ❌ Codex 轮询消耗 token，context 满就停 |
| Codex (MCP http) | AI 主动调 get_inbox | ❌ 同 MiniMax |

**根本原因：让 AI 负责轮询本身就不可靠。** AI 的 context 会满、token 会用完、模型会忘记继续轮询、长轮询消耗 API 调用。

---

## 2. 解决方案：外部守护脚本 (Poller Daemon)

### 2.1 核心思路

**不让 AI 轮询。** 用一个 shell 脚本在 AI 外部运行，定期查 CommHub inbox，有消息时通过 `tmux send-keys` 推给 AI。

```
                    CommHub Server
                         │
                         │ get_inbox (每 10s)
                         ▼
                 commhub-poller.sh  ← 外部守护脚本
                         │
                         │ tmux send-keys
                         ▼
                   tmux session
                    (AI Agent)
```

### 2.2 优势

| 方案 | AI token 消耗 | 可靠性 | 实时性 |
|------|-------------|--------|--------|
| AI 自己轮询 | 高（每次 poll = 1 API call） | 低 | 0-60s |
| commhub-proxy 长轮询 | 中（25s 一次） | 中 | 0-25s |
| **Poller daemon** | **零** | **高** | **0-10s** |
| Channel SSE | 零 | 最高 | < 1s |

### 2.3 使用方式

```bash
# MiniMax 96GB
nohup ./poller/commhub-poller.sh \
  --alias minimax-96g \
  --tmux minimax-cc \
  --interval 10 \
  --url http://YOUR_COMMHUB_IP:9200 \
  > /tmp/poller-minimax.log 2>&1 &

# Codex 硅谷
nohup ./poller/commhub-poller.sh \
  --alias codex-硅谷 \
  --tmux codex-hub \
  --interval 15 \
  > /tmp/poller-codex.log 2>&1 &

# Paper Codex
nohup ./poller/commhub-poller.sh \
  --alias P站姐 \
  --tmux codex-paper \
  --interval 10 \
  --url http://YOUR_COMMHUB_IP:9200 \
  > /tmp/poller-paper.log 2>&1 &
```

### 2.4 工作流程

```
1. Poller 每 10 秒调 CommHub get_inbox(alias=xxx)
2. 如果有消息:
   a. ACK 消息 (ack_inbox)
   b. tmux send-keys 推给 AI: "CommHub 任务 [from: 指挥室, id: xxx]: 任务内容"
   c. AI 在对话中看到消息，自然处理
3. 如果没有消息: sleep 10 秒继续
4. 如果连续失败: 指数退避 (最长 60s)
5. 如果 tmux session 消失: 等待恢复
```

---

## 3. 四种收消息方式完整对比

| 维度 | Channel (SSE) | Proxy (长轮询) | AI 轮询 | **Poller Daemon** |
|------|--------------|---------------|---------|-------------------|
| 适用 | Claude Code + Anthropic API | Codex (stdio MCP) | 任何 MCP http | **任何 tmux session** |
| 实时性 | < 1s | 0-25s | 0-60s | **0-10s (可配)** |
| AI token 消耗 | 零 | 中 | 高 | **零** |
| 可靠性 | 最高 | 中（AI 可能停） | 低 | **高** |
| 依赖 | Channel 协议 | commhub-proxy MCP | MCP http | **仅 curl + tmux** |
| 第三方模型 | ❌ | ❌ (Codex only) | ✅ | **✅** |
| 部署 | .mcp.json + Channel | codex mcp add | settings.json | **nohup 一行命令** |

---

## 4. 推荐配置

### Claude Code (Anthropic API)
→ 用 **Channel (SSE)**，最优方案

### MiniMax / Qwen (第三方 API)
→ 用 **Poller Daemon + MCP http**
- MCP http 给 AI 提供 CommHub tools (send_task/report_status)
- Poller daemon 负责推消息到 tmux

### Codex
→ 用 **Poller Daemon**（替代 commhub-proxy 长轮询）
- Poller 不消耗 Codex token
- Codex MCP http 直连 CommHub 用于发消息
- 或保留 commhub-proxy 作为备选

---

## 5. /loop 的可靠性

Claude Code 的 `/loop` skill 可以定期执行命令。但：

| 维度 | /loop | Poller Daemon |
|------|-------|---------------|
| 运行位置 | Claude Code 对话内 | 外部 shell |
| token 消耗 | 每次循环消耗 | 零 |
| context 满了 | 停止 | 不影响 |
| Claude Code 退出 | 停止 | 不影响 |
| 第三方模型 | 不可用 | 可用 |
| 配置 | `/loop 10s /check-inbox` | nohup 一行 |

**结论：Poller Daemon 比 /loop 更可靠。** /loop 受限于 Claude Code session 生命周期。

---

## 6. 架构总结

```
                    ┌──────────────────────────────────┐
                    │     CommHub Server (:9200)         │
                    └──────────┬─────────────────────────┘
                               │
          ┌────────────────────┼────────────────────────┐
          │                    │                        │
     SSE Push            HTTP get_inbox            HTTP get_inbox
     (Channel)           (Poller daemon)           (Poller daemon)
          │                    │                        │
          ▼                    ▼                        ▼
     Claude Code        poller.sh              poller.sh
     (直接注入对话)      (tmux send-keys)       (tmux send-keys)
                               │                        │
                               ▼                        ▼
                          MiniMax               Codex / P站姐
                        (tmux:minimax-cc)      (tmux:codex-hub)
```

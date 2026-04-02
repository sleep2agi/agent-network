# 快速开始：今天就跑起来

> 从零到 30 个 Session 全部连上 Commander，30 分钟搞定。
> 两种接入方式：**MCP Tool**（简单）或 **Channel 插件**（实时推送）。

---

## 第一步：部署 Commander Server（5 分钟）

在你的中心服务器上：

```bash
# 克隆仓库
git clone https://github.com/sleep2agi/agent-orchestra.git
cd agent-orchestra/server

# 安装依赖（需要 Bun 1.2+）
bun install

# 启动
bun run start
# 输出：Commander MCP Server v0.4.0
#        Transport: Streamable HTTP (Bun native)
```

验证：
```bash
curl http://localhost:9200/health
# {"ok":true,"version":"0.4.0","transport":"streamable-http","sessions":0,"sse_connections":0}
```

### 用 systemd 持久化（可选）

```bash
cat > /etc/systemd/system/commander.service << 'EOF'
[Unit]
Description=Commander MCP Server
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/agent-orchestra/server
ExecStart=/path/to/bun run src/index.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl enable --now commander
```

### 防火墙

```bash
# 只允许你的 Agent 服务器访问
iptables -A INPUT -p tcp --dport 9200 -s YOUR_SERVER_1_IP -j ACCEPT
iptables -A INPUT -p tcp --dport 9200 -s YOUR_SERVER_2_IP -j ACCEPT
iptables -A INPUT -p tcp --dport 9200 -j DROP
```

---

## 第二步：连接 Claude Code Session（2 分钟/个）

在每台服务器的 `~/.claude/settings.json` 中加入：

```json
{
  "mcpServers": {
    "commander": {
      "url": "http://YOUR_COMMANDER_IP:9200/mcp"
    }
  }
}
```

重启 Claude Code Session，Commander 的 9 个 Tool 自动可用。

### 验证连接

在 Claude Code 中执行：
```
调用 report_status，session_name 设为 "test"，status 设为 "idle"
```

在 Commander 服务器上检查：
```bash
curl http://localhost:9200/api/status
# 应该看到 test session
```

---

## 第三步：连接 Codex Session（同上）

Codex 的 MCP 配置方式相同。在 `config.json` 中加入：

```json
{
  "mcpServers": {
    "commander": {
      "url": "http://YOUR_COMMANDER_IP:9200/mcp"
    }
  }
}
```

---

## 第三步 B：Channel 插件接入（可选，实时推送）

> Channel 模式下，Commander 任务通过 SSE 实时注入 Claude Code 对话，无需 Agent 轮询 inbox。

```bash
# 安装 Channel 依赖
cd agent-orchestra/channel
bun install

# 启动 Claude Code + Channel
COMMANDER_URL=http://YOUR_COMMANDER_IP:9200 \
COMMANDER_SESSION=my-agent \
COMMANDER_TOKEN=your-secret-token \
  claude --dangerously-skip-permissions \
         --dangerously-load-development-channels server:commander
```

验证：
```bash
# 在另一个终端通过 REST 发送任务
curl -X POST http://YOUR_COMMANDER_IP:9200/api/task \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-secret-token" \
  -d '{"session_name":"my-agent","task":"报告当前状态","priority":"normal"}'

# Agent 对话中应该立即收到 <channel source="commander" ...> 消息
```

### MCP Tool vs Channel 怎么选？

| 维度 | MCP Tool | Channel 插件 |
|------|----------|-------------|
| 部署 | 只需配 URL | 需要安装 Channel |
| 任务接收 | Agent 调 `report_status`→发现→`get_inbox` | SSE 秒推到对话 |
| 延迟 | 取决于轮询频率 | < 1 秒 |
| 适用 | 简单场景、Codex | 需要快速响应的 Agent |

---

## 第四步：写入 CLAUDE.md 通信规则

在每个项目的 CLAUDE.md 中加入：

```markdown
## Commander 通信规则

你已连接到 Commander MCP Server，拥有以下工具：

### 状态汇报
- 开始任务：`report_status(session_name="你的名字", status="working", task="任务描述")`
- 更新进度：`report_status(session_name="你的名字", status="working", progress=50)`
- 空闲时：`report_status(session_name="你的名字", status="idle")`
- 被阻塞：`report_status(session_name="你的名字", status="blocked", output="原因")`

### 接收任务
- 每次 report_status 后检查返回的 `inbox_count`
- 如果 > 0，立即 `get_inbox(session_name="你的名字")`
- 收到命令后 `ack_inbox(session_name="你的名字", message_id="xxx")`
- 优先处理 high priority 任务

### 完成汇报
- 任务完成时：`report_completion(session_name="你的名字", task="做了什么", result="结果摘要")`
```

---

## 第五步：Hub 指挥室使用

Hub Session 用 5 个指挥工具：

```
# 看全局状态
get_all_status()

# 给某个 session 派任务
send_task(session_name="frontend-dev", task="修复登录页 Bug", priority="high")

# 群发通知
broadcast(message="15 分钟后维护，保存工作")

# 查看完成情况
get_completions(since="2026-04-02T00:00:00Z")

# 查某个 session 详情
get_session_status(session_name="frontend-dev")
```

---

## 第六步：用 REST API 监控（可选）

```bash
# 所有 session 状态
curl http://YOUR_COMMANDER_IP:9200/api/status \
  -H "Authorization: Bearer YOUR_TOKEN" | jq

# 通过 REST 派任务（不用 Claude Code，curl 就行）
curl -X POST http://YOUR_COMMANDER_IP:9200/api/task \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{"session_name":"reviewer","task":"审查最新 PR","priority":"high"}'

# 群发广播
curl -X POST http://YOUR_COMMANDER_IP:9200/api/broadcast \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{"message":"15 分钟后维护，保存工作"}'

# 查看完成记录
curl http://YOUR_COMMANDER_IP:9200/api/completions \
  -H "Authorization: Bearer YOUR_TOKEN" | jq

# 健康检查（无需认证）
curl http://YOUR_COMMANDER_IP:9200/health | jq
```

---

## 完整流程示意

### MCP Tool 模式

```
Hub (Claude Opus)                Commander              Agent (MCP Tool)
     │                               │                        │
     │  send_task("dev","修 Bug")     │                        │
     │──────────────────────────────▶│  写入 inbox             │
     │                               │                        │
     │                               │     report_status()    │
     │                               │◀───────────────────────│
     │                               │  返回 inbox_count=1    │
     │                               │───────────────────────▶│
     │                               │                        │
     │                               │     get_inbox()        │
     │                               │◀───────────────────────│
     │                               │  返回 [修 Bug 任务]    │
     │                               │───────────────────────▶│
     │                               │                        │
     │                               │  report_completion()   │
     │                               │◀───────────────────────│
     │                               │                        │
     │  get_completions()            │                        │
     │──────────────────────────────▶│                        │
     │  ◀── [修 Bug 完成, 结果...]    │                        │
```

### Channel 模式（v0.4.0）

```
Hub                              Commander              Agent (Channel)
     │                               │◀── SSE 长连接 ────────│
     │                               │                        │
     │  send_task("agent","修 Bug")   │                        │
     │──────────────────────────────▶│  写入 inbox             │
     │                               │── SSE push ──────────▶│ 任务秒达！
     │                               │                        │ 自动注入对话
     │                               │                        │
     │                               │  commander_reply()     │
     │                               │◀───────────────────────│ Channel Tool
     │                               │                        │
     │  get_completions()            │                        │
     │──────────────────────────────▶│                        │
     │  ◀── [修 Bug 完成, 结果...]    │                        │
```

---

## FAQ

**Q: Session 断线了怎么办？**
A: Commander 10 分钟没收到 report_status 会自动标记 offline。Session 重连后调一次 report_status 即可恢复。

**Q: 多个 Session 同时写 SQLite 会冲突吗？**
A: WAL 模式 + `busy_timeout=5000ms`，30 个 Session 的写入量完全够用。

**Q: 需要认证吗？**
A: 推荐 Token 认证 + 防火墙双重保护：

1. **Token 认证**：启动时设置 `COMMANDER_AUTH_TOKEN=your-secret-token`，所有请求带 `Authorization: Bearer <token>`。MCP 连接 URL 传 token：
```json
{
  "mcpServers": {
    "commander": {
      "url": "http://YOUR_SERVER:9200/mcp?token=your-secret-token"
    }
  }
}
```

2. **防火墙 IP 白名单**：只允许已知服务器 IP 访问 9200 端口

两层都要加，Token 防未授权访问，防火墙防扫描。

**Q: 能监控哪个 Session 连着？**
A: `curl /health` 返回 `sse_connections`（当前 SSE Push 连接数）和 `sse_sessions`（各 Session 连接详情）。

**Q: MCP Streamable HTTP 和 SSE Push 有什么区别？**
A: MCP Streamable HTTP (`POST /mcp`) 是 Agent 调用 Commander 工具的协议通道。SSE Push (`GET /events/:session`) 是 Commander 实时推送任务给 Agent 的通道。两者各司其职。

**Q: Channel 插件断线会丢任务吗？**
A: 不会。任务写入 SQLite inbox，Channel 重连后通过 `get_inbox` 拉取未确认消息。SSE 只是通知，不是消息本身。

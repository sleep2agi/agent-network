# 快速开始：今天就跑起来

> 从零到 30 个 Session 全部连上 Commander，30 分钟搞定。

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
# 输出：Commander MCP Server v0.1.0 running on port 9200
```

验证：
```bash
curl http://localhost:9200/health
# {"ok":true,"version":"0.1.0","sessions":0,"connections":0}
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
      "url": "http://YOUR_COMMANDER_IP:9200/sse"
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
      "url": "http://YOUR_COMMANDER_IP:9200/sse"
    }
  }
}
```

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
curl http://YOUR_COMMANDER_IP:9200/api/status | jq

# 通过 REST 派任务（不用 Claude Code，curl 就行）
curl -X POST http://YOUR_COMMANDER_IP:9200/api/task \
  -H "Content-Type: application/json" \
  -d '{"session_name":"reviewer","task":"审查最新 PR","priority":"high"}'

# 查看完成记录
curl http://YOUR_COMMANDER_IP:9200/api/completions | jq
```

---

## 完整流程示意

```
Hub (Claude Opus)                Commander              Agent (任意模型)
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
     │                               │     ack_inbox()        │
     │                               │◀───────────────────────│
     │                               │                        │
     │                               │  (Agent 执行任务...)    │
     │                               │                        │
     │                               │  report_completion()   │
     │                               │◀───────────────────────│
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
      "url": "http://YOUR_SERVER:9200/sse?token=your-secret-token"
    }
  }
}
```

2. **防火墙 IP 白名单**：只允许已知服务器 IP 访问 9200 端口

两层都要加，Token 防未授权访问，防火墙防扫描。

**Q: 能监控哪个 Session 连着？**
A: `curl /health` 返回 `connections` 字段（当前 SSE 连接数）。

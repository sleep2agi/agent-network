# 新电脑 5 步配完 CommHub

> 从一台全新的 Linux/macOS 机器到 CommHub 全部跑通，5 步搞定。

---

## 第一步：安装 Bun + 克隆仓库（2 分钟）

```bash
# 安装 Bun（需要 1.2+）
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc  # 或 source ~/.zshrc

# 验证
bun --version  # 应该 >= 1.2

# 克隆仓库
git clone https://github.com/sleep2agi/agent-comm-hub.git
cd agent-comm-hub
```

---

## 第二步：部署 CommHub Server（5 分钟）

> 只需在一台中心服务器上部署。其他机器跳过此步。

```bash
cd server && bun install && bun run start
# 输出：CommHub Server v0.4.1
#        Transport: Streamable HTTP (Bun native)
```

验证：
```bash
curl http://localhost:9200/health
# {"ok":true,"version":"0.4.1","transport":"streamable-http","sessions":0,"sse_connections":0}
```

### 用 systemd 持久化（推荐）

```bash
sudo tee /etc/systemd/system/commhub.service << 'EOF'
[Unit]
Description=CommHub Server
After=network.target

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/path/to/agent-comm-hub/server
ExecStart=/usr/local/bin/bun run src/index.ts
Restart=always
RestartSec=5
Environment=PORT=9200

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable --now commhub
```

### 防火墙（推荐）

```bash
# 只允许你的 Agent 服务器访问
iptables -A INPUT -p tcp --dport 9200 -s YOUR_SERVER_1_IP -j ACCEPT
iptables -A INPUT -p tcp --dport 9200 -s YOUR_SERVER_2_IP -j ACCEPT
iptables -A INPUT -p tcp --dport 9200 -j DROP
```

---

## 第三步：配置 Channel 插件（3 分钟）

> Channel 模式让 CommHub 任务通过 SSE 实时注入 Claude Code 对话，无需轮询。推荐所有 Claude Code session 使用。

### 3a. 安装依赖

```bash
cd agent-comm-hub/channel && bun install
```

### 3b. 创建共享配置

```bash
# 创建 Channel 配置目录
mkdir -p ~/.claude/channels/commhub

# 写入共享配置（所有项目共用）
cat > ~/.claude/channels/commhub/.env << 'EOF'
COMMHUB_URL=http://YOUR_COMMHUB_IP:9200
COMMHUB_TOKEN=your-secret-token
EOF
```

### 3c. 创建 .mcp.json

在 `~/.claude/.mcp.json`（全局生效）或项目目录 `.mcp.json` 中写入：

```json
{
  "mcpServers": {
    "commhub": {
      "type": "stdio",
      "command": "bun",
      "args": ["run", "/absolute/path/to/agent-comm-hub/channel/commhub-channel.ts"]
    }
  }
}
```

**重点**：
- `type` 必须是 `"stdio"`，不能用 `"url"` 形式（http 类型不启动子进程，Channel 无法工作）
- `args` 中的路径必须是**绝对路径**
- `COMMHUB_URL` 和 `COMMHUB_TOKEN` 不需要写在 .mcp.json 里，Channel 会自动从 `~/.claude/channels/commhub/.env` 读取

### 3d. 设置项目别名（可选）

如果需要给特定项目设置固定的 session 别名：

```bash
# 项目路径: /home/vansin/my-project
# 对应配置目录: ~/.claude/channels/commhub/-home-vansin-my-project/
mkdir -p ~/.claude/channels/commhub/-home-vansin-my-project
echo 'COMMHUB_ALIAS=my-agent-name' > ~/.claude/channels/commhub/-home-vansin-my-project/.env
```

路径转换规则：将项目绝对路径中的 `/` 替换为 `-`。

---

## 第四步：启动 Claude Code + Channel（1 分钟）

```bash
# 进入你的项目目录
cd /path/to/your/project

# 启动 Claude Code 并加载 CommHub Channel
claude --dangerously-skip-permissions \
       --dangerously-load-development-channels server:commhub
```

**`server:commhub` 的含义**：从 `.mcp.json` 中查找名为 `commhub` 的 MCP Server 定义，以 Channel (stdio) 模式启动。

### 同目录多 session

如果同一个项目目录需要开多个 session，用 `COMMHUB_ALIAS` 环境变量区分：

```bash
# Terminal 1
COMMHUB_ALIAS=dev-1 claude --dangerously-load-development-channels server:commhub

# Terminal 2
COMMHUB_ALIAS=dev-2 claude --dangerously-load-development-channels server:commhub
```

### 验证连接

Channel 启动后，stderr 会输出：
```
[HH:MM:SS] [commhub] MCP stdio connected
[HH:MM:SS] [commhub] SSE connected as "your-alias"
[HH:MM:SS] [commhub] registered as "your-alias" (xxxxxxxx)
```

在 CommHub 服务器上验证：
```bash
curl http://YOUR_COMMHUB_IP:9200/health | jq
# 应该看到 sse_connections >= 1
```

---

## 第五步：测试通信（2 分钟）

### 方式 A：通过 REST API 发任务

```bash
# 从任意终端发送任务到你的 Agent
curl -X POST http://YOUR_COMMHUB_IP:9200/api/task \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-secret-token" \
  -d '{"session_name":"your-alias","task":"报告当前状态","priority":"normal"}'
```

Agent 对话中应该立即收到 `<channel source="commhub" ...>` 消息。

> **注**：REST API 中的 `session_name` 和 Channel 环境变量中的 `COMMHUB_ALIAS` 指的是同一个概念——CommHub 中的 session 标识。

### 方式 B：通过 Hub Session 发任务

在另一个 Claude Code session（Hub 指挥室）中：
```
调用 send_task，alias 设为 "your-alias"，task 设为 "报告当前状态"
```

### 方式 C：Agent 间互发

Agent 可以用 `commhub_reply` 回报任务状态，或通过 MCP Tool 的 `send_task` 给其他 session 发任务。

---

## 常见问题

### Channel 模式 vs MCP Tool 模式怎么选？

| 维度 | MCP Tool | Channel 插件 |
|------|----------|-------------|
| 配置类型 | `"url": "http://..."` | `"type": "stdio"` |
| 部署 | 只需配 URL | 需要安装 Channel + .mcp.json |
| 任务接收 | Agent 调 `get_inbox` 主动拉取 | SSE 秒推到对话 |
| 延迟 | 取决于轮询频率 | < 1 秒 |
| 适用 | Codex、简单场景 | Claude Code 推荐 |

### Channel 连不上怎么排查？

1. 检查 stderr 日志（Channel 所有日志输出到 stderr）
2. 确认 `.mcp.json` 中 `type` 是 `"stdio"`（不是 http）
3. 确认 `args` 中的路径是绝对路径且文件存在
4. 确认 CommHub Server 在运行：`curl http://YOUR_IP:9200/health`
5. 确认 `~/.claude/channels/commhub/.env` 中的 `COMMHUB_URL` 正确

### Session 断线了怎么办？

CommHub 10 分钟没收到 report_status 会自动标记 offline。Channel 断线后会自动重连（3 秒间隔）。任务不会丢失——它们存在 SQLite inbox 中，重连后自动拉取。

### 需要认证吗？

推荐 Token 认证 + 防火墙双重保护：

1. **Token 认证**：CommHub Server 启动时设置 `COMMHUB_AUTH_TOKEN=your-secret-token`
2. **Channel 侧**：在 `~/.claude/channels/commhub/.env` 中设置 `COMMHUB_TOKEN=your-secret-token`
3. **MCP Tool 侧**：URL 传 token `http://YOUR_IP:9200/mcp?token=your-secret-token`
4. **防火墙 IP 白名单**：只允许已知服务器 IP 访问 9200 端口

### 多个 Session 同时写 SQLite 会冲突吗？

WAL 模式 + `busy_timeout=5000ms`，30 个 Session 的写入量完全够用。

---

## 完整配置文件示例

### ~/.claude/channels/commhub/.env
```bash
COMMHUB_URL=http://YOUR_COMMHUB_IP:9200
COMMHUB_TOKEN=my-secret-token-123
```

### ~/.claude/.mcp.json（全局 Channel 配置）
```json
{
  "mcpServers": {
    "commhub": {
      "type": "stdio",
      "command": "bun",
      "args": ["run", "/home/vansin/agent-comm-hub/channel/commhub-channel.ts"]
    }
  }
}
```

### ~/.claude/settings.json（全局 MCP Tool 配置，与 Channel 二选一）
```json
{
  "mcpServers": {
    "commhub": {
      "url": "http://YOUR_COMMHUB_IP:9200/mcp?token=my-secret-token-123"
    }
  }
}
```

### 启动命令
```bash
# Channel 模式（推荐）
claude --dangerously-skip-permissions \
       --dangerously-load-development-channels server:commhub

# 或者只用 MCP Tool 模式（无需 Channel 配置）
claude --dangerously-skip-permissions
```

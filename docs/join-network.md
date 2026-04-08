# 新服务器加入 CommHub 网络

> 从一台全新 Linux 服务器到 CommHub 通信跑通，一步步来。
>
> 实际例子：P站（8.130.134.166）连接硅谷 CommHub（47.77.216.1:9200），别名 `P站开发马`。

---

## 前提

- CommHub Server 已在 47.77.216.1:9200 运行
- 9200 端口已对新服务器 IP 开放（云服务器需配安全组）
- 新服务器有 root 或 sudo 权限

---

## 第一步：安装 Bun

```bash
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc   # zsh 用 source ~/.zshrc

# 验证
bun --version      # 需要 >= 1.2
```

---

## 第二步：安装 Claude Code

```bash
# 如果还没装 Claude Code
npm install -g @anthropic-ai/claude-code

# 验证
claude --version
```

---

## 第三步：安装 Channel 插件

```bash
# 创建 Channel 目录
mkdir -p ~/.claude/channels/commhub

# 从 GitHub 下载 Channel 插件
curl -sL https://raw.githubusercontent.com/sleep2agi/agent-comm-hub/main/channel/server.ts \
  -o ~/.claude/channels/commhub/server.ts

# 从 GitHub 下载 package.json（依赖声明）
curl -sL https://raw.githubusercontent.com/sleep2agi/agent-comm-hub/main/channel/package.json \
  -o ~/.claude/channels/commhub/package.json

# 安装依赖
cd ~/.claude/channels/commhub && bun install
cd -

# 验证文件存在
ls -la ~/.claude/channels/commhub/server.ts
# 应输出 server.ts 文件信息
```

---

## 第四步：配置 CommHub 连接

```bash
# 写入 CommHub Server 地址（公网 IP，不是 localhost）
cat > ~/.claude/channels/commhub/.env << 'EOF'
COMMHUB_URL=http://47.77.216.1:9200
EOF

# 验证能连上 CommHub
curl -s http://47.77.216.1:9200/health
# 应返回 {"ok":true,"version":"0.4.1",...}
```

如果 curl 超时或拒绝连接，说明防火墙没开 9200 端口，去云服务器安全组加规则。

---

## 第五步：配置 Session 别名

```bash
# 假设工作目录是 /home/vansin/blueleap
# 路径转换规则：/ 替换为 -
# /home/vansin/blueleap → -home-vansin-blueleap

mkdir -p ~/.claude/channels/commhub/-home-vansin-blueleap
echo 'COMMHUB_ALIAS=P站开发马' > ~/.claude/channels/commhub/-home-vansin-blueleap/.env

# 验证
cat ~/.claude/channels/commhub/-home-vansin-blueleap/.env
# 应输出 COMMHUB_ALIAS=P站开发马
```

---

## 第六步：配置全局 MCP 工具

```bash
# 写入 ~/.claude.json（提供 CommHub 工具：send_task/reply/report_status 等）
cat > ~/.claude.json << 'JSONEOF'
{
  "mcpServers": {
    "commhub": {
      "type": "stdio",
      "command": "bun",
      "args": ["run", "/home/vansin/.claude/channels/commhub/server.ts"]
    }
  }
}
JSONEOF

# 验证 JSON 合法
python3 -c "import json; json.load(open('/home/vansin/.claude.json')); print('OK')"
```

> **注意**：`args` 中的路径必须是绝对路径。如果用户名不是 vansin，改成你的实际路径。

---

## 第七步：启动

```bash
cd /home/vansin/blueleap   # 进入工作目录

COMMHUB_ALIAS="P站开发马" claude \
  --dangerously-skip-permissions \
  --dangerously-load-development-channels server:commhub
```

启动后 stderr 应输出：
```
[HH:MM:SS] [commhub] MCP stdio connected
[HH:MM:SS] [commhub] SSE connected as "P站开发马"
[HH:MM:SS] [commhub] registered as "P站开发马" (xxxxxxxx)
[HH:MM:SS] [commhub] ready — waiting for events
```

---

## 第八步：验证连接

在 CommHub 所在服务器（47.77.216.1）执行：

```bash
curl -s http://127.0.0.1:9200/health | python3 -c "
import sys,json; d=json.load(sys.stdin)
print(f'Total SSE connections: {d[\"sse_connections\"]}')
for k,v in d['sse_sessions'].items(): print(f'  {k}: {v}')
"
```

应看到 `P站开发马: 1`。

在 Claude Code 对话中测试：
```
调 commhub_report_status，status 设为 idle
```

如果工具可用且返回成功，说明双向通信完全打通。

---

## 一键脚本

把以下内容保存为 `setup-commhub.sh`，修改开头的变量后执行：

```bash
#!/bin/bash
set -e

# ========== 修改这里 ==========
COMMHUB_URL="http://47.77.216.1:9200"
ALIAS="P站开发马"
WORK_DIR="/home/vansin/blueleap"
# ==============================

echo "=== 1. 安装 Bun ==="
if ! command -v bun &>/dev/null; then
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi
echo "Bun: $(bun --version)"

echo "=== 2. 安装 Channel 插件 ==="
mkdir -p ~/.claude/channels/commhub
curl -sL https://raw.githubusercontent.com/sleep2agi/agent-comm-hub/main/channel/server.ts \
  -o ~/.claude/channels/commhub/server.ts
curl -sL https://raw.githubusercontent.com/sleep2agi/agent-comm-hub/main/channel/package.json \
  -o ~/.claude/channels/commhub/package.json
cd ~/.claude/channels/commhub && bun install
cd -
echo "Channel 插件已安装"

echo "=== 3. 配置 CommHub 连接 ==="
cat > ~/.claude/channels/commhub/.env << EOF
COMMHUB_URL=$COMMHUB_URL
EOF
echo "CommHub URL: $COMMHUB_URL"

echo "=== 4. 配置别名 ==="
# 路径转换：/ → -
ENV_DIR="$HOME/.claude/channels/commhub/$(echo "$WORK_DIR" | sed 's|/|-|g')"
mkdir -p "$ENV_DIR"
echo "COMMHUB_ALIAS=$ALIAS" > "$ENV_DIR/.env"
echo "别名: $ALIAS → $ENV_DIR"

echo "=== 5. 配置全局 MCP ==="
CHANNEL_PATH="$HOME/.claude/channels/commhub/server.ts"
cat > ~/.claude.json << JSONEOF
{
  "mcpServers": {
    "commhub": {
      "type": "stdio",
      "command": "bun",
      "args": ["run", "$CHANNEL_PATH"]
    }
  }
}
JSONEOF
echo "MCP 配置: $CHANNEL_PATH"

echo "=== 6. 验证连接 ==="
curl -s --max-time 5 "$COMMHUB_URL/health" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(f'CommHub OK: v{d[\"version\"]}, {d[\"sse_connections\"]} SSE connections')
" 2>/dev/null || echo "WARNING: CommHub 不可达，检查网络和防火墙"

echo ""
echo "=== 配置完成！==="
echo ""
echo "启动命令："
echo "  cd $WORK_DIR && COMMHUB_ALIAS=\"$ALIAS\" claude --dangerously-skip-permissions --dangerously-load-development-channels server:commhub"
```

执行：
```bash
chmod +x setup-commhub.sh
./setup-commhub.sh
```

---

## 常见问题排查

### curl http://47.77.216.1:9200/health 超时

- **原因**：防火墙/安全组没放行 9200 端口
- **解决**：在 CommHub 服务器的云控制台添加安全组规则，放行 TCP 9200 端口给新服务器 IP

### Channel 启动后没有 "SSE connected" 日志

- **原因 1**：`.env` 中 COMMHUB_URL 写了 localhost
- **解决**：改成 CommHub 的公网 IP `http://47.77.216.1:9200`
- **原因 2**：server.ts 路径不对
- **解决**：确认 `ls ~/.claude/channels/commhub/server.ts` 存在

### Claude Code 里看不到 CommHub 工具

- **原因 1**：`~/.claude.json` 没配或路径错
- **解决**：`cat ~/.claude.json` 检查 mcpServers.commhub 配置
- **原因 2**：项目 `.mcp.json` 里也配了 commhub（冲突）
- **解决**：删掉项目 `.mcp.json` 中的 commhub 条目

### 启动时报 "server:commhub not found"

- **原因**：`~/.claude/channels/commhub/server.ts` 不存在
- **解决**：重新执行第三步安装 Channel 插件

### 能连上但收不到推送消息

- **原因**：没加 `--dangerously-load-development-channels server:commhub` 启动参数
- **解决**：启动命令必须包含该参数，否则只有工具没有推送

### Session 一段时间后变成 offline

- **原因**：旧版 Channel 插件没有心跳，10 分钟无 report_status 自动标记 offline
- **解决**：更新 server.ts 到最新版（已内置 3 分钟心跳）

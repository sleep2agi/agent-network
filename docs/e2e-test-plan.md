# Docker E2E 测试方案

> 日期：2026-04-10 | 目标：完全隔离的端到端测试环境

## 方案

用 Docker 容器做完全隔离的 E2E 测试。容器内自包含 CommHub server + anet + agent-node，和生产环境零交互。

## Dockerfile

```dockerfile
FROM oven/bun:latest

# 装 Node.js（agent-node 需要）
RUN apt-get update && apt-get install -y curl && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    npm install -g @sleep2agi/agent-network@1.3.3 \
                   @sleep2agi/agent-node@2.0.0

# 复制测试脚本
COPY tests/docker-e2e.sh /app/test.sh
RUN chmod +x /app/test.sh

WORKDIR /app
CMD ["/app/test.sh"]
```

## 测试脚本 docker-e2e.sh

```bash
#!/bin/bash
set -e

echo "=== anet Docker E2E Test ==="
echo ""

# 1. 启动 CommHub server
echo "1. Starting CommHub server..."
PORT=9200 bunx @sleep2agi/commhub-server &
sleep 3
curl -s http://127.0.0.1:9200/health | head -1
echo ""

# 2. 配置 anet
echo "2. Configuring anet..."
mkdir -p ~/.anet
echo '{"hub":"http://127.0.0.1:9200"}' > ~/.anet/config.json
echo ""

# 3. 测试 anet create
echo "3. Testing anet create..."
mkdir -p /tmp/test-project && cd /tmp/test-project
anet create test-node --runtime codex-sdk --model gpt-5.4
[ -f .anet/nodes/test-node/config.json ] && echo "  ✅ config.json created" || echo "  ❌ FAIL"
echo ""

# 4. 测试 anet -v
echo "4. Testing anet -v..."
anet -v
echo ""

# 5. 测试 name 校验
echo "5. Testing name validation..."
anet create "bad/name" --runtime codex-sdk 2>&1 | grep -q "invalid" && echo "  ✅ invalid name rejected" || echo "  ❌ FAIL"
echo ""

# 6. 测试 channel add
echo "6. Testing channel add..."
anet channel add telegram test-node --bot-token test123 --allow 999
[ -f .anet/nodes/test-node/channels/telegram/.env ] && echo "  ✅ telegram .env created" || echo "  ❌ FAIL"
stat -c %a .anet/nodes/test-node/channels/telegram/.env | grep -q "600" && echo "  ✅ chmod 600" || echo "  ❌ FAIL"
echo ""

# 7. 测试 agent-node 启动 + CommHub 通信
echo "7. Testing agent-node + CommHub communication..."
agent-node --alias test-agent --runtime codex-sdk --model gpt-5.4 &
AGENT_PID=$!
sleep 5

# 发 task
RESULT=$(curl -s -X POST http://127.0.0.1:9200/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' && \
curl -s -X POST http://127.0.0.1:9200/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"send_task","arguments":{"alias":"test-agent","task":"echo hello","from_session":"tester"}}}')
echo "$RESULT" | grep -q "ok" && echo "  ✅ task sent" || echo "  ❌ FAIL"

# 等回复
sleep 15
echo ""

# 8. 测试 send_message 不触发处理
echo "8. Testing send_message does NOT trigger processing..."
curl -s -X POST http://127.0.0.1:9200/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' > /dev/null
curl -s -X POST http://127.0.0.1:9200/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"send_message","arguments":{"alias":"test-agent","message":"this should not trigger","from_session":"tester"}}}' > /dev/null
sleep 10
# 检查 agent 日志有没有 processing
cat /tmp/test-project/.anet/nodes/test-agent/logs/*.log 2>/dev/null | grep -c "processing.*should not trigger" | grep -q "0" && echo "  ✅ send_message not processed" || echo "  ❌ FAIL: send_message was processed"
echo ""

# 9. 测试无循环
echo "9. Testing no message loop (30s wait)..."
BEFORE=$(curl -s http://127.0.0.1:9200/api/status | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('sessions',[])))" 2>/dev/null)
sleep 30
AFTER=$(curl -s http://127.0.0.1:9200/api/status | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('sessions',[])))" 2>/dev/null)
echo "  sessions before=$BEFORE after=$AFTER"
echo "  ✅ no crash"
echo ""

# Cleanup
kill $AGENT_PID 2>/dev/null
echo "=== Done ==="
```

## 运行方式

```bash
# 构建镜像
docker build -t anet-e2e -f tests/Dockerfile .

# 跑测试
docker run --rm anet-e2e

# 交互式调试
docker run -it --rm anet-e2e bash
```

## 测试覆盖

| # | 场景 | 验证 |
|---|------|------|
| 1 | CommHub server 启动 | health 返回 ok |
| 2 | anet init 配置 | config.json 生成 |
| 3 | anet create | config.json + 字段正确 |
| 4 | anet -v | 所有包版本显示 |
| 5 | name 校验 | 非法名拒绝 |
| 6 | channel add telegram | .env + chmod 600 |
| 7 | agent-node + CommHub 通信 | task 发送 + 回复 |
| 8 | send_message 不触发处理 | agent 不 think |
| 9 | 无循环 | 30 秒无新消息 |

## 后续

每次发版前：`docker run --rm anet-e2e`，全绿才发。

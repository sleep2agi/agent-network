# V2 生产环境升级方案

## 版本变化

| 包 | 当前生产 | V2 Preview | 变化 |
|---|---------|-----------|------|
| @sleep2agi/agent-network (anet) | 1.3.3 | 2.0.0-preview.2 | node_id/rename/stop/delete/interactive create/ensureMcpJson/.js |
| @sleep2agi/agent-node | 2.0.0 | 2.1.0-preview.1 | send_reply/in_reply_to/retry/V2字段/消息过滤/emoji修复 |
| @sleep2agi/commhub-server | 0.4.4 | 0.5.0-preview.1 | tasks表/send_reply/send_ack/事务安全/MCP鉴权/任务过期 |

## 前提条件

- Docker E2E 101 个测试全绿
- Codex 真实 E2E 7/7 绿 (GPT-5.4)
- npm smoke test 12/12 绿
- 通信牛 4 轮 review 全部通过

## 升级步骤

### 第 1 步：备份（2 分钟）

```bash
# 备份数据库
cp ~/.commhub/commhub.db ~/.commhub/commhub.db.backup-$(date +%Y%m%d)

# 备份全局配置
cp ~/.anet/config.json ~/.anet/config.json.backup

# 记录当前版本
anet -v > ~/anet-versions-before.txt
agent-node --version >> ~/anet-versions-before.txt
```

### 第 2 步：停所有 agent（1 分钟）

```bash
# 停所有运行中的 agent-node 和 claude 会话
# 或者用 anet stop <name>
pkill -f "agent-node" || true
```

### 第 3 步：升级 CommHub Server（3 分钟）

```bash
# 先升级 server（它会自动迁移数据库 schema）
cd ~/commhub-server  # 或者你的 server 目录
bunx @sleep2agi/commhub-server@preview
# 验证启动成功
curl http://127.0.0.1:9200/health
# 验证 tasks 端点
curl http://127.0.0.1:9200/api/tasks
```

如果用 tmux 运行 server：
```bash
tmux send-keys -t commhub C-c
sleep 2
tmux send-keys -t commhub 'bunx @sleep2agi/commhub-server@preview' Enter
```

### 第 4 步：升级 anet CLI（2 分钟）

```bash
npm install -g @sleep2agi/agent-network@preview
anet -v  # 应该显示 2.0.0-preview.2
```

### 第 5 步：升级 agent-node（2 分钟）

```bash
npm install -g @sleep2agi/agent-node@preview
agent-node --version  # 应该显示 2.1.0-preview.1
```

### 第 6 步：验证（3 分钟）

```bash
# 版本检查
anet -v
agent-node --version

# 功能检查
anet ls                           # 应该有 STATUS/SSE 列
anet create upgrade-test --runtime codex-sdk --model gpt-5.4
anet stop upgrade-test
anet delete upgrade-test --force

# CommHub API 检查
curl http://127.0.0.1:9200/api/tasks
curl http://127.0.0.1:9200/health
```

### 第 7 步：重启 agent（按需）

```bash
# 重启各个 agent
anet start 通信龙
anet start SDK马
# ... 其他 agent
```

## 兼容性说明

- **数据库**: V2 使用 ALTER TABLE 自动加列，不删旧数据，向后兼容
- **config.json**: V2 新增 node_id/node_name 字段，旧配置自动补全
- **MCP 协议**: send_reply 是新增工具，旧的 report_completion 仍然可用
- **channel 插件**: ensureMcpJson 会自动更新 .mcp.json 路径

## 回滚方案

如果出问题：
```bash
# 回滚数据库
cp ~/.commhub/commhub.db.backup-YYYYMMDD ~/.commhub/commhub.db

# 回滚包
npm install -g @sleep2agi/agent-network@1.3.3
npm install -g @sleep2agi/agent-node@2.0.0
# server: bunx @sleep2agi/commhub-server@0.4.4
```

## 升级后新功能

- `anet stop/delete` — 停止/删除节点
- `anet ls` — 带网络状态的节点列表
- `anet rename` — 重命名节点
- 交互式 `anet create` — 上下选择 runtime/model
- tasks 表 — 完整任务生命周期追踪
- `/api/tasks` — 任务查询 REST API
- MCP/SSE/WebSocket 全部鉴权
- 任务自动过期（1小时）
- callCommHub 重试机制

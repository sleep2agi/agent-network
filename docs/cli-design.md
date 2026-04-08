# @sleep2agi/agent-network CLI 设计文档

## 命令总览

```
anet <command> [options]

Server 端（中心节点）:
  server        启动 CommHub 通信中枢

Node 端（Agent 节点）:
  setup         配置新 Agent 加入网络
  run           运行独立 Agent（SSE 监听 + 自动处理）
```

## 配置文件

### 路径

| 级别 | 路径 | 内容 |
|------|------|------|
| 全局 | `~/.anet/config.json` | CommHub URL、token、默认类型 |
| 项目 | `{workpath}/.anet/config.json` | alias、agent 类型、项目特定配置 |

**优先级**：项目 > 全局 > 命令行默认值。命令行参数优先级最高。

### 全局配置 `~/.anet/config.json`

```json
{
  "hub": "http://YOUR_COMMHUB_IP:9200",
  "token": "your-auth-token",
  "type": "claude-code"
}
```

### 项目配置 `{workpath}/.anet/config.json`

```json
{
  "alias": "开发马",
  "type": "claude-code",
  "hub": "http://YOUR_COMMHUB_IP:9200"
}
```

### 配置解析顺序

```
命令行参数 --hub / --alias / --type
    ↓ 未指定时
项目配置 {cwd}/.anet/config.json
    ↓ 未指定时
全局配置 ~/.anet/config.json
    ↓ 未指定时
默认值（hub=http://127.0.0.1:9200, type=claude-code）
```

## 1. server — 启动中心节点

```bash
anet server [options]
```

| 参数 | 短写 | 环境变量 | 默认值 | 说明 |
|------|------|---------|--------|------|
| --port | -p | PORT | 9200 | 监听端口 |
| --token | -t | COMMHUB_AUTH_TOKEN | 无（开放） | Bearer 认证 token |
| --db | | COMMHUB_DB | ~/.commhub/commhub.db | SQLite 路径 |
| --cors | | COMMHUB_CORS_ORIGINS | localhost | CORS origins |

server 命令也从 `~/.anet/config.json` 读取 `token`（如果命令行未指定）。

示例：
```bash
anet server
anet server --port 9200 --token my-secret-token
```

端点：
- POST /mcp — MCP Streamable HTTP
- GET /events/:alias — SSE 实时推送
- GET /health — 健康检查
- POST /api/task — REST 发任务
- GET /api/status — 所有 session 状态

## 2. setup — 配置新 Agent

```bash
anet setup --hub <url> --alias <name> [--type <type>]
```

| 参数 | 必需 | 默认值 | 说明 |
|------|------|--------|------|
| --hub | ✅（首次） | 从全局配置读 | CommHub Server URL |
| --alias | ✅ | — | Agent 别名 |
| --type | | claude-code | claude-code / sdk |

**setup 做的事**：

1. 测试 CommHub 连接（GET /health）
2. 写入全局配置 `~/.anet/config.json`（hub、token）
3. 写入项目配置 `{cwd}/.anet/config.json`（alias、type）
4. 根据 type 配置对应载体：
   - **claude-code**：创建 Channel 目录 + .env + 输出启动命令
   - **sdk**：输出 SDK 代码示例

示例：
```bash
# 首次 setup（写入全局 + 项目配置）
anet setup --hub http://YOUR_IP:9200 --alias 开发马

# 后续项目只需指定 alias（hub 从全局配置读）
cd ~/another-project
anet setup --alias 另一个马

# SDK Agent
anet setup --alias SDK马 --type sdk
```

## 3. run — 运行独立 Agent

```bash
anet run [--alias <name>] [--hub <url>] [--handler <path>]
```

| 参数 | 必需 | 来源 | 说明 |
|------|------|------|------|
| --alias | | 项目配置 > 命令行 | Agent 别名 |
| --hub | | 全局配置 > 命令行 | CommHub URL |
| --handler | | 无（echo 模式） | 任务处理脚本 |

**配置文件自动读取**：如果当前目录有 `.anet/config.json`，alias 和 hub 自动从中读取，无需命令行指定。

行为：SSE 长连接监听 → 收到任务自动处理 → 回复发送者 → 3 分钟心跳

示例：
```bash
# 自动从 .anet/config.json 读取 alias 和 hub
cd ~/my-project
anet run

# 显式指定
anet run --alias 测试马 --hub http://YOUR_IP:9200

# 自定义处理脚本
anet run --handler ./my-handler.ts
```

## 代码引用

```typescript
import { CommHub } from '@sleep2agi/agent-network';

const hub = new CommHub({ url: 'http://YOUR_IP:9200', alias: '我的Agent' });
hub.on('task', async (msg) => {
  await hub.send(msg.from_session, '处理完成');
});
```

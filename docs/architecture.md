# @sleep2agi/agent-network 架构设计

> CLI 名：`anet` | npm 包名：`@sleep2agi/agent-network`

---

## 1. 目录结构

```
agent-network/
├── bin/
│   └── cli.ts              # CLI 入口（anet 命令）
├── src/
│   ├── index.ts             # npm 包入口（re-export client + server）
│   ├── client.ts            # CommHub SDK 客户端（EventEmitter + SSE）
│   └── server.ts            # Server 编程启动入口
├── dist/                    # 编译产物（minified，发布到 npm）
│   ├── bin/cli.js
│   ├── src/client.js
│   └── client.d.ts          # TypeScript 类型声明
├── package.json
├── tsconfig.json
├── .gitignore
└── README.md
```

**设计原则**：client.ts 是核心（零外部依赖），server.ts 是薄包装（委托给 `../../server/src/index.ts`），cli.ts 是粘合层。

---

## 2. 配置文件

### 路径和优先级

```
环境变量（COMMHUB_URL / COMMHUB_ALIAS / COMMHUB_AUTH_TOKEN）
  ↓ 未设置时
命令行参数（--hub / --alias / --token）
  ↓ 未指定时
项目配置 {cwd}/.anet/config.json
  ↓ 未找到时
全局配置 ~/.anet/config.json
  ↓ 未找到时
默认值（hub=http://127.0.0.1:9200, type=claude-code）
```

### 全局配置 `~/.anet/config.json`

跨项目共享，`anet setup` 首次运行时创建。

```json
{
  "hub": "http://YOUR_COMMHUB_IP:9200",
  "token": "your-auth-token"
}
```

| 字段 | 必需 | 说明 |
|------|------|------|
| hub | ✅ | CommHub Server URL |
| token | | Bearer auth token |

### 项目配置 `{workpath}/.anet/config.json`

每个项目独立，`anet setup` 运行时创建。

```json
{
  "alias": "开发马",
  "type": "claude-code"
}
```

| 字段 | 必需 | 说明 |
|------|------|------|
| alias | ✅ | Agent 别名 |
| type | | claude-code / sdk / opencode |
| hub | | 覆盖全局 hub（跨网络场景） |

---

## 3. CLI 命令详细设计

### `anet server`

启动 CommHub 通信中枢。

```bash
anet server [--port 9200] [--token xxx] [--db path] [--cors origins]
```

**流程**：
1. 读取 `~/.anet/config.json` 中的 token（如果 CLI 未指定）
2. 设置环境变量
3. 动态 import `../../server/src/index.ts`
4. Bun.serve 启动 HTTP server

**端点**：

| 端点 | 方法 | 认证 | 说明 |
|------|------|------|------|
| /mcp | POST | 否 | MCP Streamable HTTP |
| /events/:alias | GET | 是 | SSE 实时推送 |
| /health | GET | 否 | 健康检查 |
| /api/status | GET | 是 | 所有 session 状态 |
| /api/task | POST | 是 | REST 发任务 |
| /api/broadcast | POST | 是 | 广播 |
| /api/completions | GET | 是 | 最近完成记录 |
| /ws/tmux/:name | WS | 是 | tmux 终端流 |

### `anet setup`

配置新 Agent 加入网络。

```bash
anet setup --hub <url> --alias <name> [--type claude-code|sdk|opencode]
```

**流程**：
1. 解析参数（CLI > 已有配置 > 默认值）
2. 写入 `~/.anet/config.json`（hub, token）
3. 写入 `{cwd}/.anet/config.json`（alias, type）
4. 测试连接（GET /health）
5. 根据 type 执行额外配置：

| type | 额外操作 |
|------|---------|
| claude-code | 创建 Channel 目录 + .env + 输出启动命令 |
| sdk | 输出 SDK 代码模板 |
| opencode | 输出 opencode.json + Poller 命令 |

### `anet run`

运行独立 Agent（SSE 监听 + 自动处理）。

```bash
anet run [--alias name] [--hub url] [--handler script.ts]
```

**流程**：
1. 读取配置（env > CLI > .anet/config.json > ~/.anet/config.json）
2. 创建 CommHub 客户端（SSE 长连接）
3. 自动注册（report_status idle）
4. 启动心跳（3 分钟）
5. 监听 SSE 事件 → 拉 inbox → ACK → 处理 → 回复
6. SIGINT/SIGTERM → 上报 offline → 退出

**handler 协议**：
- 无 handler：echo 模式（收到什么回什么）
- 有 handler：`bun <handler> <msg_json>` → stdout 作为回复内容

---

## 4. SDK API 设计

### Client（核心）

```typescript
import { CommHub } from '@sleep2agi/agent-network';

const hub = new CommHub(options: CommHubOptions);
```

**CommHubOptions**：

| 字段 | 类型 | 必需 | 默认值 | 说明 |
|------|------|------|--------|------|
| url | string | ✅ | — | CommHub Server URL |
| alias | string | ✅ | — | Session 别名 |
| token | string | | — | Auth token |
| agent | string | | "sdk" | Agent 类型标识 |
| heartbeatInterval | number | | 180000 | 心跳间隔（ms） |
| reconnectDelay | number | | 3000 | SSE 重连基础延迟（ms） |
| autoConnect | boolean | | true | 创建时自动连接 |

**方法**：

| 方法 | 返回 | 说明 |
|------|------|------|
| `connect()` | Promise | 连接 + 注册 + SSE + 心跳 |
| `disconnect()` | Promise | 断开 + 上报 offline |
| `send(alias, content, priority?)` | Promise | 发任务 |
| `message(alias, content)` | Promise | 发消息（无生命周期） |
| `reply(taskId, text, status?)` | Promise | 回复任务状态 |
| `status(state, extra?)` | Promise | 更新 session 状态 |
| `getAllStatus()` | Promise | 获取所有 session 状态 |
| `broadcast(content, filter?)` | Promise | 广播 |

**事件**：

| 事件 | 参数 | 说明 |
|------|------|------|
| task | InboxMessage | 收到任务（已自动 ACK） |
| message | InboxMessage | 同 task（别名） |
| connected | — | SSE 连接成功 |
| disconnected | — | SSE 断开 |
| error | Error | 错误 |

**InboxMessage**：

```typescript
interface InboxMessage {
  id: string;
  content: string;
  from_session: string;
  priority: string;
  created_at: string;
}
```

### Server（编程入口）

```typescript
import { startServer } from '@sleep2agi/agent-network/server';

await startServer({
  port: 9200,
  token: 'secret',
  db: '~/.commhub/commhub.db',
  corsOrigins: ['http://localhost:3000'],
});
```

---

## 5. Channel 插件提取

`anet setup --type claude-code` 需要将 Channel 插件放到 `~/.claude/channels/commhub/server.ts`。

**当前方案**：setup 命令检查文件是否存在，不存在时提示用户手动复制或从 GitHub 下载。

```
如果 ~/.claude/channels/commhub/server.ts 不存在：
  → 提示: curl -sL https://raw.githubusercontent.com/sleep2agi/agent-comm-hub/main/channel/server.ts -o ~/.claude/channels/commhub/server.ts
```

**未来方案**：把 channel/server.ts 打包进 npm 包，setup 时自动提取到正确位置。

---

## 6. 与现有包的关系

```
@sleep2agi/agent-network（合并包，推荐）
  ├── Client SDK = @sleep2agi/commhub-sdk（独立客户端包）
  ├── Server = @sleep2agi/commhub-server（独立服务端包）
  └── CLI（anet）= 新增，只在合并包里

三个包共存：
- agent-network：一站式，推荐新用户
- commhub-sdk：只需客户端的场景（嵌入现有 Node.js 应用）
- commhub-server：只需服务端的场景（已有客户端方案）
```

代码复用关系：
- `agent-network/src/client.ts` = `sdk/index.ts`（相同代码）
- `agent-network/src/server.ts` → 动态 import `server/src/index.ts`
- `agent-network/bin/cli.ts` → 引用 client.ts + server

---

## 7. npm 发布结构

### 发布内容

```
dist/
├── bin/cli.js       # CLI 入口（minified，~580KB 含 MCP SDK bundle）
├── src/client.js    # Client（minified，~4.4KB）
└── client.d.ts      # TypeScript 类型声明
src/
└── server.ts        # Server 入口（Bun-only，保留 .ts 源码）
package.json
README.md
```

### package.json 关键字段

```json
{
  "name": "@sleep2agi/agent-network",
  "bin": { "anet": "dist/bin/cli.js" },
  "main": "dist/src/client.js",
  "types": "dist/client.d.ts",
  "exports": {
    ".": { "import": "./dist/src/client.js", "types": "./dist/client.d.ts" },
    "./server": { "import": "./src/server.ts" }
  },
  "files": ["dist", "src/server.ts"]
}
```

### 构建

```bash
# bun build: minify JS（client + CLI）
bun build src/client.ts bin/cli.ts --outdir dist --target node --minify

# tsc: 生成类型声明（仅 client）
tsc --emitDeclarationOnly --declaration --outDir dist
```

---

## 8. 安全考虑

### 代码安全
- 零硬编码 IP/token/key（全部通过 config 或 env）
- npm 发布前自动 grep 检查敏感信息
- dist/ 只包含 minified JS，不含 .ts 源码（server.ts 除外，因 Bun-only）

### 通信安全
- Bearer token 认证（COMMHUB_AUTH_TOKEN）
- CORS 白名单（COMMHUB_CORS_ORIGINS）
- 建议防火墙 IP 白名单（9200 端口）
- SSE 连接认证（同 Bearer token）

### 配置安全
- `~/.anet/config.json` 中的 token 存储在用户 home 目录（权限 600）
- 项目 `.anet/config.json` 不应包含 token（放全局配置）
- `.anet/` 应加入 `.gitignore` 防止提交

### 运行时安全
- SQLite WAL 模式 + busy_timeout 防并发冲突
- inbox 消息 ACK 机制防重复处理
- 心跳机制检测 zombie session
- graceful shutdown 上报 offline

---

## 9. 通信协议流程图

### Agent 注册和任务处理

```
Agent                    CommHub Server              Hub/指挥室
  │                          │                          │
  │  report_status(idle)     │                          │
  ├─────────────────────────►│                          │
  │                          │                          │
  │  SSE /events/:alias      │                          │
  ├─────────────────────────►│ (长连接保持)               │
  │                          │                          │
  │                          │  send_task(alias,task)   │
  │                          │◄─────────────────────────┤
  │                          │                          │
  │  SSE: new_task event     │                          │
  │◄─────────────────────────┤                          │
  │                          │                          │
  │  get_inbox(alias)        │                          │
  ├─────────────────────────►│                          │
  │  [{id,content,from}]     │                          │
  │◄─────────────────────────┤                          │
  │                          │                          │
  │  ack_inbox(id)           │                          │
  ├─────────────────────────►│                          │
  │                          │                          │
  │  (处理任务...)            │                          │
  │                          │                          │
  │  send_task(hub,result)   │                          │
  ├─────────────────────────►│  SSE: new_task           │
  │                          │─────────────────────────►│
  │                          │                          │
  │  report_status(idle)     │  (每 3 分钟心跳)          │
  ├─────────────────────────►│                          │
```

### 三种接入方式对比

```
方式 A: Claude Code + Channel（最优）
  Agent ←SSE Push→ CommHub    实时，零延迟

方式 B: SDK Agent（编程）
  Agent ←SSE Long→ CommHub    实时，代码控制

方式 C: OpenCode + Poller（兜底）
  Poller ←SSE→ CommHub → tmux send-keys → Agent
```

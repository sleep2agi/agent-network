# @sleep2agi/agent-network 架构设计

> CLI 名：`anet` | npm 包名：`@sleep2agi/agent-network`
> 当前 stable（v0.8.2，2026-05-12 通过 npm `latest` tag 发布；尚无对应 git tag）：agent-network CLI v2.1.7 | commhub-server v0.8.0 | agent-node v2.3.0 | agent-network-dashboard v0.4.2
> 本文最早写于 V2 早期（CLI v0.0.x），部分目录结构 / runtime 命名描述仍保留作为历史背景；最新可执行行为以代码 + [anet.sh](https://anet.sh) 文档为准。

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

### agent-node 三个 runtime（当前 v2.3.0）

agent-node 支持三个 runtime：

| Runtime | 说明 | 模型 |
|------|------|------|
| `claude-agent-sdk`（**默认**） | Anthropic Claude Agent SDK + Anthropic 兼容 API | Claude / MiniMax / DeepSeek / GLM / Kimi / 书生 / 小米 MiMo / OpenRouter 等（完整 provider 表见 [anet.sh / multi-model](https://anet.sh/guide/multi-model)） |
| `codex-sdk` | OpenAI Codex SDK | OpenAI Codex（最新 model id 查官方文档） |
| `claude-code-cli` | Claude Code CLI（要 Claude Pro 订阅） | Claude（通过本地 CLI 调用） |

Profile 中通过 `runtime` 字段选择。早期文档里的 `claude-code` / `codex` / `agent-sdk` 已重命名（doctor `anet doctor --fix` 自动迁移）。

支持的模型列表：
- **MiniMax M2.7** — 低成本自动化
- **书生 Intern-S1-Pro** — 国产大模型
- **Claude** — Anthropic（Sonnet/Opus）
- **OpenAI Codex** — codex-sdk runtime（model id 查 OpenAI 文档）

### 隔离策略

agent-node 启动时使用 `settingSources: []` 隔离 Claude Agent SDK，防止读取用户全局配置：

```typescript
const agent = new Agent({
  model: profile.model,
  settingSources: [],  // 完全隔离，不读 ~/.claude/ 等全局配置
});
```

这确保每个 agent-node 实例独立运行，不受宿主机的 Claude Code 配置影响。

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
| type | | claude-code / sdk |
| hub | | 覆盖全局 hub（跨网络场景） |

---

## 3. CLI 命令详细设计

> **命名约定升级（v0.6+）**：
> - `anet server` → **`anet hub start`** （这里下面整段保留 V2 命名做历史参考）
> - `anet setup` / `anet run` 大部分语义已合并到 `anet init` + `anet login` + `anet node create / start`
> - `--token` 参数 → v0.8 起 `--username` / `--password` + 自动 bootstrap admin
> - `COMMHUB_AUTH_TOKEN` env → v0.8 软废弃（[RFC-001](rfcs/RFC-001-deprecate-commhub-auth-token.md) Phase 2）
>
> 最新命令清单见 [anet.sh/guide/cli](https://anet.sh/guide/cli)。

### `anet server`（V2 命名 → 现 `anet hub start`）

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
| /api/messages | GET | 是 | 查询 inbox 消息（支持按 alias 过滤） |
| /ws/tmux/:name | WS | 是 | tmux 终端流 |

### `anet setup`

配置新 Agent 加入网络。

```bash
anet setup --hub <url> --alias <name> [--type claude-code|sdk]
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

## 5. Channel 插件自动配置 — R221 校准

`anet node start` 检测到 `runtime: "claude-code-cli"` 时，自动确保 Channel 插件可用（[`cli.ts:1482 ensureMcpJson`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L1482)）：

1. 从 npm 包 (`dist/src/node-server.js` 优先 / `src/node-server.ts` 兜底) 复制到 `{项目}/.anet/node-server.js`（**注意：是 `.js` 不是 `.ts`** —— [R216 chain](https://github.com/sleep2agi/agent-network/issues/10#issuecomment-4438192170)）
2. 安装依赖（`@modelcontextprotocol/sdk ^1.12.0` 通过 `bun install`）
3. 写入 `.mcp.json`：`commhub → .anet/node-server.js`（cli.ts:1548）

```
{项目}/
├── .mcp.json                # {"mcpServers":{"commhub":{"type":"stdio","command":"bun","args":[".anet/node-server.js"]}}}
└── .anet/
    ├── node-server.js       # Channel 插件（MCP server + SSE 长连接）
    └── package.json         # @modelcontextprotocol/sdk ^1.12.0
```

已配置过且内容一致直接跳过（compare-by-content：`if (src !== dst) writeFileSync(...)`，cli.ts:1517-1520）。`anet init project` 也做同样的事（另外还写 CLAUDE.md）。

R221 校准：原 doc 写「`runtime: "claude-code"`」+「`.anet/node-server.ts`」+「`.mcp.json args:[".anet/node-server.ts"]`」三处都是 V2 早期命名/文件名，当前 runtime name 是 `claude-code-cli`（[RuntimeName type cli.ts:140](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L140)），落盘文件名是 `.js`。

---

## 6. 与现有包的关系 — R221 校准（v0.8 实际 4 包）

verify monorepo `find . -name "package.json" -not -path "*/node_modules/*"`：

```
@sleep2agi/agent-network          CLI + Client SDK 入口 + Server 编程入口 (anet/)
  ├── bin/cli.ts                   # anet 命令 (39 commands per package.json)
  ├── src/client.ts                # CommHub client (`new CommHub(...)`)
  └── src/server.ts                # 动态 import ../../server/src/index.ts

@sleep2agi/agent-node              Agent 运行时 (claude-agent-sdk / codex-sdk / claude-code-cli)
  └── src/cli.ts                   # agent-node 命令 (npx-spawn 给 anet node start)

@sleep2agi/commhub-server          CommHub backend (bun-only, Streamable HTTP + SSE + SQLite WAL)
  ├── src/index.ts                 # Bun.serve 主入口
  └── src/tools.ts                 # 17 MCP tools (4 agent + 13 hub)

@sleep2agi/agent-network-dashboard Next.js UI (独立部署, R220 chain)
```

⚠ **`@sleep2agi/commhub-sdk` 不是独立 npm 包** —— Client SDK (`CommHub` class) 只在 `agent-network/src/client.ts`，通过 `import { CommHub } from '@sleep2agi/agent-network'` 使用。原 doc「三个包共存」声明 `@sleep2agi/commhub-sdk` 错。

代码复用关系（实际）：
- `agent-network/src/client.ts` → 唯一 Client SDK source
- `agent-network/src/server.ts` → 动态 import `server/src/index.ts`（开发期 monorepo path；npm 包不直接 ship server，靠 `anet hub start` 通过 bunx 拉 `@sleep2agi/commhub-server` PIN 版）
- `agent-network/bin/cli.ts` → 引用 client.ts；CommHub Server 不在 dist，靠 `anet hub start` 拉
- `agent-node/src/cli.ts` → agent 进程入口，依赖 `@anthropic-ai/claude-agent-sdk` (regular dep) + `@openai/codex-sdk` (optional peer dep) — R212 chain

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

> **v0.8 安全升级（2026-05 对齐）**：本节原写于 V2 era，鉴权部分已升级到 [RFC-001 Phase 2](rfcs/RFC-001-deprecate-commhub-auth-token.md) 落地的双 token 体系：utok_（用户级，登录获取）+ ntok_（节点级，agent 绑定单个 network）。`COMMHUB_AUTH_TOKEN` 全局 master token 软废弃（仅 `/api/*` 只读 + deprecation warning），v1.0 完全移除。完整 v0.8 安全模型见 [anet.sh/concepts/security](https://anet.sh/concepts/security) 和根级 [`SECURITY.md`](../SECURITY.md)。

### 代码安全
- 零硬编码 IP/token/key（全部通过 config 或 env）
- npm 发布前自动 grep 检查敏感信息
- dist/ 只包含 minified JS，不含 .ts 源码（server.ts 除外，因 Bun-only）

### 通信安全（v0.8 现状）
- **双 token 鉴权**：utok_（用户）+ ntok_（节点 × 网络），自动 bootstrap admin utok_
- **密码强度**：≥ 8 字符 + 弱密码字典拦截（首次 bootstrap admin 例外允许 ≥ 4）
- **服务端网络绑定**：ntok_ 在 hub 锁住 network_id，客户端无法跨 network
- CORS 白名单（COMMHUB_CORS_ORIGINS）
- 建议防火墙 IP 白名单（9200 端口）
- SSE 连接同样用 utok_/ntok_ 鉴权（401 自动 reload token）
- ⚠️ 旧 `COMMHUB_AUTH_TOKEN` 仅 `/api/*` 读类兼容（v1.0 移除）

### 配置安全
- `~/.anet/server/admin-utok.json` 自动 chmod 600（v0.8 bootstrap）
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

方式 C: SDK Agent + anet run（编程/自动化）
  Agent ←SSE Long→ CommHub    代码控制，自定义 handler
```

---

## 10. Web Dashboard

> **R220 校准（2026-05-13）**：本节的「内置轻量 UI」+「`http://YOUR_IP:9200/dashboard`」是 V2 早期设计草稿，**v0.8 实际未实现** —— commhub-server `server/src/index.ts` 没有 `/dashboard` 路由（[全 source grep `/dashboard` 0 hit](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)）。当前**唯一 Dashboard 是独立的 Next.js 包 `@sleep2agi/agent-network-dashboard`**，通过 `anet hub dashboard` 子命令拉起（[`agent-network/bin/cli.ts:2223-2261`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L2223)，默认端口 3000，PIN 版本 `0.4.5-preview.1`）。最新部署方式见 [anet.sh/guide/dashboard](https://anet.sh/guide/dashboard)。下面的「两种 Dashboard」/「内置 UI 设计原则」/「实现方案」/「HTML 结构」全是 V2 设计草稿，仅保留历史背景，**当前不适用**。

### 当前 (v0.8) Dashboard

| 维度 | 实际值 |
|------|------|
| 技术栈 | Next.js + Vercel-friendly build |
| npm 包 | `@sleep2agi/agent-network-dashboard` |
| 启动 | `anet hub dashboard` (npx-spawn pin 版) |
| 默认地址 | `http://127.0.0.1:3000`（`--ip 0.0.0.0` 暴露 LAN） |
| 认证 | 浏览器 cookie 透传 `utok_` |
| Hub 连接 | `NEXT_PUBLIC_COMMHUB_URL` env 注入 hub URL |

### ~~两种 Dashboard~~（V2 设计草稿，未实现）

| ~~Dashboard~~ | ~~技术栈~~ | ~~部署~~ | ~~地址~~ |
|---|---|---|---|
| ~~内置轻量 UI~~ | ~~纯 HTML + vanilla JS~~ | ~~内嵌 `anet server`~~ | ~~`http://YOUR_IP:9200/dashboard`~~ |
| 独立 Dashboard | Next.js + Vercel | 独立部署 | 见上「当前 Dashboard」表 |

### ~~内置轻量 UI 设计原则~~（V2 设计草稿，未实现）

- ~~纯 HTML + CSS + vanilla JS，零框架~~
- ~~内嵌到 `anet server`，不需要额外部署~~
- ~~SSE 实时更新，不用 WebSocket~~
- ~~一个 HTML 文件搞定~~

### 访问方式（当前 v0.8）

```bash
anet hub start            # 起 commhub-server (9200)
anet hub dashboard        # 起独立 Dashboard (Next.js, 3000)

# 浏览器访问 http://127.0.0.1:3000，用 admin/anethub 登录
```

### 页面功能

**节点列表（主视图）**

```
┌─────────────────────────────────────────────┐
│  Agent Network Dashboard         ● 17 online │
├─────────────────────────────────────────────┤
│                                             │
│  🟢 指挥室      working   硅谷ECS   3s ago  │
│  🟢 通信龙      idle      硅谷ECS   15s ago │
│  🟢 开发马      working   硅谷ECS   2m ago  │
│  🔵 大猫        idle      96GB      1m ago  │
│  🔵 P站MiniMax马 idle     Paper     5m ago  │
│  ⚪ VL牛        offline   A100      2h ago  │
│                                             │
│  [发任务]  [广播]  [刷新]                     │
└─────────────────────────────────────────────┘
```

节点颜色：
- 🟢 绿色：Channel SSE 连接（实时）
- 🔵 蓝色：Poller 模式（近实时）
- 🟡 黄色：最近有活动但无 SSE
- ⚪ 灰色：offline

**消息流（实时）**

```
┌─────────────────────────────────────────────┐
│  Message Stream                    [暂停]    │
├─────────────────────────────────────────────┤
│  15:00:42  指挥室 → 通信龙: 计时测试        │
│  15:00:59  通信龙 → 指挥室: 收到！延迟17s    │
│  15:01:05  指挥室 → 大猫: SSE Poller测试     │
│  15:01:06  [SSE] 大猫 收到推送               │
└─────────────────────────────────────────────┘
```

通过 SSE `/events/dashboard` 订阅所有事件。

**任务管理（简易）**

- 发任务：选目标 alias + 输入内容 + 优先级 → POST /api/task
- 广播：输入内容 → POST /api/broadcast

### ~~实现方案~~（V2 设计草稿，未实现）

::: warning 本节不要照抄实现
此段「Server 端新增 `/dashboard` 路由」是 V2 早期设计草稿，**v0.8 不打算这么做** —— commhub-server 维持 backend-only 不内嵌 UI，独立 Next.js Dashboard 已经覆盖所有用例。如有人考虑加内置 UI，先开 RFC 讨论必要性。
:::

~~Server 端新增一个路由：~~

~~```typescript
// GET /dashboard → 返回内嵌 HTML
if (url.pathname === "/dashboard") {
  return new Response(DASHBOARD_HTML, { ... });
}
```~~

### ~~HTML 结构~~（V2 设计草稿，未实现）

省略 V2 设计草稿 HTML 模板（深色主题 + vanilla JS + SSE poll）—— 实际 Dashboard 用 Next.js + React，看 [`@sleep2agi/agent-network-dashboard` 源码](https://github.com/sleep2agi/agent-network-dashboard)。

### 原设计声明"不做的事"（v0.8 阶段实际已全部超越）

> **更新（2026-05-12 v0.8.2 对齐）**：以下条目是 V2 早期写设计文档时的取舍声明，但 Dashboard 在 v0.6 ~ v0.8.2 已经完整建成，下面这些"不做"全部反过来了。最新 Dashboard 行为见 [anet.sh/guide/dashboard](https://anet.sh/guide/dashboard)。

- ~~不做用户认证（复用 COMMHUB_AUTH_TOKEN，URL 带 token 参数）~~ → **已做**：浏览器 cookie 透传 + utok_ 鉴权，COMMHUB_AUTH_TOKEN 软废弃
- ~~不做 session 管理（只读展示 + 发任务）~~ → **已做**：完整任务面板 + ChatPanel + 节点详情
- ~~不做历史查询（只显示最近 100 条）~~ → **已做**：tasks/messages/audit-log 三类查询
- ~~不做移动端适配（桌面浏览器即可）~~ → **已做**：N站马 polish loop 中加了 mobile audit（banner 让位 hamburger / UserBar 图标化）

### 优先级

Dashboard 已成为 v0.8 主线功能（package `@sleep2agi/agent-network-dashboard@0.4.2` stable / `0.4.5-preview.1` preview channel）。

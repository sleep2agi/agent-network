# Channel 通信方案设计 v1.0

> 目标：让任意 runtime（Claude Code / agent-node）的 Agent 都能接入 Telegram / WeChat / Feishu 等 Channel，支持文本、图片、文件的双向通信。

## 1. 核心概念

### Channel
一个 Channel 是一个消息通道实例，连接外部 IM 平台（Telegram/WeChat/Feishu）和 Agent。

```
Channel = {
  name: string          // 唯一标识，如 "tg-intern"
  type: "telegram" | "wechat" | "feishu"
  credentials: { ... }  // bot token 等
  access: { ... }       // 谁能发消息
  state: "running" | "stopped" | "error"
}
```

### 消息模型

```typescript
interface ChannelMessage {
  id: string
  channel: string           // channel name
  type: "text" | "image" | "file" | "voice"
  content: string           // 文本内容 / 文件描述
  attachments: Attachment[]  // 附件列表
  from: {
    platform: string        // "telegram" | "wechat" | "feishu"
    user_id: string
    username: string
  }
  reply_to?: string         // 回复的消息 ID
  timestamp: string
}

interface Attachment {
  type: "image" | "file" | "voice"
  path: string              // 本地文件路径（下载后）
  url?: string              // 原始 URL
  mime_type?: string
  size?: number
  filename?: string
}
```

### 回复模型

```typescript
interface ChannelReply {
  channel: string
  chat_id: string
  text?: string
  files?: string[]          // 本地文件路径，自动上传
  reply_to?: string         // 引用消息 ID
}
```

## 2. 两种接入模式

### 模式 A: 直连（Claude Code runtime）

Claude Code 通过原生 plugin 机制加载 channel。

```
Telegram Bot API ←→ Channel Plugin（MCP stdio）←→ Claude Code
```

- 图片下载到本地，路径通过 meta 传给 Claude
- 回复通过 MCP tool（reply/reply_image）发出
- 配置放 `{workpath}/.anet/nodes/<node-id>/channels/<type>/`
- `anet start/resume` 自动检测并加 `--channels` 参数

**优势**：原生支持，图片/文件/权限全套，无额外进程。

### 模式 B: 内置 Channel（agent-node runtime）

agent-node 内置 channel 支持，直接连接 Bot API。

```
Telegram Bot API ←→ agent-node（内置 channel 模块）←→ Codex/Claude SDK
```

- agent-node 启动时检测 `--channel` 参数，初始化对应 channel
- 图片下载到本地 inbox/，路径传给 SDK 处理
- SDK 回复后，agent-node 通过 Bot API 发出
- 同时可连 CommHub（agent 间文本通信）

**优势**：单进程，agent-node 统一管理。

## 3. 配置体系

### 3.1 直连模式配置

```
{workpath}/.anet/nodes/<node-id>/channels/
└── telegram/
    ├── .env              # TELEGRAM_BOT_TOKEN=xxx
    ├── access.json       # 权限控制
    └── inbox/            # 接收的附件
```

**access.json**：
```json
{
  "dmPolicy": "allowlist",
  "allowFrom": ["7612221352"],
  "groups": {
    "-100123456": { "triggerOnMention": true }
  },
  "pending": {}
}
```

### 3.2 桥模式配置

```
~/.anet/channel-hub/
└── tg-intern/
    ├── .env              # TELEGRAM_BOT_TOKEN=xxx
    ├── access.json       # 权限控制
    ├── config.json       # 运行配置
    └── inbox/            # 接收的附件
```

**config.json**：
```json
{
  "type": "telegram",
  "alias": "小明",
  "runtime": "codex",
  "model": "gpt-5.4",
  "commhub": true,
  "hub": "http://127.0.0.1:9200",
  "maxTurns": 10,
  "sandboxMode": "danger-full-access"
}
```

### 3.3 配置继承

```
config.json 字段  →  ~/.anet/config.json fallback（hub, token）
access.json       →  无继承，每个 channel 独立
.env              →  无继承，每个 channel 独立
```

## 4. 附件处理

### 4.1 接收附件

1. Channel 收到图片/文件消息
2. 下载到 `inbox/{msg_id}_{filename}`
3. 消息体包含 `attachments[].path` 指向本地文件
4. Agent 通过 Read tool 读取文件

### 4.2 发送附件

1. Agent 生成文件（图片/PDF/代码等）
2. 回复时指定 `files: ["/abs/path.png"]`
3. Channel 自动上传到对应平台

### 4.3 清理策略

- inbox/ 文件 7 天自动清理（可配置）
- 或手动 `anet channel clean <name>`

## 5. 权限控制

### 5.1 白名单模式（默认）

```json
{
  "dmPolicy": "allowlist",
  "allowFrom": ["user_id_1", "user_id_2"]
}
```

只有白名单内的用户才能触发 agent。

### 5.2 配对模式

```json
{
  "dmPolicy": "pairing",
  "pending": {},
  "allowFrom": []
}
```

新用户发消息时进入 pending，需要管理员确认（`anet channel approve <name> <user-id>`）。

### 5.3 群组支持

```json
{
  "groups": {
    "-100123456": {
      "triggerOnMention": true,
      "allowAll": false,
      "allowFrom": ["admin_id"]
    }
  }
}
```

群组内只在 @bot 时触发，或只响应特定用户。

## 6. 生命周期

### 6.1 状态机

```
stopped → starting → running → stopping → stopped
                 ↓                    ↓
               error              error
```

### 6.2 CLI 命令

```bash
# 创建 channel
anet channel add telegram <node-id> [options]
anet channel add telegram <node-id> --bot-token xxx --allow uid

# 查看
anet channel ls [node-id]

# 桥模式管理
anet bridge add <name> --type telegram --bot-token xxx --allow uid --alias 小明
anet bridge start <name>
anet bridge stop <name>
anet bridge ls
anet bridge logs <name>

# 权限管理
anet channel approve <name> <user-id>
anet channel deny <name> <user-id>

# 清理
anet channel clean <name>              # 清理 inbox 旧文件
```

### 6.3 自动重连

Channel 断开后自动重连，指数退避（3s → 6s → 12s → ... → 60s max）。

### 6.4 日志

```
~/.anet/channel-hub/<name>/logs/
├── 2026-04-09.log
└── ...
```

或直连模式：
```
{workpath}/.anet/nodes/<node-id>/channels/<type>/logs/
```

## 7. 多 Channel 支持

一个 Agent 可以同时连多个 Channel：

```json
// config.json
{
  "channels": ["server:commhub"],
  "env": {
    "TELEGRAM_STATE_DIR": ".anet/nodes/指挥室/channels/telegram"
  }
}
```

或 agent-node：
```bash
npx @sleep2agi/agent-node --alias 小明 \
  --channel telegram:~/.anet/channel-hub/tg-intern \
  --channel wechat:~/.anet/channel-hub/wx-bot
```

CommHub + Telegram + WeChat 三路同时在线。

## 8. 平台适配

### Telegram
- 库：grammy
- 消息获取：Bot long polling
- 图片：getFile → download
- 回复：sendMessage / sendPhoto / sendDocument
- 群组：mention 触发

### WeChat
- 库：ClawBot ilink API
- 消息获取：webhook / polling
- 图片：URL 直接下载
- 回复：text / image 接口
- 群组：@ 触发

### Feishu
- 库：Feishu Open API
- 消息获取：event subscription
- 图片：download API
- 回复：reply message API
- 群组：@ 触发

### 抽象层

```typescript
interface ChannelAdapter {
  type: string
  connect(config: ChannelConfig): Promise<void>
  disconnect(): Promise<void>
  onMessage(handler: (msg: ChannelMessage) => void): void
  reply(reply: ChannelReply): Promise<void>
  downloadAttachment(fileId: string, dest: string): Promise<string>
}
```

每个平台实现这个接口，agent-node 只跟接口交互。

## 9. 实现优先级

### P0（先做）
1. 直连模式 Telegram — `anet channel add telegram <node-id>`
2. 桥模式 Telegram — `anet bridge add/start`
3. agent-node `--channel telegram:path` 参数

### P1（后做）
4. WeChat 适配
5. Feishu 适配
6. 多 channel 并行
7. 群组支持

### P2（再后做）
8. 配对模式权限
9. 日志系统
10. inbox 自动清理
11. `anet bridge logs/stop` 命令

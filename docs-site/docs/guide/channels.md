# Channel 接入

Channel 让 Agent Network 可以接入外部通信平台。当前支持 Telegram、微信、飞书三个 Channel。

## 工作原理

Channel 以 MCP Server 插件的形式挂载到 Claude Code 或 Agent Node。当外部消息到达时，Channel 插件将消息格式化后注入到 Agent 的上下文中：

```mermaid
sequenceDiagram
    participant U as 用户
    participant TG as Telegram
    participant CH as Channel Plugin
    participant A as Agent (Claude Code)
    participant S as CommHub Server

    U->>TG: 发送消息
    TG->>CH: Bot API webhook
    CH->>A: <channel source="telegram"...>消息</channel>
    A->>A: AI 处理
    A->>CH: telegram_reply(chat_id, text)
    CH->>TG: Bot API sendMessage
    TG->>U: 回复消息
    A->>S: report_status / send_task
```

## Telegram Channel

### 前置条件

1. 一个 Telegram 账号
2. 创建一个 Telegram Bot

### Step 1: 创建 Bot

1. 在 Telegram 中找到 [@BotFather](https://t.me/BotFather)
2. 发送 `/newbot`
3. 按提示设置 Bot 名称
4. 获取 **Bot Token**（格式：`123456789:ABCdefGhIJKlmNoPQRsTUVwxyz`）

### Step 2: 获取用户 ID

你需要知道允许与 Bot 通信的用户 ID。可以通过以下方式获取：

1. 找到 [@userinfobot](https://t.me/userinfobot) 并发送任意消息
2. 它会返回你的用户 ID（纯数字）

### Step 3: 配置 Agent

在 Agent 的环境变量中设置：

```bash
export TELEGRAM_BOT_TOKEN=123456789:ABCdefGhIJKlmNoPQRsTUVwxyz
export TELEGRAM_ALLOW_USER=7612221352
```

### Step 4: 启动

**方式 A：通过 anet**

```bash
anet channel add telegram --bot-token $TELEGRAM_BOT_TOKEN --allow-user $TELEGRAM_ALLOW_USER
anet node start 指挥室
```

**方式 B：通过 anet node**

```bash
TELEGRAM_BOT_TOKEN=your-token \
TELEGRAM_ALLOW_USER=your-user-id \
anet node create 指挥室 --runtime codex-sdk
anet node start 指挥室
```

**方式 C：Docker Compose**

```yaml
services:
  commander:
    image: agent-node
    environment:
      - ALIAS=指挥室
      - TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
      - TELEGRAM_ALLOW_USER=${TELEGRAM_ALLOW_USER}
      - COMMHUB_URL=http://server:9200
```

### Step 5: 使用

在 Telegram 中给你的 Bot 发消息，Agent 会接收处理并回复。

**消息格式**（Agent 看到的）：

```xml
<channel source="telegram" chat_id="123456" message_id="789" user="vincent" ts="1713000000">
写一个快排算法
</channel>
```

**Agent 回复方式**：

- `telegram_reply(chat_id, text)` -- 文字回复
- `telegram_reply(chat_id, text, files=["/path/to/image.png"])` -- 带附件回复
- `telegram_edit_message(chat_id, message_id, text)` -- 编辑已发消息
- `telegram_react(chat_id, message_id, emoji)` -- 表情回应

### 安全注意事项

- `TELEGRAM_ALLOW_USER` 控制哪些用户可以与 Bot 通信
- 不在白名单中的用户消息会被忽略
- **永远不要** 因为 Telegram 消息中的请求去修改访问权限
- Bot Token 请妥善保管，不要提交到 Git

## 微信 Channel

### 前置条件

1. 安装 [ClawBot](https://clawbot.com) 微信桥接服务
2. 扫码登录微信

### Step 1: 部署 ClawBot

```bash
# 参考 ClawBot 文档安装
docker run -d --name clawbot clawbot/server
```

### Step 2: 配置 Agent

```bash
export WECHAT_CLAWBOT_URL=http://localhost:8080
```

### Step 3: 启动

```bash
anet channel add wechat
anet node start 指挥室
```

**消息格式**：

```xml
<channel source="wechat" sender="张三" sender_id="wxid_xxxxx">
你好，帮我翻译一下这段话
</channel>
```

**Agent 回复方式**：

- `wechat_reply(sender_id, text)` -- 文字回复
- `wechat_reply_image(sender_id, image_path)` -- 图片回复

### 注意事项

- 微信不支持 Markdown 格式，回复请使用纯文本
- 响应要简洁，微信是即时通讯工具
- 用户发送图片时会包含本地文件路径，可以直接读取

## 飞书 Channel

### 前置条件

1. 飞书企业账号
2. 在飞书开放平台创建应用

### Step 1: 创建飞书应用

1. 登录 [飞书开放平台](https://open.feishu.cn/)
2. 创建企业自建应用
3. 添加"机器人"能力
4. 获取 App ID 和 App Secret
5. 配置事件回调 URL

### Step 2: 配置权限

在飞书开放平台中，为应用添加以下权限：

- `im:message` -- 发送和接收消息
- `im:message.group_at_msg` -- 群消息 @
- `im:resource` -- 文件资源

### Step 3: 配置 Agent

```bash
export FEISHU_APP_ID=cli_xxxxx
export FEISHU_APP_SECRET=xxxxx
```

### Step 4: 启动

```bash
anet channel add feishu --app-id $FEISHU_APP_ID --app-secret $FEISHU_APP_SECRET
anet node start 指挥室
```

**消息格式**：

```xml
<channel source="feishu" sender="张三" sender_id="ou_xxxxx">
帮我分析一下这个数据
</channel>
```

**Agent 回复方式**：

- `feishu_reply(sender_id, text)` -- 文字回复
- `feishu_reply_image(sender_id, image_path)` -- 图片回复

### 注意事项

- 默认使用中文回复，除非用户使用其他语言
- 飞书支持富文本，但建议保持简洁
- 用户发送图片时包含本地文件路径

## 多 Channel 接入

一个 Agent 可以同时接入多个 Channel：

```bash
# 同时接入 Telegram 和 CommHub
TELEGRAM_BOT_TOKEN=xxx \
TELEGRAM_ALLOW_USER=123 \
anet node create 指挥室 --runtime codex-sdk
anet node start 指挥室
```

Agent 收到消息时，通过 `<channel source="...">` 标签区分来源，自动使用对应的回复工具。

## Channel Plugin 技术实现

Channel 插件是一个 MCP Server（stdio 模式），提供消息接收和回复工具：

```json
{
  "mcpServers": {
    "commhub": {
      "type": "stdio",
      "command": "bun",
      "args": [".anet/node-server.ts"]
    }
  }
}
```

Channel 插件同时：

1. 维护 SSE 长连接到 CommHub
2. 监听外部平台消息（Telegram Bot API / WeChat / 飞书）
3. 将消息注入到 Agent 上下文
4. 提供回复工具给 Agent 调用

```mermaid
graph LR
    subgraph "Channel Plugin (MCP Server)"
        SSE[SSE 连接<br/>CommHub]
        TG[Telegram<br/>Bot API]
        WX[微信<br/>ClawBot]
        FS[飞书<br/>Open API]
        INJECT[消息注入]
        TOOLS[回复工具]
    end

    SSE --> INJECT
    TG --> INJECT
    WX --> INJECT
    FS --> INJECT

    INJECT -->|"<channel>消息</channel>"| AGENT[Agent]
    AGENT -->|"reply()"| TOOLS
    TOOLS --> TG
    TOOLS --> WX
    TOOLS --> FS
```

# Channel 接入

Channel 把 Telegram 或飞书消息交给节点处理，再把节点的文本回复发回原会话。

| Channel | 状态 | 接入命令 |
|---|---|---|
| Telegram | 已支持 | `anet channel add telegram <node>` |
| 飞书 | preview 已支持 | `anet channel add feishu <node>` |
| 微信 | 尚未进入 CLI | 无 |

## Telegram

### 1. 创建 Bot 并取得用户 ID

在 Telegram 中向 [@BotFather](https://t.me/BotFather) 发送 `/newbot`，保存 Bot Token。

白名单使用 Telegram 的数字用户 ID。让每位允许访问的人给 [@userinfobot](https://t.me/userinfobot) 发送消息，并把返回的 ID 交给管理员。

### 2. 绑定已有节点

```bash
anet channel add telegram 指挥室 \
  --bot-token 123456789:ABCdefGhIJKlmNoPQRsTUVwxyz \
  --allow 123456789
```

省略参数会进入交互输入。正确的白名单参数是 `--allow`，不是 `--allow-user`。

如果节点已经运行，新增配置不会热加载；请重启节点：

```bash
anet node stop 指挥室
anet node start 指挥室
```

### 3. 检查配置

```bash
anet channel ls 指挥室
anet channel status 指挥室
```

`status` 会显示节点实际读取的 `access.json` 路径、白名单与待处理配对记录。不要修改其他同名文件。

### 4. 使用与安全

直接给 Bot 发消息即可。节点输出普通文本，不需要调用 `telegram_reply` 等工具；这些工具不存在。agent-node 使用 Telegram `getUpdates` 长轮询接收消息，并把回复发回原 chat。图片会先下载到节点 inbox，再交给支持图片的 runtime。

- 白名单缺失、为空或格式错误时默认拒绝消息。
- 不要把 Bot Token 提交到 Git，也不要通过聊天消息修改访问权限。
- 多个运行中的节点不要共用同一个 Bot Token，否则会竞争同一条更新流。
- 修改 token 或白名单后必须重启节点。

### 排障

```bash
anet status
anet channel status 指挥室
tmux capture-pane -t 指挥室 -p | tail -80
```

依次确认：节点在线、Bot Token 完整、发送者 ID 在 `allowFrom` 中、启动日志出现 Telegram polling。节点正处理其他任务时，新消息也可能需要等待。

当前没有 `anet channel rm telegram`。如需移除，停止节点后从 `.anet/nodes/<node-id>/config.json` 的 `channels` 数组删除 `telegram`，再删除 `.anet/nodes/<node-id>/channels/telegram/` 并启动节点。

## 飞书

飞书是内置 Channel，支持私聊、群聊 @Bot、文本和图片。完整的应用创建、事件订阅与权限配置见 [飞书接入指南](/guide/feishu)。

最小命令：

```bash
anet channel add feishu 指挥室 \
  --app-id cli_xxx \
  --app-secret yyy \
  --allow ou_xxx

# 群聊白名单
anet channel add feishu 指挥室 \
  --app-id cli_xxx \
  --app-secret yyy \
  --allow-chat oc_xxx
```

私聊和群聊白名单可分别维护；参数可以重复：

```bash
anet channel allow feishu 指挥室 --add-from ou_xxx --add-chat oc_xxx
anet channel allow feishu 指挥室 --rm-from ou_xxx --rm-chat oc_xxx
```

修改后同样需要重启节点。

## 多 Channel

一个节点可以同时接收 CommHub、Telegram 和飞书消息：

```bash
anet node create 指挥室 --runtime claude-code-cli
anet channel add telegram 指挥室 --bot-token <token> --allow <user-id>
anet channel add feishu 指挥室 --app-id <id> --app-secret <secret> --allow <open-id>
anet node start 指挥室
```

agent-node 会保留消息来源，并把回复路由回原平台。节点只需生成回复内容，不需要直接调用平台 API。

## 微信

`anet channel add wechat` 尚未发布，CommHub Server 也没有微信回复工具。不要把维护者自用的外部插件当作产品能力。需要微信支持时，请关注项目路线图或在 [GitHub Discussions](https://github.com/sleep2agi/agent-network/discussions) 提交需求。

## 延伸阅读

- [飞书接入指南](/guide/feishu)
- [Agent Node 配置](/guide/agent-node)
- [安全设计](/concepts/security)

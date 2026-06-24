# 飞书 channel quickstart（claude-agent-sdk runtime）

把 anet 节点接上飞书，让飞书用户跟 agent 直接对话。对应 [RFC-020](../../docs/rfcs/RFC-020-im-platform-integration.md) 的第一刀 / GitHub issue [#179](https://github.com/sleep2agi/agent-network/issues/179)。

> **状态（v0.13 alpha）**：claude-agent-sdk runtime 私聊 + 群 @bot 收发文本与图片可用。完整 commhub-gateway / Dashboard 透传是后续 PR。

## 前置

1. **飞书自建应用**：在 [开放平台](https://open.feishu.cn) 建一个「企业自建应用」，启用机器人能力。
2. **权限**（应用能力 → 权限管理）：`im:message:send_as_bot`、`im:message`、`im:resource`。
3. **事件订阅**：选 **WebSocket 模式**，订阅 `im.message.receive_v1`（仅此一个）。
4. **发布版本** + 等管理员 approve。无需公网 IP、无需 webhook URL、无需 Encrypt Key。
5. 复制 **App ID** + **App Secret**（凭证 & 基本信息页）。

## 安装 + 绑定

需要 anet 节点已存在；如未创建：

```bash
anet node create <node-name> --runtime claude-agent-sdk
```

绑定飞书 channel：

```bash
anet channel add feishu <node-name> \
  --app-id   cli_xxxxxxxxxxxxxx \
  --app-secret yyyyyyyyyyyyyyyyy \
  --allow    ou_<your-open-id>            # 允许私聊的 open_id
  --allow-chat oc_<group-chat-id>         # 可选：允许群聊的 chat_id
```

不带 flags 进交互模式：

```bash
anet channel add feishu <node-name>
```

写入 `.anet/nodes/<node-name>/channels/feishu/`：

| 文件 | 内容 |
|---|---|
| `.env` (chmod 600) | `FEISHU_APP_ID` + `FEISHU_APP_SECRET` |
| `access.json` | `{allowFrom: [open_id], allowChats: [chat_id]}` |

## 启动

```bash
anet node start <node-name>
```

agent-node 启动时检测 `channels: ["feishu", ...]` → fork 飞书 bridge worker（独立子进程，通过 IPC 跟 agent-node 通信）→ bridge 跟飞书建 WebSocket 长连接。

确认 worker 路径：默认走 `dist/src/im/feishu/worker.js`（agent-network 安装后即有）。如需覆盖：

```bash
export ANET_FEISHU_WORKER_PATH=/path/to/your/worker.js
```

启动 log 应出现：

```
[agent-node] channels: feishu(/path/.anet/nodes/<node-name>/channels/feishu)
[agent-node] [feishu] forked worker (pid 12345) for ... via ...
[feishu:worker] bridge online — node=<node-name> dir=... ipc=yes
```

## 触发策略

- **私聊**：`sender.open_id ∈ allowFrom` → 触发。
- **群聊**：默认 `groupPolicy: mention` —— 只有 **@bot** 才触发，普通群消息忽略（防群噪音）。`@bot` 通过比对 `mentions[].id.open_id` 与 bot 自己的 `open_id`（init 时通过 `/open-apis/bot/v3/info` 拉取）。
- **线程**：bot 回复跟着 `root_id` 进原线程，不污染主频道。

## 出站

- 文本：`adapter.send` 调 `im.message.create`（DM 用 `open_id`，群用 `chat_id`）；存在 `replyToMessageId` / `threadRootId` 则走 `im.message.reply` 保留线程上下文。
- 编辑：`adapter.edit` 调 `im.message.update`（飞书单条消息可编辑 ≤20 次，用于把"⏳ 处理中…"占位提升为正式回复）。
- 图片：传 `imagePath` → 先 `im.image.create` 上传拿 `image_key` → `msg_type: "image"` 发送。

## 故障排查

| 现象 | 排查 |
|---|---|
| 节点启动报 `unsupported channel: feishu` | agent-node 版本太老，升级到含本 PR 的版本 |
| `[feishu] worker path not found` warn | 设 `ANET_FEISHU_WORKER_PATH`，或确认 `@sleep2agi/agent-network` 已安装 + 编译 |
| WSClient 连不上飞书 | App 未 approve / 凭证写错 / 网络问题 — bridge 会自动重连，看 stderr |
| 群里 @bot 不响应 | 1) bot 已加群且有发言权限 2) `access.json` `allowChats` 含目标 chat_id 3) `/open-apis/bot/v3/info` 是否返回有效 open_id |
| 收到回复是 "agent-node M5a placeholder…" | 当前 v0.13 alpha 是 M5a 占位；M5b 替换为真 think() 集成（未 ship 时） |

## 已知限制（第一刀 scope）

- **不进 Dashboard 拓扑** —— 飞书消息不走 commhub task 路径，Dashboard 看不见。完整 commhub-gateway（RFC-020 §2.9 schema 增量）是收尾 PR。
- **agent 不能任意主动推飞书** —— 仅响应入站消息。主动推（`anet im send`）排在 P1.5（RFC §12.9）。
- **仅 claude-agent-sdk runtime** —— claude-code-cli 仍用社区 plugin；codex-sdk / grok-build-acp 后续。

## E2E smoke checklist（测试派单用）

> 测试一律 Docker mock + 派测试号（[[feedback_no_host_test_nodes]] / [[feedback_delegate_testing]]），不连本机 hub、不碰生产 db。Vincent 凭证活体 E2E 由通信龙调度。

- [ ] **L0 环境** — Docker 容器内安装 `@sleep2agi/agent-network` + `@sleep2agi/agent-node`；mock 飞书 WSClient server 可达。
- [ ] **L1 配置** — `anet channel add feishu <test-node>` 落盘 `.env` + `access.json`，`.env` 权限 = 600，`config.json` `channels` 含 `"feishu"`。
- [ ] **L2 启动** — `anet node start <test-node>`，log 出现 `[feishu] forked worker (pid …)` + `bridge online`。
- [ ] **L3 入站文本（DM 白名单内）** — mock 发 `im.message.receive_v1` 私聊文本 → bridge log 收到事件 → agent-node parent log 收到 IPC envelope → 占位回复（M5a 占位 / M5b real reply）回到 mock 发送侧。
- [ ] **L4 入站群 @bot** — mock 发群消息含 mentions[].id.open_id = bot 自身 → 触发；群消息**不** @ bot → ignore。
- [ ] **L5 入站图片** — mock 发 image 消息 → `<channel-dir>/media/img_*.png` 落盘 → `event.content.images = [path]`。
- [ ] **L6 白名单拒绝** — 非白名单 open_id 私聊 → bridge stderr 出 `[feishu:audit] deny from=... — not in allowFrom / allowChats`，不派 IPC。
- [ ] **L7 重连** — mock 断开 WebSocket → bridge 报错 + 自动重连（lark SDK 内置）。
- [ ] **L8 worker 崩溃** — kill bridge worker 进程 → agent-node `[feishu] worker exited code=...` warn，不影响其它 channel。
- [ ] **L9 出站文本** — agent-node 通过 IPC 发 reply → bridge `adapter.send` → mock 收到 `im.message.create` 调用。
- [ ] **L10 出站图片** — agent-node 派带 imagePath 的 reply → bridge upload → `im.message.create` 用 `msg_type: image`。

## 参考

- [RFC-020 IM 兼容层](../../docs/rfcs/RFC-020-im-platform-integration.md)
- [RFC-002 channel-bind-cli](../../docs/rfcs/RFC-002-channel-bind-cli.md)（telegram-bridge 模式前身）
- [issue #179](https://github.com/sleep2agi/agent-network/issues/179)（父 RFC）
- [issue #182](https://github.com/sleep2agi/agent-network/issues/182)（P0 tracker / 后续 commhub schema 增量）
- 社区 [`vansin/claude-code-feishu-channel`](https://github.com/vansin/claude-code-feishu-channel)（SDK 调用层 prior art，RFC §12.6 决策复用）

# RFC-002：节点接入 Telegram 的命令方案

| 字段        | 内容                                   |
| ----------- | -------------------------------------- |
| 状态        | **部分实施** —— P0（`anet channel add telegram`，claude-code-cli runtime）v0.8.2 已 ship；P1-P4 见 §3 分阶段实施，仍 pending (issue #14) |
| 提出        | 2026-05-12                             |
| 作者        | 通信龙 (sleep2agi)                      |
| 拟实施人    | SDK马 / 通信牛                          |
| 目标版本    | P0 已落地 commhub-server v0.8.2；P1-P4 待定（旧的 agent-network v2.2+ 版本号体系已废弃，见 changelog）|
| 讨论        | [#14](https://github.com/sleep2agi/agent-network/issues/14) |

## 摘要

Vincent 提出：对**已经存在的节点**用 `anet` 命令绑定 Telegram，优先 claude-code-cli runtime / 再 claude-agent-sdk / 再 codex-sdk，形成完整方案。

调研发现：
- **claude-code-cli runtime 当前已 work** —— `anet channel add telegram <node-id> --bot-token <tok> --allow <user-id>` 命令在 `agent-network/bin/cli.ts:2685` 已实现，启动时 spawn 的 `claude` 进程通过 `--channels plugin:telegram@claude-plugins-official` 加载官方 Channel plugin。
- **claude-agent-sdk + codex-sdk runtime 当前不支持** —— 这两个 runtime 走 SDK 编程式调用（`@anthropic-ai/claude-agent-sdk` `query()` / `@openai/codex-sdk` `thread.run()`），SDK 本身没有 `--channels plugin` 机制，需要在 **agent-node 包装层**加 Telegram bridge worker。

本 RFC 主要给出两件事：（1）当前 CLI 命令保持不变（已 work）；（2）在 agent-node runtime wrapper 里加一个 `telegram-bridge` worker 让 SDK 模式也能接 Telegram。

## 1. 现状

### 1.1 CLI 命令（已实现）

```bash
# 给已存在节点加 Telegram channel
anet channel add telegram <node-id> --bot-token <tok> --allow <user-id>

# 交互式
anet channel add telegram <node-id>

# 查看节点 channel
anet channel ls [node-id]
```

参考实现：[`cli.ts`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts) —— 搜 `async function channelCommand(`。

效果：
- 在 `.anet/nodes/<node-id>/channels/telegram/` 落两份配置：
  - `access.json` — `{ allowFrom: [user-id, ...], allowChats: [...] }`
  - `.env` — `TELEGRAM_BOT_TOKEN=...`（chmod 600）
- 节点 `config.json` 的 `channels` 数组加 `"telegram"`
- 下次 `anet node start <node-id>` 生效

### 1.2 三种 Runtime 当前接入路径

| Runtime | 当前 Telegram 支持 | 注入机制 | 工程位置 |
|---|---|---|---|
| `claude-code-cli` | ✅ 已 work | spawn `claude` 时加 `--channels plugin:telegram@claude-plugins-official` + `TELEGRAM_STATE_DIR` env | `cli.ts:1750-1760`（spawn 路径）|
| `claude-agent-sdk` | ❌ 不支持 | SDK 没暴露 channels 接口 | agent-node wrapper 缺 bridge |
| `codex-sdk` | ❌ 不支持 | 同上 | agent-node wrapper 缺 bridge |

### 1.3 为什么 SDK runtime 不能复用 plugin

`@anthropic-ai/claude-agent-sdk` 的 `query()` 是编程式 API，调用方控制 prompt 和 response，**没有 plugin/channels hook**。同样 `@openai/codex-sdk` 的 `thread.run()` 也只是 LLM 调用。Telegram bot polling、access 校验、消息路由 这些逻辑必须由**调用方**（即 agent-node wrapper）自己实现。

claude-code-cli 之所以 work，是因为 `claude` CLI 是 Anthropic 官方实现的"应用级"程序，自带 plugin 协议。

## 2. 设计

### 2.1 CLI 命令保持不变

`anet channel add telegram <node-id> ...` 命令对**三种 runtime 都用同一入口** —— 命令落地写 channels 目录这一步对所有 runtime 都生效，差别在**节点启动时怎么消费 channels 配置**。

### 2.2 agent-node 新增 telegram-bridge worker

在 `agent-node/src/channels/telegram-bridge.ts` 加一个 bridge：

```
[Telegram Bot API]
        ↑↓ getUpdates / sendMessage (polling 或 webhook)
[agent-node:telegram-bridge worker]   ← 新增
        ↑ inbound: parsed Telegram update
        ↓ outbound: assistant reply
[agent-node 主 loop]
        ↓ think(content)
[claude-agent-sdk query() / codex-sdk thread.run()]
```

主 loop 启动时检测 `profile.channels.includes("telegram")` && `runtime ∈ {claude-agent-sdk, codex-sdk}` → fork bridge worker，bridge 跟 inbox SSE loop **并行**跑。

bridge 工作流：

1. 读 `~/.anet/nodes/<node-id>/channels/telegram/.env` 拿 `TELEGRAM_BOT_TOKEN`
2. 读 `access.json` 拿 `allowFrom` 白名单
3. polling `getUpdates`（或 webhook）
4. 收到 message：
   - 检查 `update.message.from.id` 是否在 `allowFrom`，否则 ignore + 日志
   - 调主 loop 的 `think(content)` —— 通过内部 channel / queue 转发
5. think 完成 → `Bot.sendMessage(allowFromUserId, reply)`

bridge 复用主 loop 的 `think()` 函数 → 自动支持现有 budget cap (`--max-budget`) / max-turns / settingSources。

### 2.3 配置文件结构（向后兼容）

现状不变 + 加可选 `runtime.json` 元数据：

```
~/.anet/nodes/<node-id>/channels/telegram/
├── access.json          { allowFrom: [user_id, ...], allowChats: [chat_id, ...] }
├── .env                 TELEGRAM_BOT_TOKEN=...
└── runtime.json         { mode: "plugin" | "bridge", auto: true }   ← 可选
```

- `mode: "plugin"` —— claude-code-cli 走 official Channel plugin（现状）
- `mode: "bridge"` —— agent-node 跑自家 bridge worker（SDK 模式）
- `mode` 未指定时由 runtime 自动决定（claude-code-cli → plugin，其他 → bridge）

### 2.4 安全考虑

- `bot-token` 写 `channels/telegram/.env`，chmod 600，**不进 git**；`.gitignore` 已含 `.anet/`
- `allowFrom` 强制白名单：未列出的 `from.id` 直接 ignore + 写 `audit_log`
- bot_token **不上传 hub** —— hub 不存储 bot token，仅在 agent 本机
- `bridge` worker 跟主 loop 同 OS process / 同 user，不引入额外特权

## 3. 分阶段实施

| Phase | 范围 | 工作量 | 状态 |
|---|---|---|---|
| **P0** | claude-code-cli 维持现状 | 0 (已 work) | ✅ |
| **P1** | agent-node 加 `telegram-bridge` worker for `claude-agent-sdk` runtime + test32 docker 套件 | ~1.5 day | ⏳ 派 SDK马 |
| **P2** | bridge 复用到 `codex-sdk` runtime + test33 | ~0.5 day | ⏳ |
| **P3** | Dashboard "Add Telegram channel" UI（调 anet API 等价） | ~1.5 day | ⏳ N站马 |
| **P4** | WeChat / Feishu channel 复用 bridge 抽象 + 各家 SDK | TBD | 🔮 v0.10+ |

## 4. 边界 case 与已知问题

| 场景 | 处理 |
|---|---|
| node 没启动时 `anet channel add` | 已支持（channel config 落盘，下次 start 生效） |
| node 在线时 `anet channel add` | **不实时注入** —— 需要 `anet node stop + start`，文档明示 |
| 同一 node 多个 bot token | 当前 telegram dir 是单一，**报错**或 `channels/telegram/<bot-name>/` sub-dir 隔离（待定） |
| 同一 bot token 给多个 node | Telegram getUpdates 互抢消息 —— **文档警告**，建议用 webhook + chat_id 路由 |
| Bridge worker 崩溃 | 主 loop 监督 + 重启（指数退避 3s → 60s，跟 SSE 重连一致） |
| LLM think 慢 / 超时 | bot 发"⏳ 处理中…"占位 + 实际 reply 时编辑消息（Telegram supports message edit）|

## 5. 测试计划

### test32-telegram-bridge-sdk（P1 必需）

```
L0 环境：mock-telegram-server 在容器内起来，nodejs 能 reach
L1 配置：anet channel add telegram <test-node> 落盘 .env + access.json
L2 启动：agent-node 起来，bridge worker fork 成功，polling 在跑
L3 流量：mock 发 update.message → bridge 收 → think (mocked LLM 返回固定 reply) → bridge 调 sendMessage → mock 收到 reply
L4 白名单：用 not-allowed user_id 发 update → ignore + audit_log 写一条 deny
L5 重启续：bridge 重连 + 继续收新消息
```

### test33-telegram-bridge-codex（P2）

复用 test32，替换 LLM mock 为 codex thread mock，验 codex runtime 也能跑通同一流程。

## 6. 文档落地

实施 P1/P2 时同步：

- `docs-site/docs/guide/channels.md` — 加 "Bind Telegram to existing node" 章节，对比 3 个 runtime 接入方式（ZH+EN）
- `docs-site/docs/cases/telegram-squad.md` — 现有 demo 是从零起，加一节 "Bind to existing node" 入口（ZH+EN）
- `docs-site/docs/changelog.md` — Phase 1/2 release entry

## 7. 不在本 RFC 范围

- WeChat / Feishu / Slack 接入（P4 复用本 RFC bridge 抽象，但单独 RFC-003）
- Telegram Bot 命令系统（`/start` `/help` 等内置命令）—— bridge layer 透传到 think，由 system prompt 决定行为
- Hub 端集中 channel 注册 —— 当前设计是 agent-local，hub 不管 channel

## 8. 关联 RFC / Issue

- 实现先决：[RFC-001](RFC-001-deprecate-commhub-auth-token.md) Phase 2（ntok_ 已稳定，agent-node 启动后能拿到自己的 network 上下文）— 已 done
- [issue #14](https://github.com/sleep2agi/agent-network/issues/14) — 本 RFC 跟踪 issue
- [issue #18](https://github.com/sleep2agi/agent-network/issues/18) — SDK Deep-dive，本 RFC P1/P2 实施时引用其中 `think()` 函数位置

## 9. 决策项

待 Vincent 拍板：

1. ✅ Phase 1 优先级 P0 还是 P1？— **建议 P1**（claude-code-cli 已 work，多数用户先用它）
2. ✅ Bridge 用 polling 还是 webhook？— **建议 polling**（无需公网 IP / TLS，开发 friendly；webhook 留生产部署 P3 后再加）
3. ✅ 同 bot token 给多 node 怎么处理？— **建议直接报错 + 文档建议 1 bot 1 node**
4. ✅ access.json 的 `allowChats` 字段当前 cli 没写入，要不要加？— **建议加，与 demo squad 默认行为一致**

实施 PR 必须先拍这 4 个决策。

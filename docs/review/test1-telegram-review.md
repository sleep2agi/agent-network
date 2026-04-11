# Telegram Channel Review

Review scope:
- `agent-node/src/cli.ts`
- `agent-network/bin/cli.ts`

## 结论摘要

Telegram channel 已经具备可运行的最小闭环：
- `anet channel add telegram` 可以写入 bot token 和白名单配置
- `agent-node` 启动时能加载 Telegram channel 配置
- 能轮询 `getUpdates` 接收消息
- 能下载图片附件并拼到 prompt
- 能调用模型并通过 Telegram `sendMessage` 回复

但它和 CommHub 主流程没有完全对齐。当前 Telegram 消息入口直接调用 `think()`，没有复用 `processTask()`，因此会绕过统一的状态上报和部分生命周期逻辑。这和前面 review 里提到的“绕过主流程”问题一致。

## 1. Telegram channel 实现完整度

### 已实现

1. 配置加载
   - `initTelegramChannel()` 会读取 `channels/telegram/.env` 中的 `TELEGRAM_BOT_TOKEN`，再读取 `access.json` 白名单配置。
   - 代码位置：`agent-node/src/cli.ts:219-241`

2. 配置创建
   - `writeTelegramChannelConfig()` 会创建：
     - `channels/telegram/.env`
     - `channels/telegram/access.json`
     - `channels/telegram/inbox/`
   - 代码位置：`agent-network/bin/cli.ts:873-889`

3. 消息接收
   - `connectTelegram()` 使用 Telegram Bot API `getUpdates` 长轮询拉取消息。
   - 支持 offset 持久化到 `state.json`，避免重启后重复消费。
   - 代码位置：`agent-node/src/cli.ts:797-861`

4. 消息处理
   - `handleTelegramMessage()` 会：
     - 校验白名单
     - 提取文本 / caption
     - 下载图片附件
     - 构造 prompt
     - 调用模型
   - 代码位置：`agent-node/src/cli.ts:777-794`

5. 回复发送
   - `telegramSend()` 调用 `sendMessage`
   - 会自动按 4096 字分块回复
   - 首条消息支持 `reply_to_message_id`
   - 代码位置：`agent-node/src/cli.ts:730-739`

6. 白名单
   - `telegramAllowed()` 支持按 Telegram `user id` 或 `username` 白名单放行
   - 代码位置：`agent-node/src/cli.ts:712-717`

7. 附件处理
   - `telegramBuildPrompt()` 支持：
     - `photo`
     - `document` 且 `mime_type` 为 `image/*`
   - 下载后把本地路径拼进 prompt
   - 代码位置：`agent-node/src/cli.ts:755-775`

### 不完整或偏弱的点

1. 只实现了 polling，没有 webhook 模式
   - 当前是能用，但不是最省资源的接入形态。

2. 白名单策略较简单
   - `access.json` 里写了 `dmPolicy/groups/pending`，但当前读取时只真正使用了 `allowFrom`。
   - `groups/pending` 现在基本没有代码消费。
   - 代码读取位置：`agent-node/src/cli.ts:231-239`

3. Telegram inbox 目录创建了，但主逻辑几乎不依赖它
   - 实际写入的是下载的附件文件，不是 Telegram 消息队列本身。

## 2. 安全问题

### 相对做得对的部分

1. token 不放进 profile 的普通 env
   - `anet channel add telegram` 把 bot token 单独写进 channel 目录的 `.env`
   - 没有塞进 node profile 的普通 `env` 字段
   - 这比把 token 混进通用配置更安全

2. `.env` 做了 `chmod 600`
   - 写入时：
     - `agent-network/bin/cli.ts:877-879`
   - 运行时再次尝试加固：
     - `agent-node/src/cli.ts:228-229`

3. profile 展示时有 env masking
   - `maskSecretEnv()` 会掩码 `TOKEN|KEY|SECRET|PASSWORD`
   - 代码位置：`agent-network/bin/cli.ts:891-898`

### 主要风险

1. Telegram bot token 仍是明文落盘
   - 文件权限是 600，但本质仍是本地明文 secret。
   - 一旦宿主机目录被打包、同步、误提交或被其他本机进程读取，token 会泄露。

2. `loadEnvFile()` 直接把 channel `.env` 注入进 `process.env`
   - 这会让 token 进入整个 agent 进程环境。
   - 后续如果某些 runtime、日志、崩溃转储或子进程透传环境变量，存在扩散风险。
   - 代码位置：`agent-node/src/cli.ts:194-205`, `219-223`

3. 白名单默认“空列表即全放行”
   - `telegramAllowed()` 在 `allowFrom.length === 0` 时直接允许所有人。
   - 当前 `anet channel add telegram` 会要求输入 `--allow`，但如果用户手工改坏 `access.json` 或配置丢失，运行时会退化成全开放。
   - 代码位置：`agent-node/src/cli.ts:712-717`
   - 这是一个值得收紧的默认行为，建议改成“白名单缺失则拒绝全部”。

4. 日志中会记录 Telegram 文本内容
   - `connectTelegram()` 会把收到的文本 `text.slice(0, 80)` 记日志。
   - `handleTelegramMessage()` 和通用日志也会记录 prompt/result 摘要。
   - 如果 Telegram 被用作真实私聊入口，日志可能包含敏感内容。
   - 代码位置：`agent-node/src/cli.ts:785`, `841-853`

## 3. 和 MCP 主流程的差异

这是当前最大的问题。

### 主流程

CommHub 主流程是：
- 进 inbox
- `processInbox()`
- `processTask()`
- `reportStatus("working")`
- `think()`
- `reportStatus("idle")`
- `sendReply()`

代码位置：
- `processTask()`：`agent-node/src/cli.ts:603-615`
- `processInbox()`：`agent-node/src/cli.ts:649-701`

### Telegram 当前流程

Telegram 走的是：
- `connectTelegram()`
- `handleTelegramMessage()`
- `think(prompt, from, images)`
- `telegramSend()`

代码位置：
- `handleTelegramMessage()`：`agent-node/src/cli.ts:777-794`

### 直接后果

1. 绕过 `processTask()`
   - 不会自动 `reportStatus("working")`
   - 也不会在结束后统一恢复 `idle`

2. 绕过 CommHub task 生命周期
   - Telegram 消息不会变成 CommHub task
   - 不会进入 `/api/tasks`
   - 不会有 `send_reply / ack / task status` 这些统一事件

3. 错误处理逻辑不一致
   - 主流程会把 `think()` 错误包装成 `${RUNTIME} 错误: ...`
   - Telegram 则直接捕获并发送 `处理出错: ...`
   - 对外表现不一致

4. 过滤/冷却逻辑不一致
   - `processInbox()` 有低价值消息过滤、cooldown、防自循环逻辑
   - Telegram 分支没有复用这些规则

### 建议

如果 Telegram 要被视为“正式 channel”，应至少做到两种之一：

1. 轻改方案
   - `handleTelegramMessage()` 改为走 `processTask()`，而不是直接 `think()`
   - 这样至少能统一状态切换和错误处理

2. 完整方案
   - Telegram ingress 先映射成 CommHub task，再走现有 inbox / task / reply 生命周期
   - 这样 `/api/tasks`、状态机、审计、SSE 都能统一

## 4. 缺少的测试覆盖

当前最缺的是 Telegram 专项自动化测试。建议至少补以下覆盖：

1. 配置安全
   - `anet channel add telegram` 后：
     - `.env` 存在
     - 权限为 `600`
     - `access.json` 正确写入 allowlist

2. 白名单
   - allow user id 能通过
   - 非 allow user id 被拒绝
   - allow username 能通过
   - 空 allowlist 时的行为要明确测试

3. 主流程一致性
   - Telegram 消息处理时是否会触发 `reportStatus(working/idle)`
   - 当前预期是不会，这正是需要被暴露出来的测试

4. 附件
   - `photo` 下载并入 prompt
   - `document(image/*)` 下载并入 prompt
   - 非图片 document 应忽略或拒绝

5. 长消息回复
   - 超过 4096 字时是否正确分段发送

6. offset 持久化
   - 重启后不会重复消费已处理消息
   - 处理失败时 offset 不应错误前移

7. 错误路径
   - 无效 bot token
   - Telegram API 返回失败
   - 文件下载失败
   - sendMessage 失败

8. 隐私与日志
   - 敏感消息是否被完整打进日志
   - 至少应有一个 review/test 明确当前行为

## 最终判断

Telegram channel 目前属于“能用，但还没完全纳入统一架构”的状态。

- 可用性：基本可用
- 安全性：中等，已有 600 权限和 allowlist，但 token 仍为明文本地存储，且空 allowlist 默认全放行
- 架构一致性：不足，明确绕过 `processTask()`
- 测试覆盖：明显不足，尤其缺 Telegram 专项自动化测试和主流程一致性验证

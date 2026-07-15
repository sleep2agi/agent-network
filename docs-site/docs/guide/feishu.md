# 飞书 channel 接入指南

把 anet 节点接上飞书，让飞书用户跟 agent 直接对话。`claude-agent-sdk` runtime + 内置在 anet（不再走外部插件）。

> **状态（preview，跟踪 [#179](https://github.com/sleep2agi/agent-network/issues/179)）**：anet `2.2.22-preview.2` / agent-node `2.4.15-preview.2` 起 ship —— 私聊 + 群 @bot + 文本 + 图片**可用**；完整 commhub-gateway / Dashboard 透传是后续 PR。设计文档：[RFC-020](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-020-im-platform-integration.md)。

## 1. 状态 + 适用范围

| 维度 | 当前能力 |
|---|---|
| Runtime | 仅 `claude-agent-sdk`（claude-code-cli / codex-sdk / grok-build-acp 待后续） |
| 触达 | ✅ 私聊（白名单内 `open_id`）/ ✅ 群里 @bot |
| 媒体 | ✅ 文本 / ✅ 图片（需 vision-capable 模型，见 §4） |
| Dashboard 拓扑 | ❌ 暂不进（commhub-gateway 后续 PR） |
| 主动推送 | ❌ agent 仅响应入站消息（`anet im send` 主动推排 RFC-020 §12.9） |

## 2. 前置：飞书自建应用

在 [飞书开放平台](https://open.feishu.cn) 建一个**企业自建应用**，启用机器人能力：

1. **权限**（应用能力 → 权限管理）：
   - `im:message:send_as_bot` — bot 发消息
   - `im:message` — 收消息
   - `im:resource` — 上传图片
2. **事件订阅**：在「事件订阅 → 配置方式」选 **「使用长连接」**（**不是** 「使用 Webhook URL」），然后在事件列表订阅 **「接收消息 - `im.message.receive_v1`」**（仅此一个）。
   - 不需要公网 IP / webhook URL / Encrypt Key
3. **发布版本** + 等管理员 approve
4. 复制 **App ID** + **App Secret**（凭证 & 基本信息页）

::: warning ⚠️ 真坑（用户实战卡过的）
1. **配置方式必须选「使用长连接」** —— 不是「使用 Webhook URL」。飞书后台菜单原话是「长连接」，不叫「WebSocket」，找不到「WebSocket」按钮就是选错段了。
2. **事件订阅别选成「用户进入会话（`bot_p2p_chat_entered`）」** —— 看到列表里其他叫「会话」「消息」的事件不要勾选，只勾「接收消息 `im.message.receive_v1`」这一条。多勾会触发非预期路径。
3. **网络可达性**：bot 跑的机器要能连 `api.feishu.cn`（长连接事件走这域名，**不是** `open.feishu.cn`）。如果 agent-node 日志反复 `[ws] ws connect failed` 又零事件 → 多半是公司网/DPI 只放行 `open.feishu.cn` 挡了 `api.feishu.cn`，换可达网络部署（或加白名单）。
4. **群聊先把 bot 拉进群** —— bot 没在群里你 @ 也 @ 不出来。群管理员在群设置 → 群机器人 → 添加机器人 → 选你刚发布的自建应用。后续 §6 还会强调 group `chat_id` 也要加白名单。
:::

## 3. 🚀 Docker 一键（推荐）

::: tip 推荐做法
Docker 一键 = 填 `.env` + `docker compose up -d`，**容器 entrypoint 自动 `anet login` + 创建节点 + 绑定飞书 + 启动**，飞书 bridge 立刻起来。Vincent 首选。
:::

模板文件在仓库的 [`docker/feishu/`](https://github.com/sleep2agi/agent-network/tree/main/docker/feishu) 目录：

```
docker/feishu/
├── docker-compose.yml      # BYOH 默认 + 可选 local-hub profile
├── Dockerfile              # node:22-bookworm-slim + bun + 钉版本号
├── .env.example            # 字段模板, 注释里带验证过的 vendor+model 对照
├── entrypoint.sh           # login → node create → channel add feishu → start, 幂等
└── README.md               # 三步快启 + .env 清单 + 故障排查表
```

### 三步快启

```bash
git clone https://github.com/sleep2agi/agent-network.git
cd agent-network/docker/feishu/

cp .env.example .env
$EDITOR .env                                # 填账号 / App / 模型, 见下表

docker compose up -d                        # 首次 build 约 2 min
docker compose logs -f feishu-agent         # 跟启动 + 运行日志
```

容器 entrypoint 跑完整 bring-up：`hub init` → `anet login` → `anet node create` → `anet channel add feishu` → `anet node start`，每步**幂等**（重启容器不重复折腾），状态全在 `./data/.anet/` 持久化。

### `.env` 关键字段（以 [`docker/feishu/.env.example`](https://github.com/sleep2agi/agent-network/blob/main/docker/feishu/.env.example) 为准）

| 字段 | 作用 | 必填 |
|---|---|---|
| `HUB_URL` | 你已有的 commhub-server URL | ✅ |
| `HUB_USER` / `HUB_PASSWORD` | 该 hub 上的账号（**非交互式 `anet login --username/--password`，每次启动重新登录，不用预签 ntok\_**） | ✅ |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | §2 拿到的飞书自建应用凭证 | ✅ |
| `ANET_MODEL` + `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` | 模型后端三件套（详见 §4） | ✅ |
| `FEISHU_ALLOW_FROM` | 允许私聊的 `open_id` 列表（逗号分隔） | 可选但**强烈建议** |
| `FEISHU_ALLOW_CHATS` | 允许群聊的 `chat_id` 列表（逗号分隔） | 可选 |
| `NODE_ALIAS` | 节点 alias（默认 `feishu-agent`） | 可选 |
| `ACK_PLACEHOLDER` | "⏳ 处理中…" 占位开关（默认 `true`，详见 §7） | 可选 |

`.env.example` 注释里带验证过的 vendor + model 对照：DeepSeek / MiniMax (M2.7 文本 / M3 vision) / Claude Sonnet / 书生 intern-s2-preview 等。

### BYOH（Bring Your Own Hub）

**默认 `docker compose up` 只起 agent service，连你自己的 hub**（`HUB_URL=https://your-hub...`），不内置起 hub。生产场景就这条路径。

> 🧪 **`--profile local-hub` 是自测用**，跑一个一次性本地 hub 容器配合 agent，做隔离 smoke。**默认不启用**，需要时显式 `docker compose --profile local-hub up -d` 且把 `.env` 里 `HUB_URL=http://hub:9200`。日常忽略即可。

### 卷映射 + 安全边界（两个子目录）

`docker-compose.yml` 只映射 cwd 的**两个子目录**（不是整个 cwd），blast radius 严格限定——agent 的 Bash / 完整工具碰不到主机上的 compose 文件、`.env`、或其他目录：

| 宿主（cwd 子目录） | 容器 | 装什么 |
|---|---|---|
| `./data` | `/work` | 节点配置、channels（`.env` + `access.json`）、logs、SQLite，全在 `./data/.anet/` |
| `./claude` | `/root/.claude` | claude-agent-sdk **对话历史** `projects/-work/<session>.jsonl` |

两个都重要：`config.json` 里的 `session` 只是 **resume id**（在 `./data`），真正的**对话记录**在 `/root/.claude`（不在 `/work`）。**不挂 `./claude` 的话，重建容器对话历史就丢了 → SDK 没法 resume，报「No conversation found」、bot 忘记之前上下文。** 挂上后，重建 / 升级容器 bot 都能接着之前的记忆聊。两个目录首次 `up` 自动创建。

### 版本钉死 + 升级

镜像通过 Docker `ARG` 钉死 preview 版本号（当前 `agent-network 2.2.22-preview.2` + `agent-node 2.4.15-preview.2`），不浮动 `@preview` tag，保证可复现。要换更新的 preview：

```bash
ANET_VERSION=2.2.23-preview.0 \
ANET_NODE_VERSION=2.4.16-preview.0 \
  docker compose build
docker compose up -d
```

正式 latest 发版后这里会同步切换。

### 启动验证 / 故障排查（5 行表）

| log line | 怎么处理 |
|---|---|
| `HUB_URL: missing — set HUB_URL=...` | `.env` 某必填字段空, 修了 `.env` 再 `docker compose up -d` |
| `❌ Cannot reach hub: Cannot connect to CommHub server` | `HUB_URL` 写错 / hub 没起，主机上 `curl $HUB_URL/health` 验 |
| `❌ Login failed: invalid username or password` | `HUB_USER` / `HUB_PASSWORD` 跟 hub 账号不匹配，可以本机 `anet login` 先验账号 |
| `[claude] image attachments (N) received but ... text-only` | `ANET_MODEL` 不是 vision-capable，切到 MiniMax-M3 / Claude Sonnet 等支持 vision 的 model |
| 容器 restart-loop 始终没到 `[start] exec agent-node` | bring-up 某一步 fail-fast，`docker compose logs feishu-agent` 看是哪一步 |

更多排查见 [`docker/feishu/README.md`](https://github.com/sleep2agi/agent-network/blob/main/docker/feishu/README.md) + 本页 §9。

## 4. 模型后端（claude-agent-sdk runtime）

飞书 bridge 把入站消息塞给 `claude-agent-sdk` runtime 处理，所以模型后端通过三个 env 配：

| env | 作用 |
|---|---|
| `ANTHROPIC_BASE_URL` | 走哪家厂商的 Anthropic-compatible endpoint |
| `ANTHROPIC_AUTH_TOKEN` | 该厂商的 API Key |
| `ANET_MODEL` | 厂商支持的具体 model id |

**文本场景** 任意兼容供应商皆可（DeepSeek / Anthropic Sonnet / MiniMax / 智谱 GLM / Kimi / 书生 InternLM / 小米 MiMo / OpenRouter 等，详见 [多模型配置](/guide/multi-model)）。

**图片场景** 后端必须 **vision-capable**，常见选择：

| 后端 | model 示例 | 备注 |
|---|---|---|
| Anthropic 官方 | `claude-sonnet-4-5-...` | 主线 vision |
| MiniMax | `MiniMax-M3` | 国内可达 |
| 小米 MiMo（vision） | `mimo-v2.5-pro` 等 | 国内可达 |

不支持图片的后端 + 飞书收到图片消息 → bridge **warn-only 降级**为纯文本处理（M5b 行为），不挂掉。

📖 完整多模型 / 多供应商对照：[多模型配置](/guide/multi-model)

## 5. 访问白名单

bridge 不接受全网消息——必须在 `access.json` 里把允许的 **人**（`open_id`）和 **群**（`chat_id`）显式列出。

**Docker 路径**（推荐）：通过 `.env` 配置（`FEISHU_ALLOW_FROM` / `FEISHU_ALLOW_CHATS` 会在启动时写入 `access.json`），改完 `docker compose restart` 即生效。

**手动 anet 路径**：用 CLI 增删：

```bash
# 加一个允许私聊的人
anet channel allow feishu <node> --add-from ou_<your-open-id>

# 加一个允许群聊的群
anet channel allow feishu <node> --add-chat oc_<group-chat-id>

# 删除
anet channel allow feishu <node> --rm-from ou_<your-open-id>
anet channel allow feishu <node> --rm-chat oc_<group-chat-id>
```

flags 是 **repeatable** 的（一次 `--add-from a --add-from b` 加多个）。**不支持逗号语法**——`--add-from a,b,c` 会被当成单个 open_id 原样存储。

查看当前白名单：

```bash
anet channel ls
# 会列出每个 node 的 channels + allowFrom + allowChats
```

::: warning 改完必须 restart 节点
`access.json` **不热加载**——改完一定要 `anet node stop <node>` + `anet node start <node>`（Docker 路径下 `docker compose restart <node-service>`）。bridge 启动时一次性把 access.json 读进内存。
:::

::: danger 换飞书 App 必踩：open_id / chat_id 按 App 隔离
飞书的 `open_id`（用户身份）和 `chat_id`（会话）都是**按 App 隔离**的——**同一个人，在不同 App 下 `open_id` 完全不同**。所以换 App 后，`access.json` 里存的旧 ID **全部失效**，每条消息都会命中「发件人不在白名单」被静默拒收。

换 App 时**三处**都要同步改：① 节点环境 / 部署里的 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` ② channel 的 `.env` ③ **`access.json` 的 `allowFrom` / `allowChats`**（最容易漏）。

漏第三处的典型症状：**`client ready` 正常、能看到事件、但用户消息「毫无反应」**。完整复盘见 → [经典案例：飞书 Bot 静默拒收](/troubleshooting/case-feishu-silent-deny)。
:::

## 6. 群 @ 机制

bot 要在群里能用，**两步**：

1. **群管理员把 bot 拉进群**（飞书后台「机器人管理」或直接群里 @邀请）
2. **该群的 `chat_id` 加进 `allowChats`**（见 §5）

入群后**默认 group policy = `mention`** —— 只有群消息**真的 @bot** 才触发 agent；普通群消息直接忽略（防群噪音）。

判断 @bot 的方式：bridge 把消息 `mentions[].id.open_id` 跟 bot 自己的 `open_id` 比对（bridge 初始化时通过 `/open-apis/bot/v3/info` 拉自己的 `open_id`）。

私聊场景**不需要 @**，发什么 bot 就回什么（白名单内）。

::: tip 线程
bot 的 reply 会跟着原消息的 `root_id` 进**同一条线程**，不会污染主频道。
:::

## 7. ⏳ 处理中…（ackPlaceholder）

收到消息**秒回一条"⏳ 处理中…"占位**，让用户立刻知道 bot 收到了；agent 思考完，**答复以新消息发出**（**不**就地编辑占位）。Vincent 6/26 Option A 决策。

**为什么不编辑占位而发新消息？**

- IM 客户端**没有「消息被编辑」的 push 通知** —— 用户除非主动回看群/会话，不知道 bot 答完了
- 发新消息 → 用户得到**第二条 push** ——「⏳处理中…」（bot 收到了）+「答复」（bot 干完了），两次都有信号

超时通知（`TIMEOUT_NOTICE_TEXT`）也走 new-message 路径，同理。

**默认 on**。关掉：

> 在 `.env` 里设 `ACK_PLACEHOLDER=true` 开启（见 `docker/feishu/.env.example`）。

## 8. 进阶：手动 anet node 配置（非 Docker）

如果你不想用 Docker，或想直接装在宿主机：

### 8.1 安装 preview

```bash
npm install -g \
  @sleep2agi/agent-network@2.2.22-preview.2 \
  @sleep2agi/agent-node@2.4.15-preview.2
# 或装当前 preview tag：
# npm install -g @sleep2agi/agent-network@preview @sleep2agi/agent-node@preview
```

> 飞书 channel 仍在 preview 通道；待 `latest` 升级后会同步更新本页。

### 8.2 创建节点 + 绑定飞书

需要节点已存在；如未创建：

```bash
anet node create <node-name> --runtime claude-agent-sdk
```

绑定飞书 channel：

```bash
anet channel add feishu <node-name> \
  --app-id     cli_xxxxxxxxxxxxxx \
  --app-secret yyyyyyyyyyyyyyyyy \
  --allow      ou_<your-open-id>          # 允许私聊的 open_id
  --allow-chat oc_<group-chat-id>         # 可选：允许群聊的 chat_id
```

不带 flags 进交互模式：

```bash
anet channel add feishu <node-name>
```

写入 `.anet/nodes/<node-name>/channels/feishu/`：

| 文件 | 内容 | 权限 |
|---|---|---|
| `.env` | `FEISHU_APP_ID` + `FEISHU_APP_SECRET` | `chmod 600` |
| `access.json` | `{allowFrom: [open_id...], allowChats: [chat_id...]}` | `chmod 644` |

### 8.3 启动节点

```bash
anet node start <node-name>
```

启动 log 应出现：

```
[agent-node] channels: feishu(/path/.anet/nodes/<node-name>/channels/feishu)
[agent-node] [feishu] forked worker (pid 12345) for ... via ...
[feishu:worker] bridge online — node=<node-name> dir=... ipc=yes
```

worker 路径默认 `dist/src/im/feishu/worker.js`（`@sleep2agi/agent-network` 安装后即有）。如需覆盖：

```bash
export ANET_FEISHU_WORKER_PATH=/path/to/your/worker.js
```

### 8.4 触发策略 sanity

- **私聊**：`sender.open_id ∈ allowFrom` 才触发；不在白名单 → bridge stderr 出 `[feishu:audit] deny from=...`，不派 IPC
- **群聊**：群 `chat_id ∈ allowChats` **且** 消息 @bot 才触发；不 @ bot → 静默忽略
- **线程**：bot reply 跟 `root_id` 进同一线程

## 9. 故障排查

| 现象 | 排查 |
|---|---|
| 节点启动报 `unsupported channel: feishu` | agent-node 版本太老，升级到 `agent-node@2.4.15-preview.2` 或更新 |
| `[feishu] worker path not found` warn | 设 `ANET_FEISHU_WORKER_PATH`，或确认 `@sleep2agi/agent-network` 已安装 + 编译 |
| WSClient 连不上飞书 | App 未 approve / 凭证写错 / 网络问题 — bridge 会自动重连，看 stderr |
| 群里 @bot 不响应 | 1) bot 已加群且有发言权限 2) `access.json` `allowChats` 含目标 `chat_id` 3) `/open-apis/bot/v3/info` 是否返回有效 `open_id` 4) 改完 `access.json` 是否 restart 过节点（不热加载，见 §5） |
| 私聊不响应 | `open_id` 是否在 `allowFrom` 内（`anet channel ls` 看一下） |
| **连上了、有事件、但消息「没反应」** | bridge stderr **grep `deny` / `allowFrom`**：消息收到了但发件人不在白名单。**换 App 后最常见**（`open_id` 按 App 变了，见 §5 危险提示） |
| 收到图片 bot 答非所问 / 报错 | 后端不是 vision-capable（见 §4）—— 切到支持 vision 的 model |
| **发图片 bot 回「收到事件但没有可处理的文本/图片内容」** | 图片**没被抠出来**，两种根因依次排：① 节点没开图片能力（`flags.modelImageCapable` 默认不设，见 §4）② **下载失败**——日志看 `[feishu:image] … download FAILED`，最常见是**旧版本的 `downloadImage` SDK 误用 bug**（[#324](https://github.com/sleep2agi/agent-network/pull/324)，`2.2.22-preview.2` 等旧版带），升级到含修复的 preview 即根治。详见 [经典案例 · 同源篇](/troubleshooting/case-feishu-silent-deny#同源案例图片识别不了) |

诊断口诀（按层收窄）：① 日志无 `client ready` = 网络连不上飞书长连接域名 → 换网络；② 有 `client ready` 但零事件 = 飞书后台事件订阅没配对（漏 `im.message.receive_v1` / 没设长连接 / 没发布版本）；③ 有 `client ready`、有事件、但不回 = 应用层拒了，grep `deny` / `allowFrom`；④ 发图无反应 = 图片没抠出来，查 `modelImageCapable` flag + 下载是否失败（旧版本 bug，升级）。完整复盘 → [经典案例：飞书 Bot 静默拒收](/troubleshooting/case-feishu-silent-deny)。

## 10. 已知限制（preview scope）

- **不进 Dashboard 拓扑** — 飞书消息不走 commhub task 路径，Dashboard 看不见。完整 commhub-gateway（RFC-020 §2.9 schema 增量）是收尾 PR
- **agent 不能主动推飞书** — 仅响应入站消息。主动推（`anet im send`）排 P1.5（RFC-020 §12.9）
- **仅 `claude-agent-sdk` runtime** — `claude-code-cli` 仍走 [社区 plugin](https://github.com/vansin/claude-code-feishu-channel)；`codex-sdk` / `grok-build-acp` 后续

## 参考

- [RFC-020 IM 兼容层](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-020-im-platform-integration.md) — 完整设计
- [RFC-002 channel-bind-cli](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-002-channel-bind-cli.md) — telegram-bridge 模式前身
- [issue #179](https://github.com/sleep2agi/agent-network/issues/179) — 父 RFC tracker
- [Channel 接入总览](/guide/channels) — Telegram / 微信 / 飞书 整体定位
- [多模型配置](/guide/multi-model) — 模型后端选型
- [社区 SDK 调用层 prior art](https://github.com/vansin/claude-code-feishu-channel) — `claude-code-cli` 路径

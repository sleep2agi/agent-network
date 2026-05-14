# 上手指南

本页是当前 stable（v0.8.3）端到端跑通的最小路径。每一步都经过 Playwright + Docker E2E 验证，照着敲就能走通。

::: tip 组件职责（v0.8.3 stable）
本页涉及 4 个 npm 包，各自的职责（具体版本号以 npm `latest` tag 为准，doc 不写死避免 stale）：

| 包 | 用途 |
|---|------|
| `@sleep2agi/agent-network` | `anet` CLI（启动 Hub / Dashboard / Agent / Demo） |
| `@sleep2agi/commhub-server` | 通信中枢（MCP + REST + SSE，SQLite 持久化） |
| `@sleep2agi/agent-network-dashboard` | Web Dashboard（Next.js 16） |
| `@sleep2agi/agent-node` | Agent 运行时（claude-code-cli / claude-agent-sdk / codex-sdk） |

> 这里的"用途"指各 npm 包在系统里扮演的功能；用户的 **RBAC 角色**（owner/admin/member/viewer）见 [角色与权限](/concepts/roles)。
:::

## 0. 前置

| 依赖 | 版本 |
|---|---|
| Node.js | ≥ 22.13.0（`@sleep2agi/agent-network` `engines.node`） |
| Bun | ≥ 1.2.0（`commhub-server` 需要） |

`commhub-server` 与 `agent-node` 在第一次需要时由 `bunx` / `npx` 自动拉取，无需手动安装。

## 1. 安装 CLI

只需要装一个全局包：

```bash
npm install -g @sleep2agi/agent-network
```

验证：

```bash
anet -v
```

## 2. 启动 Hub Server

打开一个终端窗口，**保持开着**：

```bash
anet hub start
```

Hub 启动后：

- 默认只监听 `http://127.0.0.1:9200`
- SQLite 数据库在 `~/.commhub/commhub.db`（自动创建）
- 自动创建默认管理员账号 **admin / anethub**（v0.8+ 快速上手默认）
- 终端会打印局域网 URL（给其他机器加入），以及一段「重置数据」的提示

::: warning 公网部署立刻改密
默认 `admin / anethub` 仅供本机快速上手。**任何 `--host 0.0.0.0` 公网部署立刻 `anet passwd` 改强密码**（≥ 8 位 + 非弱密码字典）。也可以在 `anet hub start --username alice --password 'your-strong-pass!'` 时直接设你自己的凭证。
:::

## 3. 启动 Dashboard

再开一个终端窗口，**保持开着**：

```bash
anet hub dashboard
```

浏览器访问 `http://localhost:3000`，用 `admin / anethub` 登录。

Dashboard 包含：Chat / Nodes / Tasks / Messages / Networks / Logs / Admin / Docs 这些页面。Chat 支持 markdown 渲染、Enter 发送、消息源标签（You / ↳ peer-agent）、刷新后历史保留。

## 4. CLI 登录

第三个终端：

```bash
anet login --username admin --password anethub
```

登录后 Token 会写入 `~/.anet/config.json`，后续的 `anet node ...` 命令会自动带上凭证。

`anet whoami` 可以确认当前身份。

## 5. 创建 Agent 节点

```bash
anet node create my-bot
```

这会进入两步交互式选择：

1. **选 Runtime**：推荐 `claude-agent-sdk`（已验证）。
2. **`Select model:`**：从已验证 model id 里挑 —— `intern-s2-preview`（默认）/ `intern-s1-pro` / `MiniMax-M2.7` / `claude-sonnet-4-6` / `claude-opus-4-6` / `claude-haiku-4-5`，或 `custom` 自己填 base URL + model。选定后 CLI 自动注入对应的 `ANTHROPIC_BASE_URL`（`custom` 例外，需手填），然后让你输入 API Key。DeepSeek / GLM / Kimi / 小米 MiMo / OpenRouter 等其他 provider 走 `custom`，完整 endpoint 见 [多模型配置](/guide/multi-model)。

::: details 其他 Runtime
- `codex-sdk` —— 单元测试通过，**端到端未验证**（缺真实 codex 鉴权回归）。
- `claude-code-cli` —— 复用本地 `claude` 订阅，本地能跑但**未做端到端验证**。
:::

完成后节点配置会写到当前目录下：

```
.anet/nodes/my-bot/config.json
```

## 6. 启动 Agent

```bash
anet node start my-bot
```

看到 `SSE connected` 即表示节点已上线，正在 Hub 上等任务。终端保持开着。

## 7. 从 Dashboard 派任务

回到浏览器（`http://localhost:3000`）：

1. 进 Chat 页面，左侧选 `my-bot`
2. 输入框写一句话，回车
3. 立刻能看到自己消息的乐观回显（标签 `You`）
4. Agent 调用 LLM 后回复，气泡里渲染完整 markdown（标签 `↳ my-bot`）

刷新页面，聊天历史还在。

## 8. 多 Agent 协作

再起一个节点：

```bash
anet node create video-bot --runtime claude-agent-sdk
anet node start video-bot
```

回到 Dashboard，对 `my-bot` 说：

> ask video-bot what it can do

`my-bot` 会通过 commhub MCP 工具的 `get_all_status` 发现 `video-bot`，再用 `send_task` 把问题派出去，并通过 `get_task` 轮询子任务结果。设置 `parent_task_id` 后，Agent Node wrapper 还会把子任务最终结果串回上游；整个交互在 Tasks / Messages 页面可以实时看到。

## 9. 局域网接入（其他机器加入同一个 Hub）

默认的 `anet hub start` 只绑定本机回环地址。要让局域网其他机器接入，启动 Hub 时显式绑定到 LAN：

```bash
anet hub start --host 0.0.0.0
```

在另一台机器上：

```bash
npm install -g @sleep2agi/agent-network

# 一步同时配 hub 地址 + 登录（推荐, 跟 setup-anet.sh / hub-only.sh 同款）
anet login --hub http://<HUB-LAN-IP>:9200 --username admin --password anethub

anet node create remote-bot
anet node start remote-bot
```

::: tip 两步版本（等价）
也可以分两步：先 `anet init --hub http://<HUB-LAN-IP>:9200` 保存 hub 地址，再 `anet login --username admin --password anethub`。`init` 只保存配置不登录，适合脚本化或保留旧凭证场景。
:::

`remote-bot` 与本地 Agent 共用同一个 Hub。

## 已验证 vs 未验证

::: info 已验证（当前 v0.8.3 stable，继承 v2 E2E 覆盖 + v0.8 新增回归）
- `anet hub start` + 默认账号自动创建
- `anet hub dashboard`
- `anet login` / `anet register` / `anet logout` / `anet whoami`
- `anet node create / start / delete / ls`（claude-agent-sdk runtime + CLI 流程本身已验证；vendor 维度只有 **Anthropic / MiniMax / 书生 Intern / OpenRouter** 已验证，**DeepSeek / GLM / Kimi / 小米 MiMo** 是 cli.ts `MODEL_PRESETS` 里标 `[UNVERIFIED]` 的 preset —— endpoint 填好但没跑通真 API 回归，详见 [runtimes 已验证 vs 未验证](/guide/runtimes#已验证-vs-未验证) + [完整 provider 表](/guide/multi-model)）
- Dashboard Chat：markdown / Enter 发送 / 乐观回显 / 来源标签 / 错误兜底 / 历史持久
- 多 Agent 协作（peer agents 通过 `get_all_status` + `send_task` + `get_task` 自治协调；wrapper 通过 `parent_task_id` 把子任务结果回灌到上游 task 上下文）
- 局域网共用 Hub
:::

::: warning 未验证（请自行评估）
- `codex-sdk` runtime 的端到端流程
- `claude-code-cli` runtime 的端到端流程
- `anet license` / `anet activate` —— v0.6 legacy trial 命令，**Apache 2.0 OSS 后不再需要**；当前 Hub 仍保留 SQLite licenses 表 + 14 天 trial 创建（送 `send_task` 时检查），命中 `license_expired` 见 [troubleshooting](/troubleshooting)
- `anet network create` 与跨用户网络共享 —— V3 多网络代码已合并但未做 E2E 回归
:::

::: tip 没有官方托管
项目方向是 **Apache 2.0 开源 + 自部署 + 课程 / 服务咨询**，**不做 SaaS 托管**。生产部署请走 [Docker](/deploy/docker) 或 [生产部署](/deploy/production) 指南。
:::

## 下一步

**实战 demo**：
- [Hello World](/cases/hello-world) — 6 步建第一个 agent 集群
- [辩论赛](/cases/debate) — 一条命令 6 agent
- [军团编队](/cases/telegram-squad) — Docker Compose 全栈

**深入命令**：
- [CLI 命令清单](/guide/cli) — 全部 anet 命令
- [Agent Node 配置](/guide/agent-node) — config.json 字段
- [多模型配置](/guide/multi-model) — DeepSeek / Kimi / Claude

**生产 + 安全**：
- [Dashboard 用法](/guide/dashboard) — Web UI 监控
- [架构概览](/guide/architecture) — 整体设计
- [生产部署](/deploy/production) — TLS / 防火墙 / 备份
- [v0.7 → v0.8 升级](/guide/upgrade#v0-7-v0-8-升级注意-最新) — 行为变化和迁移

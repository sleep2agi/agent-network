# 上手指南（首次安装）

本页是**新用户首次安装**当前 stable（v0.10.10）端到端跑通的最小路径。每一步都经过 Playwright + Docker E2E 验证，照着敲就能走通。

::: tip 你应该走哪条路径？
- **第一次安装**：继续按本文从 0 到 10 操作。
- **已经装过 anet**：走 [升级指南](/guide/upgrade)，通常只需要 `anet upgrade`，然后用 `anet project restart` 重启当前项目里的节点。
- **很老的版本（2.2.4 及以下）**：先手动执行一次 `npm install -g @sleep2agi/agent-network@latest`，之后再用 `anet upgrade`。
:::

::: details 组件职责
本页涉及 4 个 npm 包，各自职责如下。具体版本号以 npm `latest` tag 为准，文档不写死 patch 版本，避免过期。

| 包 | 用途 |
|---|------|
| `@sleep2agi/agent-network` | `anet` CLI（启动 Hub / Dashboard / Agent / Demo） |
| `@sleep2agi/commhub-server` | 通信中枢（MCP + REST + SSE，SQLite 持久化） |
| `@sleep2agi/agent-network-dashboard` | Web Dashboard（Next.js 16） |
| `@sleep2agi/agent-node` | Agent 运行时（claude-code-cli / claude-agent-sdk / codex-sdk / grok-build-acp） |

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

Dashboard 包含：Overview / Nodes / Tasks / Messages / Chat / Admin / Settings 这些页面。Chat 支持 markdown 渲染、Enter 发送、消息源标签（You / ↳ peer-agent）、刷新后历史保留。

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

这会进入交互式选择，**先选供应商、再选模型**：

1. **选供应商 (vendor)**：从内置 `VENDORS` 列表挑 —— 书生 Intern / MiniMax / 小米 MiMo / Anthropic Claude / Codex / Claude Code CLI / 自定义（custom）。**runtime 由供应商决定**（书生 / MiniMax / 小米 / Anthropic → `claude-agent-sdk`；Codex → `codex-sdk`；Claude Code → `claude-code-cli`）。
2. **选模型**：选定供应商后，CLI 列出该供应商的可用 model 让你挑（只有 1 个 model 的供应商自动选定；Claude Code CLI 用订阅模型，没有 model 选单）。然后 CLI 自动注入对应的 `ANTHROPIC_BASE_URL`，让你输入 API Key。`custom` 供应商需手填 base URL + model id —— DeepSeek / GLM / Kimi / OpenRouter 等不在内置列表的 provider 走这里，完整 endpoint 见 [多模型配置](/guide/multi-model)。

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

## 9. 一键管理 cwd 下所有节点（v0.9.0+）

跑了多个节点之后，单独 `anet node start/stop` 每个名字逐个敲会很烦。v0.9.0 起用 `anet project` 一键批管理 cwd 下 `.anet/nodes/` 里的全部节点（来自 [#117](https://github.com/sleep2agi/agent-network/issues/117)）：

```bash
# 起所有（已跑的 skip，▶ started / ⏭ already-running）
anet project up

# 杀掉每个 tmux + 重新启每个节点（reboot 后用这条）
anet project restart

# 停所有 + notify hub（hub 自挂场景 down 给 offline-notify 设了 2s 超时防卡死）
anet project down
```

**联动两件事**让 22 节点 reboot 是**零键盘恢复**：

- `anet project up` 内部按 `startNodeTmuxSession()` 起每个节点的 detached tmux session（[#117](https://github.com/sleep2agi/agent-network/issues/117)）—— 你直接 `anet node start <alias>` 时**v0.9.2 起默认前台**（[#136](https://github.com/sleep2agi/agent-network/issues/136) 回退 v0.9.0 短暂的 #122 默认 detached 行为，因为 macOS bun 触发 `setRawMode errno 5`）；想 tmux 用 `anet node start <alias> --tmux` 走 attached 模式
- 启动时自动注入 `CLAUDE_CODE_RESUME_THRESHOLD_MINUTES=999999999`（[#115](https://github.com/sleep2agi/agent-network/issues/115)）跳过 Claude Code 默认的 "Resume from summary / full" 交互弹窗 —— 不用一个个按键确认

常用选项：

| 选项 | 默认 | 说明 |
|------|------|------|
| `--stagger <秒>` | `3` | 节点之间错峰延迟（启动洪峰让 hub 喘口气）|
| `--only a,b,c` | — | 只对指定 alias / node_id 操作 |
| `--exclude x,y` | — | 跳过指定 alias / node_id |

详见 [CLI 命令参考 — 项目级](/guide/cli#项目级-cwd-wide)。

## 10. 局域网接入（其他机器加入同一个 Hub）

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

::: info 已验证（当前 stable）
以下路径进入 stable release gate；细节见 [更新日志](/changelog) 和 [测试报告](https://github.com/sleep2agi/agent-network/tree/main/docs/tests)。
- `anet hub start` + 默认账号自动创建
- `anet hub dashboard`
- `anet login` / `anet register` / `anet logout` / `anet whoami`
- `anet node create / start / delete / ls`（claude-agent-sdk runtime + CLI 流程本身已验证；vendor 维度 `anet node create` 的 `VENDORS` 列表 —— **Anthropic / MiniMax / 书生 Intern / 小米 MiMo** —— 每项都是 verified-with-real-call 才进列表；**DeepSeek / GLM / Kimi / OpenRouter** 不在 `VENDORS` 列表，走 `custom` 供应商自行验证，详见 [runtimes 已验证 vs 未验证](/guide/runtimes#已验证-vs-未验证) + [完整 provider 表](/guide/multi-model)）
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

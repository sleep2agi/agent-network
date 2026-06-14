# 上手指南（首次安装）

本页是**新用户首次安装**当前 stable（v0.10.15）端到端跑通的最小路径。每一步都经过 Playwright + Docker E2E 验证，照着敲就能走通。

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

::: tip 停止 / 查看状态（v0.10.11+）
```bash
anet hub status                # 显示 PID / port / commhub-server 版本 (查 /health)
anet hub stop                  # 优雅关闭：SIGTERM → 3s grace → SIGKILL 兜底
anet hub stop --port 9201      # 指定非默认端口
```
不再需要手动 `lsof -i :9200` + `kill <PID>` 那套（v0.10.11 [#200](https://github.com/sleep2agi/agent-network/issues/200) 之前用户得自己 hack）。
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

向导按这个顺序问你：

```text
节点名 → runtime → (仅 claude-agent-sdk 才弹) vendor → model → API Key / 鉴权
```

**runtime 是第一道分叉, 4 选 1**, 决定后面要不要配 vendor:

1. **选 runtime** —— 4 个选项, **默认高亮第一项 `claude-agent-sdk`**:
   - `claude-agent-sdk` —— 接 Anthropic 兼容 API, 走 vendor 子菜单
   - `claude-code-cli` —— 复用本机已 `claude auth login` 的订阅, 跳过 vendor / model / API key (**新手最省事**)
   - `codex-sdk` —— 用 OpenAI Codex CLI 登录态, 跳过 vendor
   - `grok-build-acp` —— 用 xAI Grok Build CLI 登录态 + `XAI_API_KEY`, 跳过 vendor

   ::: tip 新手强烈建议手动选 `claude-code-cli`
   向导**默认高亮 `claude-agent-sdk`**, 一路 Enter 会落到要选 vendor + 填 API Key 的复杂路径. 如果你已经 `claude auth login` 了, 手动选 `claude-code-cli` 是 0 配置最快路径.
   :::

2. **(仅 claude-agent-sdk) 选 vendor** —— 从内置 `VENDORS` 列表挑: 书生 Intern / MiniMax / 小米 MiMo / Anthropic Claude / Codex (实为 codex-sdk runtime 入口) / Claude Code CLI (实为 claude-code-cli runtime 入口) / 自定义 (custom, 任意 Anthropic 兼容 endpoint, DeepSeek / GLM / Kimi / OpenRouter 全走这里, 完整 endpoint 见 [多模型配置](/guide/multi-model))

3. **(仅 claude-agent-sdk) 选 model + 填 API Key** —— 选定 vendor 后, CLI 列该 vendor 的可用 model (只 1 个 model 的自动选定). 然后自动注入对应的 `ANTHROPIC_BASE_URL`, 让你粘贴 API Key. `custom` vendor 需手填 base URL + model id.

::: warning vendor 选择中段 Ctrl+C 可能留半成品节点
如果在 vendor 子菜单按 Ctrl+C, CLI 可能已经写了一个半成品 `.anet/nodes/<alias>/config.json` (no vendor / no key) 到磁盘. 用下面这条裸命令清掉重来 (2.2.12 latest 验过):

```bash
anet node delete <alias>          # 第一步: 打印 will delete 预览 + 提示 "Run again with --force to confirm"
anet node delete <alias> --force  # 第二步: 真删
```

[#237 坑 3](https://github.com/sleep2agi/agent-network/issues/237) 跟踪向导默认项 + Ctrl+C 半成品回滚的产品改进, 改完这里同步更新.
:::

::: warning 向导**不**问 Telegram, 别被开头宣传误导
向导跑完上面 3 步就**结束**, **不会问你要 Telegram bot token / 白名单 UID**, 哪怕 `anet node create` 命令开头打了 "optional Telegram channel" 那一行. Telegram 是建完节点后**用单独命令** `anet channel add telegram <node> --bot-token <tok> --allow <uid>` 加上去, 完整步骤见 [Telegram channel 配置](/deploy/clean-server#_6-配-telegram-channel-可选) ([#237 坑 4](https://github.com/sleep2agi/agent-network/issues/237) 跟踪文案修正).
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

两件事联动让 22 节点 reboot 是**零键盘恢复**：

- `anet project up` 给每个节点起 detached tmux session；`anet node start <alias>` 单独跑则默认前台（要 tmux 加 `--tmux`）
- 启动自动跳过 Claude Code 的「Resume from summary / full」交互弹窗，不用一个个按键确认

::: details 为什么 / 历史细节
- `anet project up` 内部用 `startNodeTmuxSession()` 起每个节点的 detached tmux session（[#117](https://github.com/sleep2agi/agent-network/issues/117)）
- 直接 `anet node start <alias>` v0.9.2 起默认前台（[#136](https://github.com/sleep2agi/agent-network/issues/136) 回退 v0.9.0 短暂的 #122 默认 detached 行为，因为 macOS bun 触发 `setRawMode errno 5`）
- 启动时注入 `CLAUDE_CODE_RESUME_THRESHOLD_MINUTES=999999999`（[#115](https://github.com/sleep2agi/agent-network/issues/115)）让 Claude Code 跳过 "Resume from summary / full" 弹窗
:::

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
- `anet license` / `anet activate` —— v0.6 legacy trial 命令，**Apache 2.0 OSS 用户无需操作**；`anet license` 仍存在并会回显类似 `License: PRO / Expires <日期>`，那只是 Hub v0.6 trial 表的 14 天滚动续期后向兼容输出，**跟你 OSS 用法无关**，可直接忽略（清理排在 v0.11+）；命中 `license_expired` 见 [troubleshooting](/troubleshooting)
- `anet network create` 与跨用户网络共享 —— V3 多网络代码已合并但未做 E2E 回归
:::

::: tip 没有官方托管
项目方向是 **Apache 2.0 开源 + 自部署 + 课程 / 服务咨询**，**不做 SaaS 托管**。生产部署请走 [Docker](/deploy/docker) 或 [生产部署](/deploy/production) 指南。
:::

## 下一步

**实战 demo**（一行命令起一组配好的 agent）：

```bash
anet demo                  # 列出可用 demo
anet demo sci-team         # 1 leader + N-1 worker（默认 10，5-50 可调；Phase 1 scaffold — leader 当前是 placeholder echo, 真 fan-out 排 RFC-008 Phase 2）
anet demo pr-review        # 3 角色 PR 评审小组
```

**深入命令**：
- [CLI 命令清单](/guide/cli) — 全部 anet 命令
- [Agent Node 配置](/guide/agent-node) — config.json 字段
- [多模型配置](/guide/multi-model) — DeepSeek / Kimi / Claude

**生产 + 安全**：
- [Dashboard 用法](/guide/dashboard) — Web UI 监控
- [架构概览](/guide/architecture) — 整体设计
- [生产部署](/deploy/production) — TLS / 防火墙 / 备份
- [升级指南](/guide/upgrade) — 任意旧版本 → latest 一键 `anet upgrade`

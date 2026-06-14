# 干净服务器从零部署

::: tip 这一页是写给谁的
你刚拿到一台**全新 Ubuntu / Debian 服务器**（云主机、自己电脑装的虚拟机、公司内网机器都算），想从零跑起 anet hub + 一两个节点 + Telegram 接入，端到端跑通。

本页按通信龙在干净机器上**实测踩过一遍的路径**写：每步带验证命令 + 常见报错对照表（[报错速查](#故障排查表-8-坑-mapping)）。

不是给已经装好 anet 的人看的 —— 那个走 [上手指南](/guide/getting-started) 或 [升级指南](/guide/upgrade)。
:::

## 0. 前置

| 依赖 | 推荐版本 | 怎么装 |
|---|---|---|
| **Node.js** | ≥ 22.13.0 | 推荐 [nvm](https://github.com/nvm-sh/nvm)；`curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh \| bash` → `nvm install 22 && nvm use 22` |
| **Bun** | ≥ 1.2.0 | `npm i -g bun` 或 `curl -fsSL https://bun.sh/install \| bash` |

::: warning Bun 必装
`commhub-server` 是 Bun-shebang TypeScript（用 `bunx --bun` 起），**没装 Bun 直接 `anet hub start` 会裸崩 `spawn bunx ENOENT`**。是新机部署 8 坑里第 1 坑。

验证：
```bash
node --version       # 期望 v22.x 或更新
bun --version        # 期望 1.2.x 或更新
```

任何一个报 `command not found` → 先回头装。
:::

::: details nvm 装的 node 在非交互 shell / 不同用户里失效
nvm 只在**交互 shell** 自动加载（读 `~/.bashrc`）。如果你打算让 systemd / cron / 不同用户启动节点，nvm 的 PATH 不会自动到位。

兜底：
1. 把 nvm 的 node bin 路径直接写进 `/usr/local/bin`：`sudo ln -s "$(which node)" /usr/local/bin/node && sudo ln -s "$(which npm)" /usr/local/bin/npm`
2. 或在 systemd unit / 启动脚本里显式 `source ~/.nvm/nvm.sh`

Bun 一样按用户装（`~/.bun/bin`），换用户 / root 跑前先确认 PATH。
:::

## 1. 安装 anet CLI

只需一个全局包：

```bash
npm i -g @sleep2agi/agent-network
```

验证：

```bash
anet -v
```

期望输出（版本号以 npm `latest` 为准）：

```text
anet v2.2.12
Components (auto-fetched on first use, you don't need to install them manually):
  ✓ agent-node v2.4.10
    └ @anthropic-ai/claude-agent-sdk v0.2.x
    └ @openai/codex-sdk v0.x.x
  ○ commhub-server — not installed yet (will fetch via npx on first use)

Optional runtimes (install only what you'll use):
  ✓ claude CLI v2.1.x        # 已装 + auth login
  ✓ codex CLI v0.x.x         # 已装 + auth login
  ...                        # 没装的 runtime 这里不显示, 用到再装 (见 §5)

Nothing is broken — components are fetched the first time you run:
  anet hub start          # bootstraps commhub-server
  anet node start <name>  # bootstraps agent-node

Docs: https://anet.sh/guide/getting-started
```

`anet -v` 自动告诉你 `agent-node` 装没装、`commhub-server` 拉没拉、可选的 `claude` / `codex` CLI 装没装。这是后面任何启动出错时的**第一查点**。

## 2. 起 Hub（推荐 tmux 挂着）

CommHub 是常驻进程，**关终端就停**。生产场景配 systemd（[#7 持久化](#_7-持久化-systemd-模板待补)），快速验证用 tmux：

```bash
# 装 tmux（如果没装）
sudo apt install tmux -y    # Ubuntu / Debian

# 起一个名叫 anet-hub 的会话挂 hub
tmux new -s anet-hub
anet hub start --host 0.0.0.0 --port 9200

# 看到下面这段就 OK
# CommHub MCP Server v0.8.5
# REST:   http://0.0.0.0:9200/api
# ✅ Admin account created
# username: admin
# password: anethub
```

按 `Ctrl+B` 然后 `D` 把 tmux 会话**断开但保活**。回来用 `tmux a -t anet-hub` 再 attach。

验证 hub 在跑（另一个终端）：

```bash
curl -s http://127.0.0.1:9200/health | head -5
# 期望返 {"ok":true,"version":"0.8.5",...} 之类
```

::: danger 公网部署立刻改密
默认 `admin / anethub` 仅供本机快速上手。**任何 `--host 0.0.0.0` 公网部署立刻**：

```bash
anet login --username admin --password anethub --hub http://127.0.0.1:9200
anet passwd          # 交互改强密码（≥ 8 位 + 非弱密码字典）
```

或起 hub 时直接设：`anet hub start --host 0.0.0.0 --username <your-admin> --password '<strong-pass>'`。
:::

::: details 端口被占？换端口或停旧 hub
```bash
# 查看谁占了端口
ss -tlnp | grep 9200

# 换端口
anet hub start --port 9201

# 或优雅停掉旧 hub (推荐)
anet hub stop                  # 默认端口 9200, SIGTERM → 3s grace → SIGKILL 兜底
anet hub stop --port 9201      # 非默认端口
anet hub status                # 看当前 PID / 端口 / commhub-server 版本

# 万一以上不可用, 兜底手动停
HUB_PID=$(ss -tlnp | grep ':9200' | sed -E 's/.*pid=([0-9]+).*/\1/' | head -1)
kill "$HUB_PID"
# 或如果你的 hub 跑在 tmux 里, 直接 attach + Ctrl+C
tmux a -t anet-hub             # 然后按 Ctrl+C 停, Ctrl+B D 留 tmux 会话
```

::: tip `anet hub --help` 暂时看不到 stop/status?
v2.2.12 latest 的 `anet hub --help` **不列出** `stop` / `status` 子命令(显示 bug, [#240](https://github.com/sleep2agi/agent-network/issues/240) 跟踪, [PR #241](https://github.com/sleep2agi/agent-network/pull/241) 修, 下版 v0.10.16 自然带出); **但命令本身可用** — 跑 `anet hub status` 直接返 `hub running / vX.Y.Z / pid N`.
:::
:::

## 3. CLI 登录

第三个终端（保持 hub 那个 tmux 不动）：

```bash
anet login --hub http://127.0.0.1:9200 --username admin --password anethub
```

登录后 Token 写到 `~/.anet/config.json`，后续 `anet node ...` 命令自动带凭证。

```bash
anet whoami          # 确认身份
```

## 4. 建 Agent 节点（按 runtime 选）

```bash
anet node create my-bot
```

向导会按这个顺序问你：

```text
节点名 → runtime → (仅 claude-agent-sdk 才弹) vendor → model → API Key / 鉴权
```

**runtime 是第一道分叉, 4 选 1, 决定后面要不要配 vendor + 配什么依赖**：

| Runtime | 复杂度 | 适合 | wizard 后续 | 额外依赖 |
|---|---|---|---|---|
| **`claude-code-cli`**（推荐入门） | ⭐ | 已经在用 Claude Code，想白嫖订阅 | 跳过 vendor + model, 直接走本机 claude 登录态 | 本机已 `claude auth login` |
| `claude-agent-sdk` | ⭐⭐ | 程序化用 Anthropic 兼容 API（MiniMax / 书生 / 小米 MiMo 等国产模型走这里） | **弹 vendor 子菜单** → 选 vendor → 选 model → 填 API Key | API Key |
| `codex-sdk` | ⭐⭐⭐ | 写代码 / 跑命令，用 OpenAI Codex | 跳过 vendor, 走 codex 登录态 | agent-node + codex CLI + `codex auth login` |
| `grok-build-acp` | ⭐⭐⭐ | 用 xAI Grok Build 跑任务 | 跳过 vendor, 走 grok 登录态 + `XAI_API_KEY` | grok CLI + `grok auth login` + `XAI_API_KEY` |

::: warning runtime 默认项注意
向导**默认高亮第一项**（当前是 `claude-agent-sdk`），新手一路按 Enter 会落到这条要配 vendor + API Key 的路径上。**建议手动选 `claude-code-cli`** 入门最快（[#237 坑 3](https://github.com/sleep2agi/agent-network/issues/237) 已知 UX 痛点，将来 wizard 默认会调整）。
:::

::: warning 向导**不**问 Telegram
建节点向导走完 (上表所有步骤) 就**结束**, **全程不会问你要 Telegram bot token / 白名单 UID**. Telegram 是建完节点后**用单独命令** `anet channel add telegram` 加上去（[第 6 节](#_6-配-telegram-channel-可选)）。

如果你看到 `anet create` 开头的提示说"optional Telegram channel"那一行，不要被误导以为向导会顺便配 —— 实际不会（[#237 坑 4](https://github.com/sleep2agi/agent-network/issues/237) 已知文案不一致）。
:::

完成后节点配置写到当前目录下：

```text
.anet/nodes/my-bot/config.json
```

验证：

```bash
anet node ls         # 应列出 my-bot
```

## 5. （codex-sdk 专属）额外装 agent-node + codex CLI

如果上一步选了 **`codex-sdk`** 或 **`claude-agent-sdk`** runtime，节点跑起来要 `@sleep2agi/agent-node` 包。设计是「首次用时 npx 懒加载」，但实测懒加载有时 skip 拉不到 → 启动报 `agent-node is not installed or cannot report a version. Run: anet upgrade`（[#237 坑 5](https://github.com/sleep2agi/agent-network/issues/237)）。

兜底**手动装一次**：

```bash
npm i -g @sleep2agi/agent-node

# 验证
agent-node --version    # 期望 v2.4.10 或更新
```

codex-sdk runtime 还要装 codex CLI 并登录：

```bash
# 注意是 @openai/codex (CLI 工具), 跟 @openai/codex-sdk (codex-sdk runtime 拉的 SDK 库) 是两个 npm 包
npm i -g @openai/codex
codex auth login        # 浏览器 OAuth

# 验证
codex --version
```

`claude-agent-sdk` runtime 不需要装 codex / claude CLI —— 只要在节点 config 里填了对应 vendor 的 API Key（或对应 env vars `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`）就行。

## 6. 配 Telegram channel（可选）

如果你想从 Telegram 直接给 agent 发任务：

### 6.1 拿 bot token + 你的 Telegram User ID

1. Telegram 里搜 **@BotFather** → `/newbot` → 一路按提示，最后给你一段 `bot-token`（形如 `1234567:ABCDef...`）
2. 拿你的 Telegram User ID（数字）：找 **@userinfobot** 发任意消息，它会回你的 UID

### 6.2 给节点加 telegram channel

```bash
anet channel add telegram my-bot \
  --bot-token <bot-token> \
  --allow <uid>
```

参数：
- `<bot-token>`：BotFather 给的串
- `<uid>`：能给这个 bot 发任务的 Telegram User ID（多个用逗号隔开：`--allow 11111,22222`）

验证落地：

```bash
anet channel ls
# 应列出: my-bot (my-bot) telegram     allow: <uid>
```

::: tip 想加更多人？
`anet channel add telegram <node> --allow <new-uid-list>` **会覆盖** allowlist，不是追加。要保留原来的人就把完整列表再传一遍（`--allow 11111,22222,33333`）。这是已知坑 ([guide/channels.md](/guide/channels#known-gaps-and-pitfalls))，未来会改 append。
:::

## 7. 启动节点

```bash
# 推荐 tmux 挂着（跟 hub 同款，免得关终端停）
tmux new -s anet-my-bot
anet node start my-bot
```

::: warning claude-code-cli 节点首次启动会弹「dev-channels 确认框」
`claude-code-cli` runtime 首次启动会弹 Claude Code 的 `--dangerously-load-development-channels` 确认框：

```text
❯ 1. I am using this for local development
  2. Exit
```

**按 1 + Enter**。脚本化 / detached 启动时**没人按会卡住**，节点一直显示 offline（[#237 坑 6](https://github.com/sleep2agi/agent-network/issues/237) 已知）。

兜底：先用 tmux 前台手动按一次，之后再考虑 systemd 接管 —— Claude Code 那个确认是会话级的，首次按完后续就不弹了。
:::

看到 `SSE connected` 即节点上线，回 hub 那边 `anet status` 应列出 `my-bot` online。

按 `Ctrl+B D` 把 tmux 断开保活。

## 7. 持久化（systemd 模板待补）

::: warning 暂用 tmux，systemd 模板待 ship
当前 anet **没有官方 `--daemon` 或 systemd unit 模板**（[#237 坑 8](https://github.com/sleep2agi/agent-network/issues/237) 跟进中）。hub + 每个节点都靠 tmux 挂着，**机器重启全部掉线**得手动 attach + 重起。

短期 workaround：
- hub: `tmux new -s anet-hub` + `anet hub start --host 0.0.0.0`
- 每个节点: `tmux new -s anet-<alias>` + `anet node start <alias>`
- 重启脚本可以 stuff 进 `@reboot` crontab，但 PATH / nvm 这些非交互 shell 问题要先解决（见 [第 0 节 nvm 提示](#_0-前置)）

工程马的 systemd 模板出来后，本节会更新真正的 unit 文件示例 + 开机自启步骤。
:::

## 故障排查表（8 坑 mapping）

按今天实测踩过的顺序，**报错 → 原因 → 解法**：

| # | 现象 | 原因 | 解法 |
|---|---|---|---|
| 1 | `anet hub start` → `spawn bunx ENOENT` + node stack crash | 机器没装 Bun，commhub-server 是 Bun-shebang TS | `npm i -g bun` 或 `curl -fsSL https://bun.sh/install \| bash`；之后 `bun --version` 应有输出。**[#235](https://github.com/sleep2agi/agent-network/issues/235)** 跟进给 preflight + 友好提示 |
| 2 | `anet node create` 选完 runtime → `FATAL: TypeError: fetch failed` | 建节点要连本地 hub，但 hub 没起（多半因为坑 1） | 另开终端先 `anet hub start`，再回这条重试。**[#237](https://github.com/sleep2agi/agent-network/issues/237)** 主条跟进给 fetch 分类报错 |
| 3 | 一路 Enter 落到要填 vendor + API Key 的复杂路径 | runtime 菜单默认高亮 `claude-agent-sdk`，不是最易上手的 `claude-code-cli` | 建节点时**手动选 `claude-code-cli`**（已 `claude auth login` 直接复用订阅）。中断 vendor 选择如果留下半成品节点，用 `anet node delete <alias>` 清掉重来 |
| 4 | 建完节点 Telegram 不工作，但向导开头说"optional Telegram channel" | 向导根本不问 Telegram，那行是误导文案 | Telegram 用 `anet channel add telegram <node> --bot-token <tok> --allow <uid>` 单独配（见 [第 6 节](#_6-配-telegram-channel-可选)） |
| 5 | `anet node start` (codex-sdk / claude-agent-sdk) → `agent-node is not installed or cannot report a version` | npx 懒加载没拉到 `@sleep2agi/agent-node` | `npm i -g @sleep2agi/agent-node`；然后 `agent-node --version` 应输出 |
| 6 | `claude-code-cli` 节点起来后卡 offline / pane 卡在确认框 | Claude Code 的 `--dangerously-load-development-channels` 确认框等人按 Enter | 用 tmux 前台跑一次手动按 `1` + Enter；后续就不弹了 |
| 7 | systemd / cron / 新用户启动报一连串 `command not found` | nvm + Bun 各自按用户装，非交互 shell 不加载 | 把 node/npm/bun 软链到 `/usr/local/bin/`，或启动脚本里显式 `source ~/.nvm/nvm.sh` |
| 8 | 机器重启全部掉线 | hub + 节点都靠手动 tmux 挂着 | 当前只能手动重启；systemd / pm2 模板待 ship（[#237 坑 8](https://github.com/sleep2agi/agent-network/issues/237)） |

---

## 下一步

- [上手指南](/guide/getting-started) — 已经装好 anet 的端到端走查（笔记本场景）
- [一键安装](/guide/one-shot-install) — `setup-anet.sh` 自动起 hub + dashboard + 多 agent
- [生产部署 / 公网部署安全](/deploy/production) — TLS / 防火墙 / 备份 / 公网风险点
- [Channel 接入](/guide/channels) — Telegram / WeChat / 飞书 完整接入手册
- [节点 Runtime](/guide/runtimes) — 4 个 runtime 详细对比

如果踩到本页没覆盖的坑，欢迎到 [GitHub Issues](https://github.com/sleep2agi/agent-network/issues) 开一条 + cite 哪一步、什么报错、`anet -v` 输出。

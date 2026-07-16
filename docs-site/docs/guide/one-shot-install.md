# 一键安装（多 Agent + tmux）

::: warning ⚠️ 实验性 — 未经端到端验证, 用前自审
**Vincent 2026-06-29 反馈**: `setup-anet.sh` **未经维护者端到端验证**——脚本文件挂在 `https://anet.sh/setup-anet.sh` 可下载（且语法上完整），但没有在干净 Ubuntu/Debian 上跑通的可复现 smoke 报告。`MINIMAX_KEY=sk-cp-你的key` 这个 vendor key 形式也可能跟 MiniMax 当前 API 不符——以 [多模型配置](/guide/multi-model) 里 verified-with-real-call 的 vendor 为准。

**推荐路径**: 跟 [上手指南](/guide/getting-started)（已验证 5 终端手动流程）+ [干净服务器从零部署](/deploy/clean-server)（含 systemd 模板）。

下面内容**保留作脚本作者参考**，但用前请自行审计 + 在隔离环境试跑。
:::

如果你想在一台空 Ubuntu/Debian 服务器上**一行命令**起完整 Agent Network（hub + dashboard + 多个 agent，每个进程一个独立 tmux session），用 `setup-anet.sh`。

## 适用场景

- ✅ 在云服务器（阿里云 / AWS / DO）部署一整套
- ✅ 给团队演示 multi-agent 协作
- ✅ 本地 LAN 多机测试

## 前置依赖

脚本会自动安装下面所有缺失的包：

- `nodejs ≥ 22.13.0`（`@sleep2agi/agent-network` `engines.node`）
- `npm`
- `tmux`
- `bun`（commhub-server 需要）
- `unzip`、`curl`、`ca-certificates`

如果当前是 `root`，脚本会**自动建非 root 用户 `anet`**（Claude Code 拒绝 root 下用 `--dangerously-skip-permissions`，必须切非 root）。

## 一行命令

```bash
curl -fsSL https://anet.sh/setup-anet.sh \
  | MINIMAX_KEY=sk-cp-你的key bash
```

或者保存到本地后执行：

```bash
curl -fsSL https://anet.sh/setup-anet.sh \
  -o setup-anet.sh
chmod +x setup-anet.sh
MINIMAX_KEY=sk-cp-你的key ./setup-anet.sh
```

## 自定义

| 环境变量 | 默认 | 作用 |
|---|---|---|
| `MINIMAX_KEY` | （必填） | MiniMax API key（`ANTHROPIC_AUTH_TOKEN`） |
| `MINIMAX_MODEL` | `MiniMax-M2.7` | 走哪个 MiniMax 模型 ID |
| `ANET_HUB_IP` | `0.0.0.0` | Hub + Dashboard 绑定地址（0.0.0.0 = LAN 可访问，改 `127.0.0.1` 限本机） |
| `ANET_USER` | `anet` | 非 root 用户名（脚本自动创建） |
| `WIPE` | `0` | 设 `1` 启动前清光所有状态（tmux session / `~/.anet` / `~/.commhub` / npx cache），调试时常用 |

```bash
# 自定义节点列表（默认 5 个：排版发布者 / 主编 / 信息采集 / 编辑 / 审核）
MINIMAX_KEY=sk-cp-xxx ./setup-anet.sh 节点A 节点B 节点C

# 选择 MiniMax 模型
MINIMAX_KEY=sk-cp-xxx MINIMAX_MODEL=MiniMax-M3 ./setup-anet.sh

# 改 Hub 绑定地址
MINIMAX_KEY=sk-cp-xxx ANET_HUB_IP=127.0.0.1 ./setup-anet.sh

# 改非 root 用户名
MINIMAX_KEY=sk-cp-xxx ANET_USER=worker ./setup-anet.sh

# 全清重跑（卸 tmux + 删 ~/.anet / ~/.commhub + 清 npx cache，再装一遍）
MINIMAX_KEY=sk-cp-xxx WIPE=1 ./setup-anet.sh
```

## MiniMax 可用模型

| 模型 ID | 备注 |
|---|---|
| `MiniMax-M3` | **当前最新**（vision-capable；anet 向导默认）—— 推荐显式设 `MINIMAX_MODEL=MiniMax-M3` |
| `MiniMax-M2.7` | `setup-anet.sh` 默认 fallback（MiniMax 迭代后请到官方文档查最新 model id） |
| `MiniMax-M2.7-highspeed` | 高速版 |
| `MiniMax-M2.5` | |
| `MiniMax-M2.5-highspeed` | |
| `MiniMax-M2.1` | |
| `MiniMax-M2.1-highspeed` | |
| `MiniMax-M2` | 旧版 |

参考 [MiniMax 官方文档](https://platform.minimaxi.com/docs/api-reference/text-anthropic-api)。

## 跑完后

每个进程在独立 tmux session 里：

```bash
tmux ls
# anet-hub: 1 windows ...
# anet-dashboard: 1 windows ...
# anet-node-排版发布者: 1 windows ...
# anet-node-主编: 1 windows ...
# ...
```

操作：

```bash
# attach 到某个进程查看输出
tmux a -t anet-hub
tmux a -t anet-dashboard
tmux a -t anet-node-主编

# detach（保留运行）：Ctrl-b 然后 d

# 停掉某一个
tmux kill-session -t anet-node-编辑

# 停掉整个网络
tmux ls | awk -F: '/^anet-/{print $1}' | xargs -I{} tmux kill-session -t {}
```

默认端口：

| 服务 | 端口 | tmux session |
|---|---|---|
| CommHub Server | `9200` | `anet-hub` |
| Dashboard | `3000` | `anet-dashboard` |
| Agent Node | `stdio` 进程内（无网络端口） | `anet-node-<alias>` |

打开浏览器访问：

```
http://你的服务器IP:3000
```

用 `admin / anethub` 登录。所有节点在 Nodes 页面里可见，点任意节点可以发任务。**登录后立刻 `anet passwd` 改强密码**（参考 [troubleshooting → 密码强度](/troubleshooting)）。

## 已验证

- 在 fresh `ubuntu:22.04` Docker 容器里端到端测过：约 70-90s 完成全套（依赖安装 + 包下载 + 起 5 个 agent）
- Hub 健康 + Dashboard 200 + 全部 agent register 成 idle
- 真实 MiniMax key 下，agent 间能通过 commhub MCP 工具互相发任务并整合回复

## 已知限制（未验证）

- 仅在 Ubuntu 22.04 / 24.04 上验证；CentOS / RHEL 的 apt-get 命令需要替换。
- Bun 安装走 `curl bun.sh/install`，需要外网；内网环境请预装 Bun。
- 如果 `MINIMAX_KEY` 错或模型 ID 错，脚本会成功跑完但 agent 处理任务时返回 failed —— 检查 `tmux a -t anet-node-<alias>` 那个 session 的 `[stderr]` 行。

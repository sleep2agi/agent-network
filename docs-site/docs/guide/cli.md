# CLI 命令参考

`anet` 管理 Hub、账号、Network、节点和外部 Channel。本页只保留当前命令与容易误操作的行为；专题配置请进入对应指南。

## 安装与帮助

```bash
# 稳定版
npm install -g @sleep2agi/agent-network@latest

# 预览版
npm install -g @sleep2agi/agent-network@preview

anet --help
anet <command> --help
anet -v
```

需要 Node.js 22.13+ 和 Bun 1.2+。`--help` 只显示帮助，不会创建 token、启动服务或执行其他业务操作。

## 最短启动路径

```bash
# 终端 1
anet hub start

# 终端 2
anet login --hub http://127.0.0.1:9200 --username admin

# 登录后
anet node create my-agent
anet node start my-agent
```

初始密码随发布频道不同：stable（`@latest`）使用固定默认值，可在 `anet hub start --help` 的 `--password` 说明中查看；preview（`@preview`）首次启动会打印一次性随机密码。登录后立即运行 `anet passwd`。

完整安装与首次配置见 [快速开始](/guide/getting-started)。

## Hub

| 命令 | 作用 |
|---|---|
| `anet hub start` | 启动 Hub；默认监听 `127.0.0.1:9200` |
| `anet hub stop [--port <p>]` | 停止指定端口上的本机 Hub |
| `anet hub status [--port <p>]` | 显示监听状态、PID 和服务版本 |
| `anet hub dashboard` | 启动 Dashboard，默认端口 `3000` |
| `anet hub config` | 查看或修改本机 Hub 启动配置 |
| `anet hub admin reset-user --username <user>` | 在 Hub 主机上重置用户密码和用户 token |

常用启动参数：

| 参数 | 说明 |
|---|---|
| `--port <port>` | Hub 端口，默认 `9200` |
| `--host <host>` / `--ip <host>` | 绑定地址，默认仅本机的 `127.0.0.1` |
| `--username <user>` | 首次启动时指定管理员用户名 |
| `--password <pass>` | 首次启动时显式指定管理员密码 |
| `--dev-open` | 关闭鉴权，仅限隔离开发环境 |

不要把 `--dev-open` 或直接暴露的 `0.0.0.0:9200` 用于生产。公网部署见 [生产部署](/deploy/production)。

## 账号、Network 与 Token

### 账号

| 命令 | 作用 |
|---|---|
| `anet register` | 创建账号 |
| `anet login` | 使用用户名和密码登录 |
| `anet login --token <token>` | 使用已有 API token 登录 |
| `anet logout` | 删除本机保存的登录 token；不会撤销 Hub 上的 token |
| `anet whoami` | 显示当前用户和可访问的 Network |
| `anet passwd` | 修改密码并轮换当前登录 token |

### Network

| 命令 | 作用 |
|---|---|
| `anet network ls` | 列出当前用户加入的 Network |
| `anet network create <name>` | 创建 Network |
| `anet network use <name>` | 切换当前 Network |
| `anet network info` | 查看当前 Network |
| `anet network rename <old> <new>` | 重命名 Network |
| `anet network delete <name> --force` | 删除 Network |
| `anet network invite [options]` | 创建邀请码 |
| `anet network join <code>` | 使用邀请码加入 Network |
| `anet network members` | 列出当前 Network 成员 |

邀请码可使用 `--role admin|member|viewer`、`--uses <n>` 和 `--expires <days>`。

### Token

| 命令 | 作用 |
|---|---|
| `anet token` / `anet token ls` | 列出当前用户的 API token |
| `anet token create <name>` | 创建 API token；明文只显示一次 |
| `anet token revoke <token-id>` | 撤销 token |

Token 类型、作用域与兼容规则见 [Token 体系](/concepts/tokens)。

<a id="agent-node-管理"></a>
<a id="anet-node-create"></a>
<a id="anet-node-start"></a>

## 节点

| 命令 | 作用 |
|---|---|
| `anet node create <name>` | 创建节点；未指定 runtime 时进入向导 |
| `anet node start <name>` | 在当前终端启动节点 |
| `anet node start <name> --tmux` | 在 tmux 中启动或连接节点 |
| `anet node stop <name>` | 停止节点及其同名 tmux session |
| `anet node restart <name>` | 停止后重新启动单个节点 |
| `anet node resume <name> [--session <id>]` | 使用保存的会话或指定会话恢复 |
| `anet node delete <name> --force` | 删除本地节点配置 |
| `anet node rename <ref> <new>` | 重命名已在 Hub 注册的节点 |
| `anet node edit <ref> --runtime <id>` | 改已存在节点的 runtime；**要重启才生效** |
| `anet node ls` | 列出本地节点及网络状态 |
| `anet info <name>` | 显示节点配置、进程和近期任务 |
| `anet logs <name> [--follow]` | 查看或追踪节点日志 |
| `anet node migrate-token-to-envref <name>` | 将配置中的明文 secret 改为 envRef，并先生成备份 |

`node delete` 不会自动撤销该节点已签发的 `ntok_`；需要彻底失效时另行执行 `anet token revoke <token-id>`。

`COMMHUB_TOKEN` 不是 CLI 参数，也不存在 `anet node start --token`。节点鉴权按节点配置、全局配置、legacy `COMMHUB_TOKEN` 环境变量的顺序取值；`anet login --token` 登录的是 CLI 用户，不是向 `node start` 临时注入节点 token。

创建节点时常用参数：

| 参数 | 说明 |
|---|---|
| `--runtime <runtime>` | 指定 runtime；可用值以当前频道的创建向导和 [Runtime 对比](/guide/runtimes) 为准 |
| `--model <id>` | 覆盖 runtime 默认模型 |
| `--resume <id>` | `claude-code-cli`：绑定指定 Claude Code session |
| `--resume-latest` | `claude-code-cli`：绑定当前项目最近的 session |
| `--tools <list>` | 为支持该选项的 runtime 配置工具集 |

`anet session ls` 可列出当前目录下的 Claude Code sessions。不同 runtime 的会话语义不同，不要把 Claude session ID 当作 Codex thread ID 使用。

## 项目批量管理

这些命令扫描当前目录的 `.anet/nodes/`：

| 命令 | 作用 |
|---|---|
| `anet project up` | 启动所有未运行节点 |
| `anet project restart` | 重启所有节点 |
| `anet project down` | 停止所有节点并上报离线 |

共享参数：

- `--stagger <seconds>`：节点间错峰，默认 3 秒，`0` 表示关闭。
- `--only a,b`：只处理列出的 alias 或 node ID。
- `--exclude x,y`：跳过列出的 alias 或 node ID。

批量创建和清理见 [批量 Agent](/guide/batch)。

## Channel

| 命令 | 作用 |
|---|---|
| `anet channel add telegram <node> --bot-token <token> --allow <uid>` | 添加 Telegram |
| `anet channel add feishu <node> ...` | 添加飞书；当前为 preview 能力 |
| `anet channel allow feishu <node> ...` | 修改飞书私聊或群聊白名单 |
| `anet channel ls [node]` | 列出 Channel |
| `anet channel status [node]` | 显示 Telegram 实际配置路径和白名单 |

Channel 配置不会热加载，修改后需要重启节点。`anet channel add wechat` 尚未发布。完整命令见 [Channel 接入](/guide/channels)。

## Goal

| 命令 | 作用 |
|---|---|
| `anet goal list [node]` | 列出本地 goal |
| `anet goal show <node> <id>` | 查看详情与进度记录 |
| `anet goal wake-log <node> <id> [--tail N] [--json]` | 导出完整 wake 历史 |
| `anet goal edit <node> <id> ...` | 修改 interval、文本或状态 |
| `anet goal cancel <node> <id>` | 标记为 cancelled |
| `anet node loop <node> "<task>" [--every 5m]` | 向在线节点创建周期任务，并等待最多 15 秒确认 |

`node loop` 通过 Hub 投递 `/aloop`；`goal edit/cancel` 则直接修改 `.anet/nodes/<node>/goals.json`。运行中的节点不会自动重载外部文件修改，使用 `edit/cancel` 后请重启节点。Dashboard 原生 `/goal`、`/loop` 与 ANet `/aloop`、`/agoal` 的语义、状态和自管理工具见 [Goal 与 Loop](/guide/goals-and-loops)。

## 诊断与维护

| 命令 | 作用 |
|---|---|
| `anet status` | 显示当前 Network 的节点和任务概览 |
| `anet tasks [status] [--limit <n>]` | 查询任务 |
| `anet doctor` | 检查配置、Hub、依赖、secret 与 Channel |
| `anet doctor --fix` | 执行兼容迁移并修复可自动恢复的 token 问题；会修改配置 |
| `anet upgrade [--channel latest|preview] [--dry-run]` | 检查并执行频道内升级 |
| `anet config` / `anet config path` / `anet config json` | 查看全局配置摘要、路径或原始 JSON |
| `anet init` | 配置 Hub URL |
| `anet init project` | 在当前目录创建 CommHub MCP 项目配置 |
| `anet setup` | 安装所选 runtime 的依赖 |

升级细节见 [升级指南](/guide/upgrade)。

### `anet status` 的四个数字怎么读

```
  CommHub: http://127.0.0.1:9200
  Agents: 127 idle, 0 working, 1 needs attention, 143 offline
          └─ 18 掉线 1-3 天, 27 掉线超过 3 天
  SSE:    12 connected
  Tasks:  10 recent
```

| 数字 | 含义 |
|---|---|
| `idle` | 空闲,等派活 |
| `working` | **正在推进**一个回合(含 `waiting_input` —— 回合还在,只是在等人) |
| `needs attention` | **需要人看一眼**:`blocked` / `error`,以及任何本版本不认识的状态 |
| `offline` | 心跳过期,或已正常停止 |

四个数相加等于节点总数。`needs attention` 为 0 时那一格不显示。

### `offline` 下面那一行:它掉了多久

有 offline 节点时会多印一行分档。**「刚停的」和「掉了三天没人发现的」原先是
同一个数字。**实测过一次(84 台节点):45 台 offline 里 27 台超过 3 天、
18 台 1-3 天、**近 6 小时内 0 台** —— 「当前没有活故障」和「有 45 台掉了」
是完全不同的两个结论,而屏幕上原本只有后者。

拿不到时间戳的节点单独归入「无时间戳(不知道掉了多久)」,**不并进最新那一档**
—— 「我不知道它掉了多久」和「它刚掉」是两件事。

🔴 **`blocked` 没有对应的时长,而且不该有。** 名册里没有「何时变成 blocked」
这个字段;`updated_at` 被心跳一直刷,拿它当已 blocked 时长,会给一个卡了很久的
节点印出「4 分钟前」—— 比不显示更糟。详见
[这个节点还活着吗](/troubleshooting/is-this-node-alive)。

🔴 **`blocked` / `error` 不算在 `working` 里。** 它们的含义是「卡住了」而不是
「在干活」—— 一个卡住的节点如果被算进 `working`,运维看到「N working」会以为
一切正常。`needs attention` 大于 0 时,下面会列出是哪几个节点、它们自报的状态、
以及当时的任务。

⚠️ **这些状态是 agent 自报的,不含活性成分。** 一个进程已经死掉但还没被心跳
清扫的节点,在这里仍可能显示成 `idle`。要确认它还在不在,**发一条任务试试** ——
`anet status` 回答的是「它上次说自己怎么样」,不是「它现在还在不在」。


## Preview 专属能力

以下能力存在于当前 preview，不应写成 stable 已支持：

| 命令 | 作用 |
|---|---|
| `anet daemon up [name]` | 创建并启动 `host_supervisor` —— **仅 preview 通道** |
| `anet daemon init <name>` / `start <name>` / `restart <name>` / `list` | 管理本机 daemon —— **仅 preview 通道** |
| `anet node start <name> --copresence` | 启动 Codex app-server、桥和共享 TUI |
| `anet opencode ...` | 管理 OpenCode preview 集成 |

🔴 **停 / 删 / 看没有 daemon 版。** daemon 就是一个 `role=host_supervisor` 的 agent-node,
所以用 node 级命令:`anet node stop <name>` 停、`anet node delete <name>` 删、
`anet node ls` 看它在不在跑(`anet daemon list` 只列本机配置过的 daemon,不含活性)。
`anet daemon restart` 内部调的正是 `anet node stop` 用的那个 stop。

`--copresence` 只适用于 `runtime=codex-app-server`。默认沙箱为只读；开启完整文件系统和网络访问需要 `--dangerously-allow-full-access`。TTY 会要求输入 `yes`，非 TTY 还必须同时提供 `--yes-danger-full-access`。

恢复共存节点时仍应使用 `anet node start <name> --copresence`，不能改用普通 `node start`。

`opencode-cli` 当前是由 agent-node 管理的任务 runtime，不是可 attach 的共享 OpenCode TUI。`grok-build-cli` 共享 Grok TUI 也未进入当前 preview 包；当前可用的 `grok-build-acp` 不支持 attach。

<a id="其他"></a>

## 其他命令

| 命令 | 作用 |
|---|---|
| `anet import [alias]` | 从 Hub 导入可恢复的本地节点配置 |
| `anet run --alias <name>` | 启动不调用 LLM 的最小 SSE echo agent |
| `anet demo [name]` | 运行实验性演示；不作为生产编排方案 |
| `anet batch <verb>` | 管理 `anet create --batch` 创建的批次 |
| `anet license` / `anet activate <key>` | legacy 许可证兼容命令；Apache-2.0 用户通常无需使用 |

旧别名 `anet create`、`anet start` 等仍为兼容保留，新文档统一使用 `anet node ...`。

## 配置位置与环境变量

| 路径 | 内容 |
|---|---|
| `~/.anet/config.json` | 当前 Hub、用户 token 和 Network |
| `.anet/nodes/<node>/config.json` | 节点配置 |
| `~/.commhub/commhub.db` | 默认 Hub SQLite 数据库 |
| `~/.anet/server/admin-utok.json` | Hub 主机的本地管理员恢复 token |

常见环境变量：

| 变量 | 作用 |
|---|---|
| `COMMHUB_URL` | Hub URL |
| `COMMHUB_ALIAS` | 节点 alias |
| `COMMHUB_TOKEN` | 认证 token；节点配置中的 token 优先级更高 |
| `COMMHUB_AUTH_TOKEN` | legacy Hub master-token 兼容入口；新部署使用用户和节点 token |
| `ANTHROPIC_BASE_URL` | Anthropic 兼容模型端点 |
| `ANTHROPIC_AUTH_TOKEN` | 第三方 Anthropic 兼容端点凭据 |
| `ANTHROPIC_API_KEY` | Anthropic 官方端点凭据 |

Secret 建议使用 envRef，不要把 token 或模型密钥直接提交到配置仓库。详见 [安全设计](/concepts/security)。

## 延伸阅读

- [快速开始](/guide/getting-started)
- [Agent Node 配置](/guide/agent-node)
- [Runtime 对比](/guide/runtimes)
- [Channel 接入](/guide/channels)
- [Token 体系](/concepts/tokens)

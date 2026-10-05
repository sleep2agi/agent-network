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
anet <command> <subcommand> --help   # 例如 anet node delete --help
anet -v
```

需要 Node.js 22.13+ 和 Bun 1.2+。`--help`（或 `-h`）只显示帮助，不会创建 token、启动服务或执行其他业务操作。每个命令和子命令都有自己的用法说明，退出码 0。

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
| `--version <v>` | 指定要启动的 `commhub-server` 版本（精确版本号，或 `latest` / `preview`） |
| `--channel <c>` | `latest` 或 `preview`，覆盖默认按 anet 自身通道选版本的结果 |

**启动的 Hub 版本**：不带 `--version` 时，`anet hub start` 先按已装 anet 的版本对照 `@sleep2agi/agent-network` 的 dist-tags 判断通道（等于或落后于 `latest` 判为 latest，比 `latest` 新的预发布版判为 preview；不能只看 `-preview.N` 后缀，`latest` 本身也带这个后缀），再取该通道对应的 `@sleep2agi/commhub-server` dist-tag，交给 `bunx` 精确版本号启动；该 tag 若比当前 anet 支持的最低版本还旧，则改用最低版本。启动时会打印一行 `Hub version: @sleep2agi/commhub-server@<版本>  [source: registry | cache | explicit | pinned minimum]`，说明版本和来源。查不到 npm registry 时，使用本机 bun 缓存里不低于最低版本的最新一版并告警；缓存里只有更旧的版本时**不会**静默启动它，而是打印两个版本号的告警，并提示用 `--version <缓存版本>` 显式启动。

不要把 `--dev-open` 或直接暴露的 `0.0.0.0:9200` 用于生产。公网部署见 [生产部署](/deploy/production)。

<a id="anet-hub-stop"></a>
**停止 Hub（`anet hub stop`）**：只停**监听在该端口上、且命令行确认是 `commhub-server`** 的进程，不按进程名匹配。找监听进程不依赖 `lsof`：Linux 依次用 `/proc/net/tcp(6)` 的 socket inode 对 `/proc/<pid>/fd`、`ss -ltnp`、`lsof`、`netstat`，macOS 用 `lsof`、`netstat -anv`，Windows 用 `netstat -ano`，取第一条能运行的；都不能运行时，用 `anet hub start` 写的 `~/.anet/server/hub-<port>.pid.json`（PID 已退出或已被别的程序复用时忽略）。输出会列出每条探测的结果、找到的 PID 和命令行，以及实际停掉了哪个 PID。先 SIGTERM，3 秒后仍在则在再次确认命令行后 SIGKILL。

| 情况 | 动作 | 退出码 |
|---|---|---|
| 找到 `commhub-server` 并已停止 | 停止 | 0 |
| 该端口没有监听、`/health` 也不应答 | 不动 | 0 |
| 端口被别的程序占用，或读不到它的命令行 / 属主 | **拒绝**，打印 PID 和命令行 | 1 |
| `/health` 有应答，但本机找不到它的 PID（没有任何探测可用，也没有 pid 文件） | 不动，提示用启动它的进程管理器（pm2、systemd 等）停 | 1 |
| SIGKILL 后进程仍在，或 `/health` 仍有应答 | — | 1 |
| `--port` 不是合法端口 | — | 2 |

## 账号、Network 与 Token

### 账号

| 命令 | 作用 |
|---|---|
| `anet register` | 创建账号 |
| `anet login` | 使用用户名和密码登录 |
| `anet login --token <token>` | 使用已有 API token 登录 |
| `anet logout` | 先在 Hub 上撤销本次登录会话，再删除本机保存的登录 token（见下方 [退出登录](#anet-logout)） |
| `anet whoami` | 显示当前用户和可访问的 Network |
| `anet passwd` | 修改密码并轮换当前登录 token |

<a id="anet-logout"></a>
**退出登录（`anet logout`）**：用保存的 token 调 `GET /api/auth/sessions` 取得 `current_token_id`，再 `DELETE /api/auth/sessions/<token_id>` 撤销这一条登录会话（与 app「设置 → 账号 → 登录设备 → 退出」同一对端点，见 [登录设备 API](/api/rest#sessions)），然后删除 `~/.anet/config.json` 里的 `token` / `user` / `network_id` / `network_name`（保留 `hub`）。输出只显示 token id，不显示 token。

| 情况 | 本地 | 服务端 | 退出码 |
|---|---|---|---|
| 撤销成功 / token 在 Hub 上本来就已失效（401） | 删除 | 已失效 | 0 |
| Hub 连不上、Hub 早于 v0.9.0-preview.70（`/api/auth/sessions` 404） | 删除 | **仍有效**，打印 ⚠ 警告与撤销方法 | 0 |
| 保存的是 `anet login --token` 用的显式 API token 或节点 token | 删除 | **不撤销**（它可能还在别处用），打印 ⚠ 警告；用 `anet token revoke <token-id>` 撤 | 0 |
| 本地配置文件写不了 | 未删除 | — | 1 |

服务端仍有效时的撤销办法：app「设置 → 账号 → 登录设备」里退出那台设备；或重新 `anet login` 后 `anet passwd`（改密码会撤销其他所有登录会话）。`anet init project` 写进各项目 `.anet/.env` 的 `COMMHUB_TOKEN` 是同一个 token 的副本，服务端撤销后一起失效。

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

Token 类型、作用域与兼容规则见 [Token 体系](/guide/account-system#tokens)。

<a id="agent-node-管理"></a>
<a id="anet-node-create"></a>
<a id="anet-node-start"></a>

## 节点

### 交互菜单：`anet node`

不想记命令：在节点目录里直接敲 `anet node`（不带参数）。它列出当前目录的所有节点 —— 节点名、runtime（claude-agent-sdk / claude-code-cli / codex-* / grok-* / opencode-cli）、状态（running / stopped）、模型，codex 节点另有登录列 —— 选一个节点再选操作：启动、停止、重启、进入 TUI（attach）、看最近日志、换模型、删除。

- 每个操作执行前都会打印**等价的 `anet …` 命令**，回答 `y` 才执行；删除要输入节点名确认。执行的就是打印出来的那条命令，菜单本身不做任何生命周期动作。
- codex 节点选中后交给 codex 专属操作（登录、接着聊、复制等），与 `anet node codex` 相同，见 [Codex 节点速查](/guide/codex-cheatsheet)。
- 不是终端（管道、脚本、agent 调用）时只打印节点表、一份速查和原来的用法行，退出码 0；输出不含任何 token。
- `anet node --help` / `anet node help` 与以前一样只打印帮助。

codex 节点不想记命令：在节点目录里敲 `anet node codex`，选节点、选操作，执行前会打印等价命令并确认。速查表见 [Codex 节点速查：我想……就敲……](/guide/codex-cheatsheet)。

| 命令 | 作用 |
|---|---|
| `anet node create <name>` | 创建节点；未指定 runtime 时进入向导 |
| `anet node start <name>` | 在当前终端启动节点 |
| `anet node start <name> --tmux` | 在 tmux 中启动或连接节点 |
| `anet node stop <name>` | 停止节点及其同名 tmux session |
| `anet node restart <name>` | 停止后重新启动单个节点 |
| `anet node resume <name> [--session <id>]` | 使用保存的会话或指定会话恢复 |
| `anet node delete <name> --force` | 删除本地节点配置，并删掉它在 Hub 上的那一行 |
| `anet node rename <ref> <new>` | 重命名已在 Hub 注册的节点 |
| `anet node clone <src> <new>` | 复制节点设置，生成一个**新身份**的节点（见下文「复制节点」） |
| `anet node edit <ref> [--runtime <id>] [--model <id>]` | 改已存在节点的 runtime / 模型；**要重启才生效** |
| `anet node ls` | 列出本地节点及网络状态 |
| `anet node ls --all [--network <id\|name>] [--json]` | 列出 Hub 上当前 Network 里你能看到的**全部**节点，按机器（hostname）分组（只读，见下文） |
| `anet info <name>` | 显示节点配置、进程和近期任务 |
| `anet logs <name> [--follow]` | 查看或追踪节点日志 |
| `anet node migrate-token-to-envref <name>` | 将配置中的明文 secret 改为 envRef，并先生成备份 |

`anet node ls --all` 不看当前目录，而是用你 `anet login` 的身份读 Hub（`/api/status` + `/api/host-supervisors`），
把当前 Network（或 `--network <id|name>` 指定的那个，按 id、名字或唯一 id 前缀匹配）里的节点按机器分组列出：
别名、runtime、状态与最后心跳、模型，以及那台机器上有没有在线的 daemon（`anet daemon`，有在线 daemon 的机器以后才能被远程管理）。

```text
Network: team (net_0123456) — 3 node(s) on 2 machine(s)

  host-alpha   daemon: alpha-daemon online — remote-manageable
    ALIAS     RUNTIME           STATUS   LAST SEEN  MODEL
    a-coder   claude-agent-sdk  idle     12s ago    claude-sonnet-4-5
    a-writer  codex-app-server  working  1m ago     gpt-5

  host-beta   daemon: none visible
    ALIAS     RUNTIME           STATUS   LAST SEEN  MODEL
    b-runner  grok-build-cli    offline  3d ago     -
```

- 权限完全按 Hub 返回的来：被限制了 Agent 访问的成员只看到授权给他的节点；Hub 对这类成员不返回 daemon，
  所以显示 `daemon: none visible`（「没看到」，不等于「没有」）。
- 只用登录令牌（`~/.anet/config.json` 的 `token`），不用 `COMMHUB_TOKEN` 或任何节点令牌。
- `--json` 输出 `{ network, daemons_readable, machines: [{ hostname, daemon, daemons, nodes }] }`。
- 不加 `--all` 时 `anet node ls` 行为不变。

`anet node delete <name> --force` 先做一遍和 `anet node stop` 相同的停止（共存节点的 tmux 会话也一起停：
codex 共存按标记 + `CODEX_HOME` 认，其余只认完整会话名、不按前缀），再删本地（`.anet/nodes/<id>/`），最后删 Hub 上这个节点的那一行，
这样它不会在 app / dashboard 里一直显示「离线」。停不干净就报错退出，什么都不删。

- 节点不在当前目录（clone / codex fork 用了 `--workdir`）时，anet 按源目录 `.anet/child-workdirs.json` 和 codex 登录索引找到它，
  **不替你删**，而是打印 `cd <目录> && anet node delete <name>`，退出码 `1`。
- 同名的节点有好几个时拒绝删除，列出每一个按 `node_id` 删的命令。

- Hub 上的行**只按本地配置里的 `node_id` 匹配**，从不按名字。别的机器上同名的节点（名字复用）
  不会被删；anet 会打印 `Left untouched: … belong to other node_id(s)`。
- Hub 连不上或拒绝时，本地照样删掉，anet 打印警告和**原样可用的重试命令**，退出码 `1`：
  ```bash
  anet node delete <node_id> --hub-only            # 只删 Hub 上那一行
  anet node delete <node_id> --hub-only --hub <url> # 节点用的不是当前登录的 Hub 时
  ```
- 没配置 Hub 时只删本地，退出码 `0`。很早的节点配置里没有 `node_id`，那时 Hub 上的行无法安全匹配，
  anet 不碰它并提示到 app / dashboard 里删。

`node delete` 不会自动撤销该节点已签发的 `ntok_`；需要彻底失效时另行执行 `anet token revoke <token-id>`。

`anet node stop` 只发 **SIGTERM**，最多等 **8 秒**，**不会升级到 SIGKILL**（它没有 `--force`）。
节点在 8 秒内没退出时，anet 打印 `pid <n> survived SIGTERM`、**保留 pidfile**、退出码 1 ——
它宁可报错也不谎称已停，因为一个还活着的旧进程会继续心跳并把 rename 顶回去。
同样的原因，`node restart` 和 `node delete` 这时也会**拒绝执行**。
唯一会主动发 SIGKILL 的是 `anet node rename --force`。

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

### 复制节点

完整说明（clone 与 fork 的对照、复制项清单、codex 登录、怎么删干净）见 [复制节点（clone / fork）与清理](/guide/copy-node)。

想要「再来一个和它一样的节点」，用：

```bash
anet node clone <源节点> <新名字>
# 等价写法
anet node create <新名字> --from <源节点>
```

新节点会在 Hub 上**重新注册**（和 `anet node create` 走同一个接口），拿到自己的 `node_id` 和 `ntok_`；
不加 `--start` 不会启动。完成后会打印一张表，逐项列出 **copied / regenerated / skipped**。

| 类别 | 内容 |
|---|---|
| 复制 | runtime、模型、工具、权限 flags、system prompt、非机密 env、commhub channel；`--workdir` 时还有规则文件（`CLAUDE.md` / `AGENTS.md`）、skills 目录、`.mcp.json`（其中 env / header 的值清空）；codex 节点的 `codex-home/config.toml`、`AGENTS.md`、`skills/` |
| 重新生成 | `node_id`、别名、`ntok_`、claude-code-cli 的 session id、grok 共存 socket、`codexProjectDir` |
| 不复制 | token、所有 session / thread id、日志、pid / 锁、goals、inbox、channel 的 bot 凭据、codex `auth.json`、共存身份文件、机密 env 的**值**（只保留键名，改成指向新节点的 envRef，启动前自己填） |

| 参数 | 说明 |
|---|---|
| `--workdir <dir>` | 放到另一个项目目录（不存在会创建）；**路径必须是英文 / ASCII**（节点名可以是中文，目录不行）。不加时和源节点在同一个项目目录，规则文件和 skills 共用 |
| `--model <id>` | 换一个模型 |
| `--start` | 建完立即启动（有待填的机密时不启动，并提示先填） |

会拒绝：目标已存在、新名字和源节点同名、目标落在源节点自己的目录里、非 ASCII 的 `--workdir`、
opencode-cli 节点（运行时绑定和登录在节点配置之外，请用 `anet node create --runtime opencode-cli` 新建）、
host daemon（`role=host_supervisor`）。

codex 节点的登录不会被复制。一个登录只给一个节点（refresh token 一次性，共用会互相顶掉）：
启动前先给新节点自己登录 `CODEX_HOME=<新节点目录>/codex-home codex login --device-auth`。
没登录就启动时，anet 会把本机 `~/.codex` 的登录放进去——但如果本机已有别的节点在用这份登录，
就拒绝启动（exit 1，`--allow-shared-codex-login` 可强行共享，不安全；见
[一个登录只给一个节点](/guide/codex-copresence#one-login-per-node)）。要用登记过的账号，用
`anet node codex account install <新名字> --source codex-login:<profile-id>`。
要连 codex 会话历史一起带走，用 `anet node codex fork`（见 [Codex 共存](/guide/codex-copresence)）。
在 anet 之外直接用 `codex` 开过的对话，用 `anet node codex adopt <新名字> --thread <id>` 收编成节点（见 [复制节点](/guide/copy-node)）。

::: danger 不要 `cp -r` 节点目录
`.anet/nodes/<name>/config.json` 里存着节点的 `node_id` 和 `ntok_`。原样拷贝出来的「新节点」
和源节点是**同一个 Hub 身份**：两个进程都订阅同一个收件箱，同一个任务会被执行两次、回两次复，
而且 Dashboard 分不清是谁在回。日志、session、codex 登录也一起被共用。复制节点请一律用 `anet node clone`。
:::

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
| `anet config` / `anet config path` / `anet config json` | 查看全局配置摘要、路径或 JSON（token 打码） |
| `anet init` | 配置 Hub URL；换到**另一个** Hub 时，先在旧 Hub 上撤销保存的登录会话（尽力而为，失败只警告），再从配置里删掉旧 Hub 的 token 与登录信息——旧 token 不会发给新 Hub。之后重新 `anet login`。`anet login --hub <另一个 Hub>` 同样处理 |
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
| `anet daemon up [name]` | 创建并启动 `host_supervisor`（版本要求见 [哪些版本有 `anet daemon`](/deploy/daemon#which-versions)） |
| `anet daemon init <name>` / `start <name>` / `restart <name>` / `list` | 管理本机 daemon（版本要求同上；`restart` 另见 [daemon 页](/deploy/daemon)） |
| `anet node start <name> --copresence` | 启动 Codex app-server、桥和共享 TUI |
| `anet opencode ...` | 管理 OpenCode preview 集成 |

🔴 **停 / 删 / 看没有 daemon 版。** daemon 就是一个 `role=host_supervisor` 的 agent-node,
所以用 node 级命令:`anet node stop <name>` 停、`anet node delete <name>` 删、
`anet node ls` 看它在不在跑(`anet daemon list` 只列本机配置过的 daemon,不含活性)。
`anet daemon restart` 内部调的正是 `anet node stop` 用的那个 stop。

::: warning daemon 的两个反直觉之处
**① 对已存在的 daemon，`anet daemon init <name>` 什么都不改。** 它打印
`✓ "<name>" already a host_supervisor daemon` 后直接返回 —— 一个绿色的对勾，
配置一个字节没动。要改配置必须带 `--force`（保留 `node_id`，但**会重新签发
token**，且改完要重启该 daemon 才生效）。

**② 配置里的 runtime 清单是写入那一刻的快照，不会自愈。** 之后新增的 runtime
不会补进已有 daemon 的配置，表现为客户端「选服务器」里那台机器可选的 runtime
比别人少。`anet daemon list` 发现这种情况时会直接打出缺哪几个和回填命令。
:::

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

<a id="exit-codes"></a>

## 退出码

| 退出码 | 含义 |
|---|---|
| `0` | 成功；或只打印帮助（例如不带子命令的 `anet node`、`anet network`，或任何命令 / 子命令加 `--help`、`-h`） |
| `1` | 失败：未初始化 / 未登录 / 登录已过期、Hub 连不上或返回错误、找不到对象、本地写入失败、拒绝执行 |
| `2` | 用法错误：缺少必需参数、未知子命令、非法取值 |

脚本和 CI 可以直接用 `anet … || exit 1` 判断。下列情况在 #515 之前打印了错误却退出 0，现已改为非零：

| 命令 | 情况 | 之前 → 现在 |
|---|---|---|
| `anet whoami` | 未登录 / 登录已过期 / Hub 连不上 | 0 → 1 |
| `anet network <ls\|use\|info\|create\|delete\|rename\|invite\|join\|members>` | 未 init / 未登录、Hub 返回错误、找不到 Network、连不上 | 0 → 1 |
| `anet network create\|use\|delete\|rename\|join`（缺参数）、`anet network <未知子命令>` | 用法错误 | 0 → 2 |
| `anet token ls\|create\|revoke` | 未登录、Hub 返回错误、连不上 | 0 → 1 |
| `anet token revoke`（缺 token id） | 用法错误 | 0 → 2 |
| `anet passwd` | 未登录、两次密码不一致、Hub 拒绝、连不上 | 0 → 1 |
| `anet activate` | 未 init、激活失败、连不上 / 缺 license key | 0 → 1 / 0 → 2 |
| `anet status`、`anet tasks` | 没有配置 Hub；`anet tasks` 连不上 | 0 → 1 |
| `anet hub start` | Hub 15 秒内没起来（含缺 Bun） | 0 → 1 |
| `anet hub stop` | 见上方 [停止 Hub](#anet-hub-stop) | 0 → 1 / 2 |
| `anet hub admin reset-user` | 缺 `--username` / 找不到 DB、重置失败 | 0 → 2 / 0 → 1 |
| `anet hub <未知子命令>`、`anet node <未知子命令>`、`anet session <未知子命令>`、`anet batch <未知动词>` | 用法错误 | 0 → 2 |
| `anet node resume`（缺节点名）、`anet logs`（缺节点名）、`anet batch <动词>`（缺前缀） | 用法错误 | 0 → 2 |
| `anet project down`（有节点停失败）、`anet node delete`（节点进程拒绝退出） | 已经设置了退出码 1，但被 CLI 收尾的 `process.exit(0)` 覆盖 | 0 → 1 |
| `anet upgrade` | 有包升级失败或查不到 registry | 0 → 1 |
| `anet node delete --force` | 本地已删，但 Hub 上那一行没删掉（连不上 / 被拒）；会打印 `--hub-only` 重试命令 | 新行为：1 |
| `anet create --batch`、`anet batch cleanup` | 缺 Hub、预设/参数非法、自动登录失败、一个节点都没建成 | 0 → 1 / 2 |
| `anet demo …` | 缺 Hub / token / key、建 Network 或节点失败 | 0 → 1 |

一些较早的用法错误路径仍退出 `1`（同样是非零，脚本照样能判断），没有为了统一成 `2` 而改动。`anet hub status` 是状态查询，Hub 没运行时仍退出 `0`。

## 报错与密钥

- 出错时 anet 打印一句说明和下一步要敲的命令，不打印堆栈。要看堆栈：`ANET_DEBUG=1 anet …`。
- 以错误码为消息的致命错误仍是 `[anet] FATAL: Error: <CODE>` 这一行，方便脚本从日志里取码。
- anet 不在输出里打印完整密钥：`anet config`、`anet config json`、`anet node start`、`anet doctor` 显示的 token 都是 `utok_…ab12` 这种「前缀…末 4 位」；报错里出现的 token、`Bearer` 头和 URL 里的 `token=` 参数同样打码。
- `anet node create --env KEY=…` 和 `anet node migrate-token-to-envref` 把密钥写进 `.anet/nodes/<node>/.env`（权限 600、已加入 gitignore），只打印打码后的值和一条从该文件读取的 `export` 命令。
- 例外：`anet token create` 和 `anet hub admin reset-user` 的用途就是发出新凭据，只显示这一次。

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
- [Token 体系](/guide/account-system#tokens)

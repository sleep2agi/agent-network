# `anet daemon`：在远程机器上建节点

`anet daemon` 在一台机器上起一个 `host_supervisor` 节点。它连上 Hub 之后，你就可以从
Dashboard 或桌面端在这台机器上创建、启动、停止节点，不必再 SSH 上去敲 `anet node create`。

::: tip 要找的是「让 Hub 崩了能自己起来」？
那是另一件事：用 PM2 / systemd 守护 `anet hub start` 进程，见
[让 Hub 常驻（pm2 / systemd）](/deploy/keep-alive)。两件事互不依赖，可以只做其中一件。
:::

## daemon 是什么 {#what-it-is}

daemon 是一个 `role=host_supervisor` 的 agent-node。它只做确定性的节点生命周期操作：
创建、停止、重启、删除、探测其它节点，全部由 Hub 下发的结构化请求驱动。

- 它不是聊天 agent，不会用大模型理解自由文本。把自然语言任务发给它，只会收到
  「这是程序节点，请用结构化命令」之类的回复。要 AI 干活，请把任务发给普通 agent 节点。
- 它默认以 `dangerouslySkipPermissions` + `teammateMode` 运行，并能通过 Hub 派生子节点。
  **只在你信得过、愿意让它代你操作的机器上运行 daemon。** 要收紧权限，编辑
  `.anet/nodes/<daemon-name>/config.json`。
- 只支持 Linux 和 macOS（Windows 上可在 WSL 里运行）。从 `2.3.0-preview.52` 起，
  在原生 Windows 上执行 `anet daemon init` / `start` / `up` / `restart` 会直接报错退出。

## 先决条件 {#hub-prereqs}

按顺序检查，缺哪一项都会被挡住，而且每一项都会给出可执行的报错：

| 顺序 | 缺了会看到 | 怎么办 |
|---|---|---|
| 1. Bun ≥ 1.2 | `❌ anet hub start requires the Bun runtime (commhub-server is bun-only — uses Bun.serve + bun:sqlite, no Node fallback)` | `npm i -g bun`，然后重开 shell 让 PATH 生效 |
| 2. Hub 在运行 | `未找到 CommHub Server。请先运行: anet hub start` | `anet hub start`，或 `anet init --hub <hub-url>` 指向已有 Hub |
| 3. 已登录且有 network_id | `未登录或缺少 network_id。请运行: anet login` | `anet register` 建账号，或 `anet login` |

### 哪些版本有 `anet daemon` {#which-versions}

`anet daemon` 从 `@sleep2agi/agent-network` `2.3.0-preview.39` 起提供，`2.2.21` 及更早的版本没有。
不要按通道判断，直接看你装的这一版：

```bash
anet -v                 # 你装的是哪一版
anet daemon             # 有：打印 Usage: anet daemon <subcommand> …
                        # 无：Unknown command "daemon"（退出码 1）
```

本页提到的其它能力各有自己的下界：

| 能力 | 需要的版本 |
|---|---|
| `anet daemon` 命令本身 | agent-network ≥ `2.3.0-preview.39` |
| `anet daemon list` 显示「创建能力」 | agent-network ≥ `2.3.0-preview.70` |
| `anet daemon restart` | agent-network ≥ `2.3.0-preview.73` |
| `anet node start` / `node restart` / `project up` 启动 daemon 时也自动钉 `ANET_BIN` | agent-network ≥ `2.3.0-preview.110` |
| daemon 定期重测创建能力并上报测量时间 | agent-node ≥ `2.5.0-preview.55` |

## 5 分钟体验 `anet daemon` {#try-anet-daemon}

### Codex 共存启动结果（源码能力，待发布） {#codex-start-completion}

Hub 和 daemon 均包含 #819 的启动完成协议时，daemon 创建的 Codex 共存节点会保持
`starting`，直到 `anet node start` 完成已有就绪检查并退出：退出码 0 才上报
`started`，非零退出或进程信号上报 `start_failed`，不再把 launcher PID 存在当成启动成功。
运行中每 20 秒上报进度，刷新 Hub 原有的 60 秒过期判断；不额外缩短 CLI 的大历史恢复预算。
错误码 `codex_launcher_exit:<退出码或信号>` 表示启动器未成功，不表示已清理所有 tmux 会话。

协议通过 `get_start_request.start_completion_capable` 协商；旧 Hub、旧 daemon 仍走旧启动行为，
普通前台 runtime 和 adopted 节点不走此分支。需要 Hub 与 agent-node 都升级后才能生效；
CLI 仍使用 daemon 已钉住的 anet。当前没有新的 fork 确认 API 或客户端恢复按钮。
同一 daemon 存活期间重复请求复用原启动结果；不承诺 daemon 重启后恢复该内存结果，
`started` 也不是持续健康证明。退出后 launcher PID 从子进程表移除，不作为后续停止的进程依据。

本片不改变常驻服务启动脚本、端口、代理或密钥来源，不新增磁盘状态或数据库 migration。
部署前按既有流程备份 Hub 数据和节点配置，固定已合入 main 的发布 SHA；用隔离节点核对
`starting → started/start_failed` 后再升级实际 daemon。回滚到原 Hub/runtime 制品将恢复旧行为，
无需数据降级迁移；节点历史与凭据仍需从原有受控备份恢复，Git 不包含这些数据。

### 1. 安装

```bash
npm i -g bun @sleep2agi/agent-network @sleep2agi/agent-node
```

`bun` 不能省，Hub 只能在 Bun 上运行。直接裸装即可，不用手写版本号；装完用 `anet -v` 核对是否满足
[上面的版本要求](#which-versions)。

### 2. 启动 Hub 并登录

```bash
anet hub start
```

横幅里有一个随机生成的管理员密码，**只显示这一次**，当场复制：

```text
  ✅ Server running on http://127.0.0.1:9200 (commhub-server v<version>)
  ✅ Admin account created
     username: admin
     password: anet-<random>
     Store this password now; it will not be shown again.
```

横幅下面给了拼好的登录命令：

```bash
anet login --hub http://127.0.0.1:9200 --username admin --password <横幅里的密码>
```

首次登录会提示你用 `anet passwd` 修改这个初始密码。必须先登录再起 daemon，否则
`anet daemon up` 会停在 `未登录或缺少 network_id`。

### 3. 启动 daemon

```bash
anet daemon up
```

输出类似：

```text
[anet daemon] ✓ created host_supervisor daemon "daemon"
              config:     .anet/nodes/daemon/config.json
              node_id:    node_daemon_<id>

[anet daemon] ⚠ Permission posture:
              flags.dangerouslySkipPermissions = true  (no per-call confirmation)
              flags.teammateMode = true
              role = host_supervisor                   (can fork child agent-nodes via hub)
              → Run daemons only on machines you trust to act on your behalf.

[daemon] 已注册到 CommHub
[daemon] SSE connected
```

`anet daemon up` 等于 `init` + `start`，不带名字时 daemon 叫 `daemon`。它是常驻进程，会一直占着
这个终端；要放到后台，见[让 daemon 在后台运行](#keep-daemon-alive)。

启动时还会打印 `workdir:`，那是这个 daemon 的工作区，决定它管得到哪些节点，见
[daemon 管得到哪些节点](#workspace)。

### 4. 确认 daemon 在线 {#confirm-running}

`anet daemon list` 列出当前目录下配置的 daemon，并向 Hub 询问每台 daemon 现在能不能创建节点：

```bash
anet daemon list
```

```text
Local host_supervisor daemons (1):
  scanned: <workdir>/.anet/nodes
  daemon                   node_id=node_daemon_<id>  runtimes=[…]
    创建能力:可用(5s 前测)
```

「列出来」只说明本机有这份配置；daemon 是否真的连着 Hub，看 `anet node ls` 里它的状态是
`idle` / `working`、SSE 列为 `●`，或者看 Dashboard 节点列表。

「创建能力」一行有几种不同的结果，含义不同，处理方式也不同：

| 这一行以什么开头 | 含义 | 怎么办 |
|---|---|---|
| `创建能力:可用(…前测)` | 上次测量时可以创建节点 | 无需处理 |
| `创建能力:**不可用**(<原因码>,…前测)` | daemon 报告它现在不能创建节点 | 下面几行会给出原因和一行可直接粘贴的修法，常见的是 `chmod go-w` |
| `创建能力:可用` 加一行「不知道是什么时候测的」 | 旧版 agent-node 只在开机时测一次 | 重启 daemon，或把 agent-node 升级到 ≥ `2.5.0-preview.55` |
| `创建能力:未知` | 这台 daemon 从没报过这一项，agent-node 太旧 | 升级 agent-node 后重启 daemon。这不等于「不可用」，别去修一台正常的机器 |
| `创建能力:查不到` | 本机拿不到 Hub 上的这一项 | 看后半句：没配 Hub 地址、Hub 拒绝本机凭据（跑 `anet login`）、Hub 上没有这个 node_id，或连不上 Hub |

测量时间很重要：几周前测出的「不可用」可能早已修好，只是那台 daemon 没再测。Hub 连不上时这条命令
不会失败，本地清单照常显示。

如果启动时打印了「装了但 PATH 上找不到」的警告，先修它。daemon 创建的子节点继承 daemon 的 PATH，
不修的话子节点会报「xxx CLI not found」，而那个程序其实已经装好了。

### 5. 从 Dashboard 创建第一个节点 {#first-node}

打开 Dashboard：

```bash
anet hub dashboard        # 端口默认 3000
```

绑定地址依次取 `--ip`、`--host`、环境变量 `HOSTNAME`，都没有时是 `127.0.0.1`。在容器里 `HOSTNAME`
通常有值，需要时显式传 `--ip`。

节点列表里能看到 `daemon`（`role=host_supervisor`），创建节点时可以在「选服务器」里选它。

::: warning 第一次创建节点，以 daemon 日志为准
`create_node` 返回 `ok:true` 和 `request_id` 只说明请求被接受，不说明节点已经创建。部分失败只写在
daemon 所在机器的日志里，Dashboard 不会变红。第一次创建时请看日志：

```bash
# 在运行 daemon 的机器上
tail -f ~/daemon-<daemon-name>.log     # 或你启动时重定向到的文件
```

| 看到 | 含义 |
|---|---|
| `[create-node] spawned child '<name>' pid=…` 和 `+5000ms capability check OK` | 创建成功，新节点会自己注册回 Hub |
| `[create-node] anet_bin_unsafe_path: …` | `anet` 路径校验没通过，见 [`ANET_BIN` 自动钉死](#anet-bin-pin)。它不会自动重试 |
| 什么都没有 | 请求没有到达 daemon，回到[第 4 步](#confirm-running)确认它连着 Hub |
:::

### 经 daemon 创建 Codex 共存节点 {#codex-copresence-via-daemon}

`runtime: "codex-app-server"` 本身建出来的是无头节点。要人和 agent 共用一个 Codex TUI，
`create_node` 的 `node_spec.flags` 里带 `"copresence": true`：

```json
{"name": "codex-human", "runtime": "codex-app-server", "flags": {"copresence": true}}
```

daemon 会在子节点 config 里写 `codexCopresence: true`，之后的 `anet node start <name>`（包括 daemon
自己起的那一次）走共存：app-server、桥、TUI 三个 tmux 会话。所以 daemon 所在机器要装好 `tmux`
和已登录的 `codex`，缺了会在启动时报出来（请求状态为 `runtime_capability_check_failed`）。
起来后在那台机器上 `tmux attach -t =<name>` 进 TUI。

- 只对 `codex-app-server` 有效；其他 runtime 带这个键会被 Hub 拒绝（`flag_not_applicable_to_runtime`）。
- 不认识这个键的旧 Hub / 旧 daemon 会拒绝请求（`flag_key_unknown`），不会悄悄建出无头节点。

### 经 daemon 创建 OpenCode V2 共存节点 {#opencode-v2-via-daemon}

`runtime` 仍是 `opencode-cli`。要建 V2 共存节点，`create_node` 的 `node_spec.flags` 同时带 `"opencodeGeneration": "v2"` 和 `"opencodeUnsafeTools": true`，`model` 必须是 OpenCode 自己的 `provider/model`（恰好一个斜杠）：

```json
{"name": "oc-v2", "runtime": "opencode-cli", "model": "provider/model", "flags": {"opencodeGeneration": "v2", "opencodeUnsafeTools": true}}
```

这个接口不接收 anet 的 provider 预设，密钥留在目标节点已有的 OpenCode 配置里。daemon 在写子节点配置之前，要求 PATH 上的 `opencode --version` 是本发行接受的 `@opencode/cli@2.0.22`。显式 `v1` 同样必须对上接受的 `opencode-ai` 版本（当前 pin `1.18.34`，过渡版 `1.18.1`）。对不上的错误码是 `opencode_generation_mismatch`。省略 `opencodeGeneration` 仍按旧的 V1 创建，不因为机器上碰巧是 V2 二进制而拒绝。`--version` 超时不在这一步拒绝。

读回：daemon 上报的配置快照 `flags` 会带上 `opencodeGeneration`、`opencodeMode`、`opencodeUnsafeTools`，只读。`update_node_config` 不能改这三项。`runtime_readiness` 里的 `opencode-cli` 可带 `generation` 与 `accepted`；V2 的 `state` 仍是 `unknown`（provider 与登录取决于目标节点配置）。`accepted: false` 表示这个 2.x 不是接受的 pin，显式创建会被拒绝。

### 任务超时 `flags.timeout` 的单位是毫秒 {#create-node-timeout-ms}

`create_node` 的 `node_spec.flags.timeout` 是**毫秒**：daemon 原样写进子节点 config，节点按毫秒读
（不填时默认 300000 = 5 分钟）。和 `update_node_config` 改超时用的是同一个范围：

- `0`：不设上限；
- `1000`–`3600000`：1 秒到 1 小时，例如 10 分钟写 `600000`；
- `1`–`999`、超过 `3600000`、小数、字符串：Hub 拒绝（`flag_value_invalid`，`reason` 里写明单位是毫秒）。

```json
{"name": "long-runner", "runtime": "claude-agent-sdk", "flags": {"timeout": 600000}}
```

旧版 Hub / daemon 按「秒」只收 `1`–`86400`：填 `600` 的节点实际拿到 0.6 秒的超时，填 `600000` 反而被拒。
新版不会把小数值自动乘 1000（分不清原意），而是直接拒绝，避免有人悄悄拿到亚秒级超时。已经建好的节点
config 不会被迁移，里面的数字一律按毫秒生效；要改用 `update_node_config` 或直接编辑 config。

## 让 daemon 在后台运行 {#keep-daemon-alive}

`anet daemon start` 是前台进程。如果你是 SSH 上去启动的，会话一断它就退出了。

用 `nohup` 放到后台：

```bash
cd <init 时所在的目录>        # daemon 配置按目录存放
nohup anet daemon start <daemon-name> > ~/daemon-<daemon-name>.log 2>&1 &
sleep 25 && tail -5 ~/daemon-<daemon-name>.log   # 应看到「已注册到 CommHub」和「SSE connected」
```

断开 SSH，隔几分钟后从另一个会话确认它仍在线（`anet node ls` 或 Dashboard）。启动横幅不能证明
它能活过会话结束，只有断开后仍在线才算。

需要崩溃后自动拉起时，用 PM2 或 systemd 守护 `anet daemon start <daemon-name>` 这条命令，写法与守护
Hub 相同（见[让 Hub 常驻](/deploy/keep-alive#pm2)），注意两点：

- 工作目录（PM2 的 `cwd`、systemd 的 `WorkingDirectory=`）必须是 `anet daemon init` 时所在的目录。
  目录不对会报 `Daemon "<daemon-name>" not found. Create it first:`，配置其实还在，只是没在那里找。
- 守护的命令必须是 `anet daemon start`，不要直接启动 `agent-node`。绕过 `anet` 启动的 daemon 拿不到
  `ANET_BIN` 钉死，能注册、能心跳，但不能创建节点（见下一节）。

## `ANET_BIN` 自动钉死 {#anet-bin-pin}

daemon 收到 `create_node` 后，要 fork 本机安装的 `anet` 来创建子节点。为防止 `PATH` 劫持，它只接受一个
通过校验的绝对路径。`anet daemon init` / `start` / `up` / `restart` 会自动完成这件事：

1. 把当前 `anet` 启动器解析成实体文件，注入 `ANET_BIN_ABS`，并声明 `ANET_DAEMON_ALLOW_ENV_BIN=1`。
2. 分别诊断路径未解析、非绝对路径、symlink、组或其他用户可写、不可执行等问题。
3. 在 `umask 0002` 下 npm 装出的 group-writable（`775`）文件会被拒绝启动，并打印可直接执行的
   `chmod go-w` 命令。
4. 默认接受 nvm / Homebrew / npm 的非 root 用户安装。

所以一般只需要：

```bash
npm i -g @sleep2agi/agent-network @sleep2agi/agent-node
anet login
anet daemon up
```

钉住的路径不落盘，每次启动都从正在运行的 `anet` 重新解析。升级 `anet` 之后执行
`anet daemon restart <daemon-name>` 就会重新钉住。

在 agent-network ≥ `2.3.0-preview.110` 上，`anet node start <daemon-name>`、`anet node restart <daemon-name>`
和 `anet project up` 启动的如果是 daemon，也会按同样的规则钉住路径。校验失败时 daemon 仍会启动并打印修法，
同时向 Hub 报告「不能创建节点」，Dashboard 会把它置灰。

### 已在运行的 daemon 不能创建节点 {#anet-bin-fix}

先试不需要 root 的办法，用 `anet` 重新启动它：

```bash
anet daemon restart <daemon-name>
# 旧版本没有 restart 时：
anet node stop <daemon-name> && anet daemon start <daemon-name>
```

如果二进制可写、不可执行，或不是 anet 包里的 bin，`anet daemon start` 会拒绝并说明原因，按提示修即可。
不要手工修改服务器上的启动文件来绕过检查。

### 固定 `anet` 路径的两个来源 {#anet-bin-sources}

| 来源 | 用途 |
|---|---|
| `path.conf` 文件 | 信任根，存在时优先于环境变量 |
| `ANET_BIN_ABS` 环境变量 | Docker、开发机或手工运维时方便使用；只在 `ANET_DAEMON_ALLOW_ENV_BIN=1` 时被接受 |

`path.conf` 的位置由 `ANET_DAEMON_PATH_CONF` 决定，没设时是 `/etc/anet-daemon/path.conf`。把它指向你自己
有权限的文件，就能得到一个不需要 root、重启后仍然有效的固定路径：

```bash
ANET_BIN_REAL="$(node -e 'console.log(require("fs").realpathSync(process.argv[1]))' "$(command -v anet)")" \
  && mkdir -p "$HOME/.anet" \
  && printf 'ANET_BIN_ABS=%s\n' "$ANET_BIN_REAL" > "$HOME/.anet/path.conf" \
  && export ANET_DAEMON_PATH_CONF="$HOME/.anet/path.conf"
```

把 `ANET_DAEMON_PATH_CONF` 放进 daemon 自己的环境（systemd 的 `Environment=`、PM2 的 `env`，或启动它的
shell 的 profile），否则重启后又会回到 `/etc`。只有在你绕过 `anet daemon`、自己拼启动命令时，才需要手工
设置这些变量。

## daemon 管得到哪些节点 {#workspace}

daemon 的工作区是它启动那一刻所在的目录。它创建和启动的节点都在 `<workdir>/.anet/nodes/` 下，
在别的目录里手工建的节点它够不着，这不是权限问题，而是不在它的查找范围里。

查看某个 daemon 的工作区（`<pid>` 可从 `anet node ls` 或 `ps` 获得）：

```bash
ls -l /proc/<pid>/cwd            # Linux
lsof -a -p <pid> -d cwd          # macOS
ls <workdir>/.anet/nodes/        # 它管得到的就是这里面的节点
```

同一台机器上从两个目录各起一个 daemon，会得到两组互相看不见的节点。要让 daemon 管理某一批节点，
就从那批节点所在的目录启动它。`anet daemon list` 同样只列当前目录下的 daemon。

工作区将来是否改为固定目录，在 [#1722](https://github.com/sleep2agi/agent-network/issues/1722) 跟踪。

### 给新节点指定工作目录 {#child-workdir}

新版 daemon（与之配套的 Hub）支持在创建时给节点单独一个目录。桌面端「新建节点」的确认页会多一行
「工作目录」，默认是 `<默认根>/<节点名>`，点「改」可以换成别的绝对路径或 `~/…`。节点的 `.anet`
和进程的工作目录都在那里，文件工具看不到家目录里别的项目和密钥。

- 默认根是 daemon 用户的 `$HOME`，所以默认目录是 `$HOME/<节点名>`。可以在 daemon 的
  `config.json` 里用 `default_workdir_root` 改（可写 `~/…`）。
- 默认目录名一律是 ASCII：桌面端把节点名转成 `[a-z0-9-]`（中文取拼音，如「吉他大师」→ `jitadashi`；
  转不出来时用 `node-<6 位十六进制>`），并把算好的完整路径显式发给 daemon。
- `$HOME` 以下那一段含非 ASCII 字符的目录会被拒绝（`workdir_not_ascii`）。家目录本身是什么不算在内。
- 目录不存在时会创建，权限 `0700`；已存在的目录不改权限。
- 会被拒绝：`$HOME` 本身或它的上级目录、`/`、系统目录（`/etc`、`/usr`、`/var` 等）、
  已经住着另一个节点（有 `.anet/nodes/<别的名字>/config.json`）的目录。
- 请求里不带工作目录时，节点仍落在 daemon 的工作区，和以前一样。
- 旧版 daemon 不认这个字段，桌面端在旧 daemon 上不显示这一行；Hub 也会拒绝发往旧 daemon 的、
  带工作目录的请求（`workdir_not_supported_by_daemon`），不会让它被悄悄忽略。

这样建出来的节点不在 daemon 的 `<workdir>/.anet/nodes/` 下，daemon 用
`<workdir>/.anet/child-workdirs.json` 记住它们在哪，停止、启动、删除照常可用。删除时配置移到
该节点目录下的 `.anet/deleted/`，目录本身保留。

::: warning 改默认根之前
如果开机时靠扫描 `$HOME/*/.anet` 把节点拉起来（例如项目里的 `deploy/fleet/anet-nodes-boot.sh`），
默认的 `$HOME/<节点名>` 正好在扫描范围内，而 `$HOME/work/<节点名>` 这类更深的目录不在。
把 `default_workdir_root` 改到别处之前，先确认开机拉起的方式覆盖得到新位置。
:::

## 升级与重启 {#restart}

daemon 是常驻进程，升级 npm 包不会影响已经在运行的进程。升级后必须重启：

```bash
anet daemon restart <daemon-name>
```

`restart` 需要 agent-network ≥ `2.3.0-preview.73`；更早的版本会报 `Unknown daemon subcommand "restart"`，
这时用两步：

```bash
anet node stop <daemon-name>
anet daemon start <daemon-name>
```

daemon 没有自己的 stop / delete / status 子命令，直接用节点命令：`anet node stop`、`anet node delete`、
`anet node ls`。

`anet daemon list` 提示 daemon 缺少某些 runtime 时，执行 `anet daemon init <daemon-name> --force` 补齐。
它保留 `node_id`，但会重新签发 token，之后要重启 daemon。

## 收编节点的停启 {#adopted-lifecycle}

收编节点的停止 / 启动从 agent-node ≥ `2.5.0-preview.118`、agent-network（`anet`）≥ `2.3.0-preview.151` 起提供；
Hub 从 commhub-server ≥ `0.9.0-preview.109` 起对收编节点的重启返回 `adopted_restart_requires_daemon`，提示先停止再启动（`.108` 及更早没有这道拒绝门）。
在节点原工作目录执行 `anet daemon adopt <alias> --daemon <daemon-id>` 先看计划，
加 `--yes` 仅请求收编，必须等 daemon 独立核验、Hub 绑定成为 active 才生效。
daemon 配置的 `adopt_roots` 默认空，即不允许收编。codex 原生三段布局可以远程启动；`external-appserver` 布局的远程启动仍拒绝。

- 停止前重新核验节点配置、UID 和 `/proc` 起始时间，只停止已核验的进程树。
- 停止成功写入 `<nodeDir>/.hub-stopped`；`anet project up` 和仓库开机扫描会保留停止状态及 PID 文件。
- 启动前删除标记，按停止时保存的真实启动证据，用 daemon 的受信任 anet 入口启动。
  只有推断的 `launch_mode`、配置变化或证据缺失时拒绝启动，不猜测启动方式。
- tmux 必须是明确的私有 socket，重新核验原会话及进程归属；默认 socket、不可用的私有服务、
  仍占用的原会话都拒绝操作。不会向默认 tmux 服务发命令。
- 收编绑定本身不能证明存在 exit-75 自动拉起外层。Hub 返回
  `adopted_restart_requires_daemon` 时，请在客户端先「停止」再「启动」。普通节点和 daemon 创建的节点不变。

恢复时，Hub 数据库里的绑定与 daemon 工作区的 `.anet/child-workdirs.json` 必须对应。
这些登记、节点配置、凭据和停止标记属于需要安全备份的本地/数据库状态，clone 仓库不会恢复它们。
缺少对应证据时先撤销绑定、重新收编，不手填 PID 或启动证据。启动器仍是仓库的 CLI/daemon，
开机脚本权威副本仍为 `deploy/fleet/anet-nodes-boot.sh`；本功能不改端口、反代或密钥来源。
升级与回滚仍按上节及生产部署流程执行；回滚前须确认目标 daemon 保留收编节点的拒绝保护，
不能假定所有旧版安全，也不能删除标记强行放行。

### 共存节点重启后的恢复边界

机器重启后，旧 `boot_id`、PID 和 marker 不能授权停止当前进程。daemon 只做无信号的
缺席检查：对应会话以及同 UID 下携带旧 marker 或相同 `CODEX_HOME` 的进程都不在，
才能回报已停止；有任一残留或新一代进程时返回 `adopt_codex_readopt_required`，需重新收编。
无法读取证据时继续拒绝，不按名称清扫。删除收编节点仍拒绝，并保留
`adopted_node_delete_unsupported` 错误码，不删目录、不停止进程。

通过 CLI 手动成功启动两种 Codex 共存布局后，会写入 `.hub-resumed`，精确标记启动前的
那一份 `.hub-stopped` 已被取代；不直接删除停止文件，避免误删另一进程并发写入的新收据。
`anet project up` 和仓库 `deploy/fleet/anet-nodes-boot.sh` 同时识别此凭据，后续新停止
会自动使旧凭据失效。失败启动、身份不符、损坏文件保持停止。更新时须同时部署新版 CLI
和仓库开机脚本；未更新的旧扫描器仍保守地保持停止。凭据属于本地状态，恢复备份后若文件
身份改变则保持停止，需要显式重新启动；回滚不会自动拉起原本停止的节点。本改动不改变
常驻服务、端口、密钥来源或启动编排。原生布局的远程启动调用受信任的 `anet node start`，核对新 marker、三段进程和回环监听后才确认；`external-appserver` 仍拒绝。不证明 codex 版本或 rollout，也不把收编节点的 restart 放开。

部署由运维执行，不由此 PR 自动部署：先记录当前 CLI 版本、开机服务的实际 ExecStart 路径，
备份已安装脚本并对照仓库副本审查差异；从已合入 main 的精确提交发布并安装对应 CLI，
再把同一提交的 `deploy/fleet/anet-nodes-boot.sh` 安装到该服务实际调用的位置，保留执行权限。
核对 CLI 版本及已安装脚本的 SHA-256 与发布来源一致；先用隔离目录验证旧停止仍保持停止、
成功手动启动的凭据可放行、新停止再次生效，再安排实际开机扫描。不要为验证而重启真实节点。
回滚时成对恢复旧 CLI 和备份脚本，不清除 `.hub-stopped`；本地状态仅由节点数据备份恢复。
凭据指纹只含 inode、ctime 和内容摘要，不依赖重启后可能变化的设备号；旧格式凭据不匹配时
保持停止，显式成功启动会生成新凭据。探针仅退出码 42 表示放行，异常或其他退出码保持停止。

## 客户端收编状态查询（计划 Hub .110） {#adoption-read-api}

daemon 专用 MCP `list_my_children` 对当前 active 的 adopted 子项额外返回
`binding_request_id`，它就是不透明的绑定代际。只接受绑定目标 daemon 的有效节点令牌，
按 daemon 与网络共同限定。owner 的 utok 也读不到；这不表示 owner 持有目标 daemon 的有效节点令牌时不能读取。
身份按 Hub .111 的令牌属主/精确节点绑定校验（包括既有旧令牌兼容规则）解析，而非信任令牌名称：
解析为其他 daemon 的令牌、子节点自己的节点令牌和跨网络令牌都不能读取目标 daemon 的这条绑定。
子节点用自己的有效节点令牌调用时，若没有自己管理的子项，返回成功的空列表。
`get_adopt_request` 仍只查询 pending，不开放 active 查询。撤销后再收编会生成新 request_id，
旧代际不会复活；旧 Hub 缺字段时，daemon 启动前置门继续拒绝，不得用本地值补齐。
**投影只是一次读取时的快照，不是租约。** 启动执行方须在动作边界重新确认同代绑定，
并遵守在途生命周期的撤销保护。这个接口不执行启动。对旧客户端只新增一个字段，
不改变已有字段或 created 子项；旧 daemon 可忽略此字段。此处不宣称实际版本兼容回放已通过。

以下新增字段和接口只向请求头携带的用户 token 开放（不接受 URL token），并沿用节点列表的网络及节点可见性授权；
不会给 daemon / 网络 token 新增读权限，也不改变旧字段。这一组只读已有的收编 / 停启记录，不是候选发现；候选发现见 [收编候选发现](#adoption-candidates)。

- `GET /api/nodes` 新增 `managed: "created" | "adopted" | "none"`：分别由真实创建记录、
  active 收编绑定或均无记录决定。创建记录优先，不凭 ID 前缀或主机名猜测。
  创建记录优先使用 `child_node_id`；仅旧记录该列为 null 时按 `cr_X → node_X` 回退。
  `adoption` 为最近绑定的 `{request_id, daemon_node_id, status, error}`，无记录为 `null`；
  状态保留 `pending / active / refused / revoked`，pending 不能当作收编成功。
- `GET /api/host-supervisors` 对可见的 daemon 投影 `adopt_capable`。只在 daemon 确实
  上报布尔值时出现；缺字段表示未知，不能当成支持。
- `GET /api/node-lifecycle-requests?kind=adopt&request_id=...`：`kind` 必填，允许
  `adopt / start / stop`；`request_id` 与 `node_id` 必须且只能选一个。可带 `network_id`。
  按节点查最近一次请求（`created_at` 倒序、同毫秒以 request_id 降序确定），没有请求返回
  `{ok:true,request:null}`；按请求查不存在/不可见记录返回 404。无节点读权限也返回 404，
  显式点名无权访问的网络返回 403，非用户凭据返回 403，参数错误返回 400。

成功响应是 `{ok:true,request:{kind,request_id,node_id,network_id,daemon_node_id,status,error,created_at,...}}`。
收编另有 `updated_at`；停启另有 `delivered_at / acked_at`，时间为 UTC 毫秒或 null。
收编状态如上；启动保留 `pending / delivered / started / start_failed / timeout`，停止保留
`pending / delivered / stopped / stop_failed / noop_not_my_child`。失败看 `error`，不把
HTTP 200 或 pending 当成操作成功。返回 daemon 原因码，例如
`adopt_explicit_private_socket_required`（需要私有 tmux socket）、
`adopt_start_evidence_missing`（缺少真实启动证据）、`adopt_active_binding_required`（有效绑定缺失）。
新启动请求取代陈旧启动请求时，旧请求可变成 `timeout`；它不是启动成功。
本接口不查询 delete，结果字段不包含 token、工作目录、PID 或配置快照；错误值另行脱敏如下。
所有新增读投影的 `error` 只透传明确白名单内的完整错误码；未知码、附带诊断文本或空字符串
统一返回 `lifecycle_error`，null 保留。原始错误仍保留在数据库，不向节点读者泄露路径或主机信息。

无需新配置、端口、服务或数据库迁移；升级/回滚遵循上述部署流程。绑定和请求历史仍来自
Hub 数据库备份，Git 只恢复软件；本次未做生产升级或新的灾难恢复演练。

## 收编候选发现（只读） {#adoption-candidates}

daemon 在能够收编（`adopt_capable`）时，可以随心跳上报本机 `adopt_roots` 下、通过现有 v1 身份检查的手工节点。这只是一份清单：不写绑定、不发信号、不启动、不停止，也不把节点收编进来。`launch_hint`（`bare` / `tmux` / `stopped` / `unverified`）是本机提示，不是授权。

和收编 v2 的边界：

- 共存节点（codex 三段式、grok、opencode）不进入这份清单。daemon 发现时不打开 codex v2 身份检查；三段式的停启仍走原来的收编实现，不由这个接口代替。
- `GET /api/nodes` 的 `managed` / `adoption`，以及 `GET /api/node-lifecycle-requests`，仍然只描述已经存在的创建记录和收编 / 停启请求。
- 应用要真正收编，仍调用 `request_adopt_node`。daemon 会重新核验 UID、路径、配置和进程。上报过的工作目录不能当成已经核对过。

`adopt_roots` 默认是空列表。不配置时 daemon 不上报 `adoption_candidates`，心跳和收编行为和以前一样。

`GET /api/adoption-candidates` 只接受请求头里的用户 token（不接受 URL 上的 token，也不接受 daemon / 网络 token）。它列出同时满足这些条件的候选：daemon 在线（5 分钟内有心跳）、声明 `adopt_capable`、和节点在同一台机器上、别名与上报一致、节点本身还没有创建记录或 pending/active 绑定。工作目录只给该节点的主人、网络 owner/admin，或 Hub 管理员；其他人得到空列表。响应不含 token、环境变量或 PID。单台 daemon 最多 32 条，接口最多返回 64 条。

`GET /api/host-supervisors` 只在 daemon 真的上报了数组时，给能看见该 daemon 的用户 token 增加 `adoption_discovery: true`。缺席表示这台 daemon 没有公布发现结果，不能当成「没有可收编节点」，也不能当成「不支持收编」。空数组表示发现跑过、当前没有候选。

不新增表、端口、服务或密钥来源。回滚后这个接口不存在；已经生效的绑定不受影响。

## 相关 {#related}

- [让 Hub 常驻（pm2 / systemd）](/deploy/keep-alive)
- [生产部署 / 公网部署安全](/deploy/production)
- [CLI 参考](/guide/cli)
- [故障排查](/troubleshooting)
- [daemon ↔ hub 生命周期请求的可靠性模型](https://github.com/sleep2agi/agent-network/blob/main/docs/daemon-lifecycle-reliability.md)（开发者向）

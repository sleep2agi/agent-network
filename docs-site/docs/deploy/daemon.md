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

## 收编节点的停启（待发布） {#adopted-lifecycle}

此能力需要配套的新版 daemon；Hub 的收编节点重启拒绝门计划进入 `.109`，不是 `.108`。
在节点原工作目录执行 `anet daemon adopt <alias> --daemon <daemon-id>` 先看计划，
加 `--yes` 仅请求收编，必须等 daemon 独立核验、Hub 绑定成为 active 才生效。
daemon 配置的 `adopt_roots` 默认空，即不允许收编；共存节点暂不支持。

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

## 客户端收编状态查询（计划 Hub .110） {#adoption-read-api}

以下新增字段和接口只向请求头携带的用户 token 开放（不接受 URL token），并沿用节点列表的网络及节点可见性授权；
不会给 daemon / 网络 token 新增读权限，也不改变旧字段。不是候选发现接口。

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
收编状态如上；启动保留 `pending / delivered / started / start_failed`，停止保留
`pending / delivered / stopped / stop_failed / noop_not_my_child`。失败看 `error`，不把
HTTP 200 或 pending 当成操作成功。返回 daemon 原因码，例如
`adopt_explicit_private_socket_required`（需要私有 tmux socket）、
`adopt_start_evidence_missing`（缺少真实启动证据）、`adopt_active_binding_required`（有效绑定缺失）。
本接口不查询 delete，也不返回 token、工作目录、PID 或配置快照。
所有新增读投影的 `error` 只透传明确白名单内的完整错误码；未知码、附带诊断文本或空字符串
统一返回 `lifecycle_error`，null 保留。原始错误仍保留在数据库，不向节点读者泄露路径或主机信息。

无需新配置、端口、服务或数据库迁移；升级/回滚遵循上述部署流程。绑定和请求历史仍来自
Hub 数据库备份，Git 只恢复软件；本次未做生产升级或新的灾难恢复演练。

## 相关 {#related}

- [让 Hub 常驻（pm2 / systemd）](/deploy/keep-alive)
- [生产部署 / 公网部署安全](/deploy/production)
- [CLI 参考](/guide/cli)
- [故障排查](/troubleshooting)
- [daemon ↔ hub 生命周期请求的可靠性模型](https://github.com/sleep2agi/agent-network/blob/main/docs/daemon-lifecycle-reliability.md)（开发者向）

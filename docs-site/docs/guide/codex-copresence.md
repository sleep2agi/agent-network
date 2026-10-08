# Codex TUI 人机共存（`codex-app-server`，preview）

`codex-app-server` runtime 让**人和 Agent 共用同一个 Codex 会话**：人在原生 Codex TUI 里输入、看输出、处理审批，Agent Network 的任务经 CommHub 注入**同一个 Codex thread**。双方看到同一段历史和同一组实时事件。（[RFC-030](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-030-codex-tui-bridge.md)，Phase 0A。）

> 与无头的 `codex-sdk` 不同：`codex-sdk` 是后台工作器、没有可共存的活 TUI；`codex-app-server` 才提供 Codex TUI 人机共存。

::: warning Preview
这是**预览**功能。`codex-app-server` runtime 与 `anet node start <name> --copresence` 在 npm `latest` 与 `preview` 两条通道的发布包里都有（`anet --help` 会列出「Co-presence」一节）；较新的修复先发到 `preview`，所以下面推荐用 preview 频道。当前实现还是单机可信形态，不是生产 Policy Gateway；只连接可信 Hub、只接收可信任务。
:::

## 前置

- 安装并登录 Codex CLI（协议验证基线为 `codex-cli 0.144.x`）：

```bash
npm install -g @openai/codex
codex login
```

- 安装或切换到 preview 频道（推荐，修复先到这里）：

```bash
npm install -g @sleep2agi/agent-network@preview @sleep2agi/agent-node@preview
# 已装 anet 时也可让整组组件切到 preview：
anet upgrade --channel preview

# 自检：help 必须出现 Co-presence / --copresence
anet -v
anet --help
```

- Linux、macOS 与 WSL 的一键路径还需要 `bash` 和 **tmux 3.2+**。原生 Windows 使用受管后台进程与当前 PowerShell/Windows Terminal，不需要 tmux。
- 节点必须持有 network-scoped `ntok_`。旧节点缺 token 时先运行 `anet doctor --fix`，或重新创建节点。

## 推荐：创建时选定共存，之后一键启动/恢复

```bash
# 0. 在外部干净 shell 中进入节点要操作的项目
cd /path/to/project

# 清掉调用方继承的全部 COMMHUB_* 身份，不能只逐个删已知变量
for v in $(env | sed -n 's/^\(COMMHUB_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done

# 1. 交互创建：输入节点名，然后在 runtime 菜单选择“codex-cli — Codex 共存 TUI”
anet node create

# 2. 一键启动 app-server、bridge 和可 attach 的 Codex TUI
anet node start codex-human

# 3. Linux/macOS/WSL：进入人机共用的 TUI
tmux attach -t =codex-human
```

原生 Windows 的第 2 条命令会直接在当前 PowerShell/Windows Terminal 打开 Codex TUI；无需第 3 条命令。要停止整套进程，请保留 TUI 窗口并在另一个终端运行 `anet node stop codex-human`。

Codex thread 的工作目录继承自 **app-server 进程启动时的 cwd**，不是 bridge 的 cwd；因此要在运行 `--copresence` **之前**先 `cd` 到目标项目。Linux 上可用 `readlink /proc/<app-server-pid>/cwd` 复核，不能只检查 bridge。

`create --copresence` 会把选择写入节点配置；此后普通 `node start`（包括停止或中断后的恢复）都会重建同一套共存拓扑，无需重复 flag。旧节点也可第一次运行 `anet node start codex-human --copresence`，CLI 会记住选择，后续同样只需 `anet node start codex-human`。

交互菜单里的 `codex-cli` 就是共存模式：选中后直接写入 `codexCopresence: true`，不再要求第二次选择。`codex-sdk` 是后台无头 Codex 节点。脚本可使用等价命令 `anet node create codex-human --runtime codex-cli`；旧的 `--runtime codex-app-server --copresence` 继续兼容。

::: warning 发布渠道
交互选项从 **preview.42** 起可用；原生 Windows 一键编排从 **preview.43** 起可用。Windows 路径已在 `windows-latest` 通过真实 ConPTY 测试：交互创建、首次启动、停止、重启和再次停止，并验证重启恢复同一个 thread。
:::

Linux/macOS/WSL 启动会创建三个带同一身份标记的 tmux session；Windows 创建两个受管后台进程，并把 TUI 留在当前控制台：

| Session | 作用 |
|---|---|
| `codex-human-appsrv` | 只监听 loopback 的 `codex app-server`，并注入 CommHub MCP |
| `codex-human-桥` | `agent-node` bridge，接收网络派工并投进同一 thread |
| `codex-human` | 人类可 attach 的原生 Codex TUI |

Windows 会把 app-server 与 bridge 的 PID、进程创建时间和日志位置写入节点私有状态。`stop` 只有在 PID 与创建时间同时匹配时才会调用 `taskkill /T`，避免 PID 复用时误杀无关进程；凭据目录用 Windows ACL 限制为当前用户、SYSTEM 与 Administrators。

### 首次启动、未登录、bridge 起不来（#535）

- **⓪ agent-node**：在建任何 tmux session 之前，启动器先解析与本版 anet 配对的 `@sleep2agi/agent-node`（新机器第一次会经 npx 下载，可能要一分钟，期间会打印 `⓪ agent-node: resolving …`），bridge 直接用这份已校验的入口，不再自己跑 npx。所以下载耗时不再吃掉 bridge 的 25 秒等待。
- **未登录 = `needs-login`**：节点 CODEX_HOME 里没有可用登录（`auth.json` 里既没有 ChatGPT token 也没有 API key）时，不再打印「✅ 就绪」，而是打印 `needs-login`、该节点 CODEX_HOME 的确切登录命令（`CODEX_HOME=<节点>/codex-home codex login --device-auth`），**什么都不启动**，退出码 3。登录后再 `anet node start <节点>`。凭据存在系统 keyring（`cli_auth_credentials_store = "keyring"/"auto"`）或环境里有 `OPENAI_API_KEY`/`CODEX_API_KEY` 时不拦。
- **bridge 失败看得见**：bridge 的输出同时写进 `<节点目录>/codex-bridge.log`（0600，每次启动清空，上限约 2 MB）。bridge 没接上时直接打印它最后 20 行和日志路径；bridge 会话已经退出时不再给一个 attach 不上的 `tmux attach`。

### tmux 目标必须精确匹配

`codex-human` 同时也是另外两个 session 名的前缀。tmux 的普通 `-t codex-human`
可能在 TUI session 已退出时静默匹配到 `codex-human-appsrv` 或 bridge。操作前先列出
session 与 pane 复核：

```bash
tmux list-sessions -F '#{session_name}'
tmux list-panes -t =codex-human -F '#{pane_id} #{pane_current_command}'
tmux attach -t =codex-human
```

`capture-pane`、`send-keys` 等操作也应使用 `-t =codex-human` 强制精确匹配，或直接使用
`%42` 这类 pane ID。三个 session 中有一个消失时尤其要避免前缀匹配。

在 TUI 中按 `Ctrl-B D` 只会 detach，不会停节点。停止时请先 detach，再从**共存进程树外的终端**运行：

```bash
anet node stop codex-human
```

停止流程会用持久身份标记收拢这三个 session 及其子进程；从共存 session 内调用 `stop` 会 fail closed，避免把当前 shell 一起杀掉。

::: info macOS 的停止保障差异
macOS 的启动、连接与 TUI 共存路径和 Linux 相同，但 P3 进程身份清理依赖 Linux `/proc`，因此 macOS 停止时会降级为 legacy sweep。功能仍可用，但清理保证弱于 Linux；请从共存进程树外运行 `anet node stop`，并确认三个 tmux session 都已退出。
:::

::: danger 断线恢复要先停止旧进程树
节点配置会记住共存模式，因此普通 `anet node start codex-human` 会重新进入共存编排，不会降级成无头节点。但在旧 bridge 仍存活时不要直接再启动；应在外部 shell 中先停止旧树、清空 `COMMHUB_*`，再运行：

```bash
anet node stop codex-human
cd /path/to/project
for v in $(env | sed -n 's/^\(COMMHUB_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done
anet node start codex-human
```

这不是理论风险：生产节点 `外部团队节点` 因此静默重复运行约 2 天，另一个生产节点 `另一团队节点` 则持续约 9 天（[#535](https://github.com/sleep2agi/agent-network/issues/535)）。
:::

### 用哪个模型 {#model}

启动时模型按这个顺序取，**一个值同时喂给 app-server（`-c model=`）、恢复线程（`thread/resume` 的 `model`）和 TUI（`-m`）**：

1. 本次命令的 `--model <id>`（只对这一次启动生效，不写回配置）
2. 节点配置 `.anet/nodes/<id>/config.json` 的 `model`（`anet node create --model` / `anet node edit --model` 写入）
3. 内置默认

启动输出会写明取到的值和来源，例如 `[anet] model: o3 (source: node config …)`；恢复已有会话时再打印一行线程实际所在的模型。`anet node codex start|restart|resume` 内部调用的也是这条路径。

线程原先记录的模型与配置不同时，**以配置为准**：codex 0.155 实测，`thread/resume` 不带 `model` 时会回到 rollout 最后一条 `turn_context` 里的旧模型、并忽略 app-server 的 `-c model=`；而线程一旦被第一个客户端加载，后来的 TUI `resume -m` 也改不动它。所以 anet 在第一次 `thread/resume` 就带上配置的模型（#512）。

### commhub 工具审批框：anet 已自动预批准（#720） {#commhub-tool-approval}

Codex 第一次调用每个 MCP 工具时会弹：

```
Allow the commhub MCP server to run tool "get_task"?
› 1. Allow   2. Allow for this session   3. Always allow   4. Cancel
```

无人值守的节点没人点，这一轮就卡住，Hub 最终判超时；而且此时 hub 上的信号全是健康的（`status=idle`、SSE 在线）。
这个弹窗**不受 `approval_policy` 单独控制**：实测共存默认姿态（read-only + on-request）下 codex 0.133.0 和 0.159.2 都弹；
never + read-only 下 0.133.0 仍弹，0.159.2 直接静默拒绝这次调用。「Always allow」也撑不过重启，因为 commhub 是 anet 启动时用 `-c` 传入的，不在 config.toml 里。

**现在**：anet 每次为节点启动 codex（POSIX / Windows 共存 app-server、agent-node 自管 app-server、codex-sdk）都会带上

```
-c mcp_servers.commhub.default_tools_approval_mode="approve"
```

只作用于 commhub，其他 MCP server 仍按 codex 默认行为询问。codex 0.133.0（取值 `auto|prompt|approve`）和 0.159.2（`auto|prompt|writes|approve`）都支持；
实测见 `tests/test720-codex-commhub-tool-approval`。

和你自己的 `CODEX_HOME/config.toml` 的关系（同一套件实测）：

- anet 的 `-c` **覆盖**你在 `[mcp_servers.commhub]` 里写的 `url` 和 `default_tools_approval_mode`。
- 你为某个工具写的 `[mcp_servers.commhub.tools.<工具名>] approval_mode = "prompt"` **仍然优先**，那个工具照样会弹，这是有意保留的逐工具开关。
- codex 自己写下的逐工具 `approval_mode = "approve"` 子表（「Always allow」留下的）不受影响。
- 外部 app-server 通道（`codexAppServerUrl` 固定、commhub 来自你自己的 config.toml）**不注入**这个键（单独注入一个未定义 server 的键会让 codex 报 `invalid transport` 起不来），
  请在自己的 `[mcp_servers.commhub]` 下加 `default_tools_approval_mode = "approve"`。

旧版本 anet 起的节点仍可能卡在这里，排查方法：

```bash
tmux capture-pane -t =<alias> -p | grep "Allow the commhub MCP"
```

### 一条线程只用一个 codex 版本（#734） {#one-codex-version-per-thread}

codex ≥ 0.145 把会话写成「分页」格式：rollout 第一行的 `payload.history_mode` 是 `"paginated"`，之后每一行都带 `ordinal`。
如果之后让 **0.145 之前**的 codex（例如 `npx` 拉到的 0.133）接着这条线程干活，它追加的行没有 `ordinal`；
从此新版 codex 恢复这条线程会直接报错，而且是永久的：

```
final paginated rollout record at <path> is missing an ordinal
```

所以 **永远不要在同一条线程上混用 codex 版本**。anet 现在会在启动前检查（共存启动器 POSIX / Windows、外部 app-server 节点、agent-node 自己起的 app-server 和 codex-sdk）：

- 按 codex 自己的顺序找 rollout（`sessions/` 里最新的那个，没有才看 `archived_sessions/`），只读它的**第一行**（有上限，几百 MB 的文件也只读几十 KB）。
- 取 `codex --version`，只认 `codex-cli x.y.z` 这种行（包装脚本先打印的其它版本号不算，认不出就当未知）。版本探测走和启动完全相同的 shell 前缀（共存节点是 `bash -lc` 登录 shell；外部 app-server 节点先 source 工作区 `.env`），所以查的就是将要启动的那个 codex；启动命令本身不变。
- 线程是分页格式、而 codex < 0.145：**拒绝启动**，什么都不起、不碰 rollout，并提示怎么把节点指向新版 codex：
  `anet node start <节点> --codex-bin /path/to/codex`（共存节点），或 config.json 的 `codexBin` / 环境变量 `ANET_CODEX_BIN`（codex-sdk 节点），或让 PATH 上第一个 codex ≥ 0.145。
- 找不到 rollout、第一行读不出来、版本拿不到：只警告，照旧启动。

已经混用过的线程：恢复时 anet 会说明原因、说明原文件没动，然后照旧 fail-closed（不会偷偷开新线程）。
安全的出路只有两条：fork 恢复（见下一节），或由人决定放弃这段历史后 `anet node start <节点> --new-session`。不要手改或删除 rollout。只读自查：

```bash
head -n 1 <rollout> | grep -o '"history_mode":"[a-z]*"'   # paginated = 新版写的
tail -n 1 <rollout> | grep -c '"ordinal"'                   # 0 = 末尾被旧版追加过
```

### 线程恢复不了的节点怎么救（#738） {#fork-on-resume-failure}

用 codex ≥ 0.145 把这条线程 fork 成一条**新线程**（历史一样），节点改在新线程上启动：

```bash
anet node start <节点> --fork-on-resume-failure          # 会问 [y/N]，只有回答 y 才 fork
anet node start <节点> --fork-on-resume-failure --yes    # 没有终端（脚本 / CI）时必须再加 --yes
```

- 只在恢复失败、而且报错正是 `missing an ordinal` 时才会 fork；其它恢复失败照旧 fail-closed，不 fork。不加这个参数时行为和以前完全一样。
- 没确认（回答不是 y，或非交互又没加 `--yes`）：不 fork，不动任何文件。
- fork 之前先把原 rollout **复制**一份只读快照到 `<节点目录>/rollout-snapshots/`；原文件从头到尾不改（fork 后会再比对一次哈希，变了就不切换）。
- 旧线程 → 新线程、快照路径、时间记在 `<节点目录>/codex-fork-recovery.json`（和 config.json 同目录）。fork 成功后才把 config 里记录的线程改成新线程。
- 🔴 新线程的历史仍然要读**原 rollout 文件**：原文件必须保留，不要移动或删除。
- 目前只覆盖共存节点的 `anet node start`。

### 给节点钉住一个 codex（#739） {#codex-bin-pin}

一台机器上装了几个 codex 版本时，为了不让它们混用同一条线程，在每个共存节点的 `config.json` 里钉住：

```json
{ "codexBin": "/opt/codex-0.159.2/bin/codex", "codexVersion": "0.159.2" }
```

- `codexBin`（绝对路径）：启动**和** #734 版本检查都用这个可执行文件，不管 PATH 上谁排在前面。临时加 `--codex-bin` 仍然优先。
- `codexVersion`：启动时 anet 跑一次 `<codexBin> --version`（和 #734 检查同一种方式）。不是这个版本、或者读不出版本，就在启动任何东西之前拒绝：`expected 0.159.2, got 0.133.0, path …`。
- 两个都不设：照旧用 PATH 上的 `codex`。设了之后 `anet info <节点>` 会显示这两项。
- 目前只覆盖共存节点的 `anet node start`（外部 app-server 节点不检查版本）。anet 不会自动安装 codex。

## 健康分层、降级拒收与自愈 {#health}

「在线」只说明 bridge 进程还活着。`codex-app-server` 运行时的节点（共存和普通的都算）从 agent-node `2.5.0-preview.94` 起，会把另外几层分开报给 Hub。报告随 `report_status` 走，字段名是 `health`：

| 层 | 内容 | 什么时候算坏 |
|---|---|---|
| `bridge` | 恒为 `ok`（能发出这份报告，bridge 就是活的） | — |
| `app_server` | `{ ok, rtt_ms, last_error }`：对本机 app-server 做一次 WebSocket 握手，默认每 30 秒一次，握手最多等 5 秒 | `ok=false` |
| `tui` | `{ ok, reason }`，**只有共存节点有**；`reason` 是 `running` / `session-missing` / `pane-dead` / `sleep-placeholder` / `tmux-unavailable` | `ok=false` |
| `model_auth` | `ok` / `revoked` / `expired` / `unknown`，按最近一次模型调用的结果分类 | `revoked` 或 `expired` |

- 某一层从好变坏或从坏变好，节点**立刻**补报一次，不等下一次心跳。探测间隔可以用 `ANET_CODEX_HEALTH_INTERVAL_MS` 调（毫秒，最小 1000，主要给测试用）。
- Hub 只在内存里保留每个节点最新的一份，**10 分钟**过期。没报、报告过期、某层没报，一律当「不知道」，不当「健康」。Hub `0.9.0-preview.84` 起，`GET /api/status` 会带出这份报告（见 [REST 数据接口](/api/rest-data)）。

### 降级的节点不接新任务

Hub `0.9.0-preview.86` 起，如果一个节点的健康报告还新鲜，并且 `app_server.ok=false`、`tui.ok=false` 或 `model_auth` 是 `revoked` / `expired`，派给它的**新任务**会直接被拒，不再静默排队：

- REST `POST /api/task` 返回 **409** `node_degraded`；MCP `send_task` / `retry_task` / `reassign_task` 返回同一个错误。错误里带上坏掉的每一层（`layers[].label` / `reason` / `hint`）和报告的年龄。
- 定时任务的这一次执行记成失败，`error_code=node_degraded`，不建任务。
- **逃生口**：用户令牌可以带 `force: true` 强制派发（比如明知 TUI 不在，但 bridge 还能干活）。节点令牌带 `force` 无效。
- 回复、`send_message`、ack 不受影响。没有健康报告的老节点照旧可以派活。
- 桌面 / 手机 app `0.2.192` 起，降级的节点在 Agent 列表和节点详情里显示琥珀色的「降级 · 原因」标签，点按或悬停能看到修法。

### App Server 看门狗：死了就按原会话拉起来

agent-node `2.5.0-preview.95` 起，每次 `app_server` 探测结果都会先交给看门狗：

- **进程没了**：连续 2 次探测失败，或者刚收到进程退出 / WebSocket 断开之后的那一次失败，就重启。
  - 共存节点（只在 Linux 上，要读 `/proc`）：在原来的 tmux 会话里，用原样的 argv（同一个 `--listen` 地址）、本节点自己的 `CODEX_HOME` 和身份标记重新拉起 app-server。起来以后核对新进程的 `CODEX_HOME`，对不上就杀掉，算这次重启失败。然后 bridge 按原来的 thread 重新接上（`thread/resume`，不会新开 thread）。
  - 普通 `codex-app-server` 节点（app-server 是 bridge 的子进程）：重新起一个，并接回原 thread。
- 重启期间，健康原因写的是 `restarting app-server (attempt k/N): …`，Hub 照样把它当降级。探测一恢复，健康立刻翻回 ok，派发门自己重新打开。
- **次数上限**：同一个窗口里最多重启 `ANET_CODEX_APPSERVER_RESTART_MAX` 次（默认 3），窗口长度 `ANET_CODEX_APPSERVER_RESTART_WINDOW_MS`（默认 600000，即 10 分钟）。超过就放弃，健康原因变成 `app-server auto-restart gave up: … — restart the node by hand (anet node restart)`，节点保持降级。直到某次探测自己看到 app-server 又能应答（有人手动修好了），才回到看守状态。

### 卡死（进程在、端口在、就是握不上手）

agent-node `2.5.0-preview.96` 起，看门狗把「活着但卡死」和「死了」分开处理。卡死指的是进程还在、端口也还在监听，但每次握手都失败：要么连接被立刻断开（ws 1006），要么一直不应答。

- 卡死期间，健康原因带上 `app-server is alive but not answering (k/M failed probes before restarting it)`，Hub 马上就能看到。
- 连续 M 次探测失败后，先**严格核对**这个进程就是本节点当初起的那个。下面四条都要对：
  1. tmux 会话 id 没变，这个进程仍是该会话里活着的 pane；
  2. `/proc/<pid>/cmdline` 是 `app-server … --listen <本节点地址>`；
  3. `/proc/<pid>/environ` 里的 `ANET_NODE_MARKER` 是本节点的（没有标记的节点一律不杀）；
  4. `/proc/<pid>/environ` 里的 `CODEX_HOME` 是本节点自己的。

  **任何一条对不上，只报降级（原因里写 `not killing it: …`），绝不发信号。**
- 核对通过：先发 SIGTERM（pane 进程是进程组组长时发给整组，连它起的子进程一起），等一段宽限；还活着、而且仍是本节点的，再发 SIGKILL。然后走上面同一条拉起路径，和「进程没了」共用同一个次数上限。
- 可调参数：

  | 环境变量 | 默认 | 含义 |
  |---|---|---|
  | `ANET_CODEX_APPSERVER_HUNG_PROBES` | `4` | 活着但卡死时，连续几次探测失败才动手。按默认 30 秒一次，约 2 分钟持续握不上手 |
  | `ANET_CODEX_APPSERVER_KILL_GRACE_MS` | `10000` | SIGTERM 之后等多久再 SIGKILL，给 codex 落盘会话记录（`thread/resume` 要读）的时间 |

- **macOS / Windows**（没有 `/proc`）：和以前一样只报降级，不自动重启共存的 app-server，也不杀卡死的进程。

看门狗不会切换账号，不会在节点之间拷贝凭据，也不会碰别的节点的进程。

### 为什么每个 codex 节点都有自己的 CODEX_HOME {#why-own-codex-home}

每个 codex 节点（`codex-sdk` 或共存 `codex-app-server`）都用**自己的** `CODEX_HOME`，原因有三：

1. **refresh token 是一次性的。**ChatGPT 登录每刷新一次就换新、旧的作废；同一份登录放进两个 `CODEX_HOME`，谁先刷新谁活，另一个被顶掉（#1918、#514，见下一节）。
2. **会话按 HOME 存。**codex 把会话（rollout）存在 `CODEX_HOME/sessions/` 下；两个节点共用一个 HOME，两边的历史就混在一起。
3. **停止 / 删除按 CODEX_HOME 认进程。**`anet node stop` / `delete` 靠节点自己的 `CODEX_HOME`（加共存标记）认出哪些进程属于这个节点；共用 HOME 就分不清。

代价是**每个节点要单独 `codex login` 一次**。anet 把这一步摆到明面上：

- **创建时给出下一步。**`anet node create` / `anet node clone` 建出的 codex 节点如果启动后不会有可用登录（节点自己的 `codex-home` 里没有，首启也不会合法地借用本机 `~/.codex` 登录），命令最后会打印给**这个节点**登录的确切命令，不会替你执行，也不会从别的节点拷 `auth.json`：

  ```text
  [anet] Next step — my-node has no codex login yet. Each codex node logs in on its own, in its own CODEX_HOME
      mkdir -p -m 700 <节点目录>/codex-home && CODEX_HOME=<节点目录>/codex-home codex login
  [anet]   On a headless machine / over SSH use device auth instead:
      mkdir -p -m 700 <节点目录>/codex-home && CODEX_HOME=<节点目录>/codex-home codex login --device-auth
  [anet]   Then: anet node start my-node
  ```

  `mkdir` 只在目录还不存在时出现（codex 不接受不存在的 `CODEX_HOME`）。`--device-auth` 是 codex CLI 自带的设备码登录，适合没有浏览器的机器。`codex-sdk` 节点没有自己的 `codex-home` 时用的是 codex 默认的 `~/.codex`，提示里给的就是那个目录。`anet node codex fork --no-codex-login` 一直会在结果里给出同样的登录命令。

- **一眼看登录状态：`anet node codex login-status [--json]`。**当前目录下每个 codex 节点一行：

  ```text
  ALIAS  RUNTIME                         LOGGED IN  ACCOUNT            SHARED WITH  CODEX_HOME
  one    codex-app-server (co-presence)  yes        you@example.com    ⚠ two        <ws>/.anet/nodes/one/codex-home
  two    codex-app-server (co-presence)  yes        you@example.com    ⚠ one        <ws>/.anet/nodes/two/codex-home
  three  codex-app-server (co-presence)  no         -                  -            <ws>/.anet/nodes/three/codex-home
  ```

  - `ACCOUNT`：`id_token` 里的邮箱（本地解码，不联网）；没有邮箱时显示账号指纹 `acct:<16 位>`。
  - `SHARED WITH`：和这个节点持有**同一份登录**（同一条 refresh token 链，8 位指纹相同）的其他节点——它们会互相顶掉。别的工作区的节点只看它们公布的指纹文件，从不读它们的 `auth.json`。
  - 同一个账号、但各自单独登录的节点**不算**共享（那正是推荐做法），`--json` 里放在 `same_account_as`。
  - 只读；任何 token 都不会出现在输出里。

  为什么另起一个命令、不放进 `anet node codex account list`：那个命令列的是本机登记的登录 **profile**（按 profile id，`--json` 形状已有人用），这里列的是本目录的**节点**和各自持有的登录。

### 一个登录只给一个节点 {#one-login-per-node}

ChatGPT 登录的 refresh token 是**一次性**的,每刷新一次就换一个新的、旧的作废。同一份 `auth.json`(同一次登录)出现在两个节点的 `CODEX_HOME` 里,谁先刷新谁活,其余节点几天后报:

```text
Your access token could not be refreshed because you have since logged out or signed in to another account   (401 token_revoked)
```

所以 anet 在**把登录交给一个节点的那一刻**拦住共享(#514),默认拒绝、退出码 `1`:

| 路径 | 什么时候拒绝 |
|---|---|
| `anet node start <name> --copresence` 把本机 `~/.codex/auth.json` 放进节点 | 节点的 `codex-home` 里**还没有** `auth.json`(新节点、clone 的首次启动),而本机已有**别的节点**在用这份登录 |
| `anet node codex fork` | 总是会复制源节点正在用的登录 → 默认拒绝;用 `--no-codex-login` 不带登录 |
| `anet node codex account install` | 这个 profile 的登录已被别的节点使用 |
| `anet node clone` | 本来就不复制 `auth.json`;首次启动走上面第一行 |

拒绝信息只列对方节点的**别名**,并给出修法和覆盖开关。修法:每个节点自己登录一次(SSH 上也能用设备码):

```bash
CODEX_HOME=<节点目录>/codex-home codex login --device-auth
```

`--allow-shared-codex-login` 可以强行共享,**不安全**:这几个节点会互相顶掉登录。只在你明确知道后果时用。

几条规则:

- **只拦新增的共享。**节点 `codex-home` 里已经有 `auth.json` 的(老节点)照常启动,如果它和别人共享,启动时打一段告警(#1918),`anet doctor` 会列出所有共享同一登录的节点组。
- **本机登录**:第一个借用 `~/.codex` 登录的节点放行,并提示这份登录不要再给别的节点、也不要同时在本机直接跑 `codex`;第二个节点被拒。anet 看不到你是否在本机手动用 `codex`,这一点只能靠你遵守。
- 比较用的是 refresh token 的 8 位 sha256 指纹,不是账号 id:同一个账号的两次独立登录互不影响,不算共享。anet 只读各节点公布在 `~/.anet/codex-auth-fingerprints/` 和节点目录里的指纹文件,**从不读别的节点的 `auth.json`**,也不打印任何 token。
- 交给节点的登录会记下来源指纹(`.codex-auth-origin.json`):第一个节点刷新后它的副本换了新 token,而 `~/.codex` 里还是那个已经用掉的旧 token,下一个节点照样会被拦住。
- API key 登录(`auth.json` 里没有 refresh token)不会轮换,不受这条规则限制。

### 模型登录失效 {#model-login}

`model_auth` 变成 `revoked`（refresh token 被作废）或 `expired`（登录过期，而且没能自动刷新）之后：

- 节点不再接活：空闲时上报 `status=error`，`task` 里写着需要重新登录。Hub 也会按上一节把它当降级。
- Hub `0.9.0-preview.87` 起，会给**节点主人**发**一条**通知，标题「节点登录失效」，出现在 app 里和这个节点的会话中，带未读角标。每次进入坏状态只发一次；节点重新报告 `ok` 之后才会再发。Hub 重启后，如果主人还有一条没读的同类通知，也不会重发。
- 修法：在那台机器上，给**这个节点自己的** `CODEX_HOME` 重新登录：

  ```bash
  CODEX_HOME=<节点目录>/codex-home codex login
  ```

  不要拷别的节点的 `auth.json`。
- 登录好之后，节点发现 `auth.json` 在出错之后被改写过，就退回 `unknown`、重新接活；下一次模型调用成功后报 `ok`。不用重启节点。

## 生命周期命令：`anet node codex …`

> 不想记下面这些命令：在节点目录里直接敲 `anet node codex`，会列出节点、让你选操作，执行前打印等价命令并确认。一页速查见 [Codex 节点速查：我想……就敲……](/guide/codex-cheatsheet)。

重启 / 恢复共存节点以前靠人肉 runbook(见下文[手工安全重启](#safe-restart));现在把每一步「核什么」做成确定性的 CLI,正常流程不调用任何 LLM,只出机器可读 receipt。第一批两个只读命令:

```bash
anet node codex preflight <alias>          # 只读核对,exit 0 = PASS / exit 2 = FAIL
anet node codex verify    <alias> --json   # preflight + 子进程环境核对 + 跨节点身份验收;JSON 供自动化消费
```

### 重启 / 启动 / 恢复:确定性状态机,零 LLM

```bash
anet node codex restart <alias> --probe-from <另一个本地节点>   # 停 Bridge→TUI→App Server,再起,再核对
anet node codex start   <alias> --probe-from <peer>              # 三段都不在时才允许;否则要求用 restart
anet node codex resume  <alias> --thread <36 位 thread id> --probe-from <peer>
```

`restart` 的每一步顺序固定、不做推理:**preflight(before)** 任一项 fail 就不碰进程 → 读 **goal 状态**(读不到或 schema 不认识 = 不明,直接 STOP)→ 按依赖反向 **停 Bridge → TUI → App Server**(先断任务入口,再让 TUI 把 rollout 刷完,最后放掉端口)→ 等 rollout 字节数稳定(大会话慢刷盘)→ 等端口空闲(占用者若核实是本节点残留的 app-server 才定向 TERM,外来进程一律 FAIL 不动)→ 交给启动器 `anet node start --copresence --tui-first`(**App Server → 端口就绪 → exact-session TUI 完全恢复 → Bridge**;bridge 晚于 TUI,任务不会落到人看不见的会话上)→ **verify(after)**:preflight 全项 + 子进程环境 + rollout 前后比对(同一文件、字节只增不减)+ goal 文件未变 + hub 回到在线 + 跨节点 nonce 验收。启动失败自动回滚一次(按原配置再起);再失败就停在已停状态,receipt 记到哪一步。

`--probe-from <peer>`(peer 住在别的 `.anet` 根时加 `--probe-root <dir>`)用另一个本地节点通过 hub 给目标发一条带随机 nonce 的任务,等目标回复经 hub 落到 peer 的收件箱,且 hub 标注的发送者正是目标 alias,`identity_attested` 才算 pass;不给 peer(单节点)时该项记 `n/a`:摘要里显示 `-`,结论行带 `(not applicable: identity_attested)`,不阻塞 —— 健康的单节点得 PASS(exit 0);给了 peer 但回错人仍是 **FAIL**。失败时 `blocking:` 只列真正失败的检查。`resume --thread` 只接受完整 36 位 id 且该 id 在本节点 CODEX_HOME 下恰有一个 rollout,才写进 config;不接受前缀,不猜「最近一个」。

`--json` 输出整份 receipt(含 `stoppedAt` / `rolledBack`),供 Dashboard「体检」按钮消费。

### fork:继承历史,其余全新

只要设置、不要历史时用 `anet node clone`;两者对照和删除方法见 [复制节点(clone / fork)与清理](/guide/copy-node)。

```bash
anet node codex fork <source> --name <target> --workdir <dir> --no-codex-login [--inherit-full-access] [--model <id>]   # <dir> 不存在会自动建
CODEX_HOME=<dir>/.anet/nodes/<target>/codex-home codex login --device-auth   # 新节点自己登录(#514)
cd <dir> && anet node codex start <target> --probe-from <source>      # 首次启动 = verify + nonce 验收
```

fork 只读源节点(它的 auth.json / config.toml 和**那一个** rollout),在 `<dir>/.anet/nodes/<target>/` 造一个全新节点:新 `node_id` 与 CommHub 身份、新 `CODEX_HOME`(0700,auth.json 0600)、新 thread id(UUIDv7)、新工作目录、新 tmux 名;端口在首次启动时分配。rollout 是**流式复制并逐处改写 thread id**(定长 36 字符,字节数不变),不是共享同一文件;第一行必须是源 thread 的 `session_meta`,否则一个字节都不写。源节点的 `.anet-copresence.env`(含它的 CommHub token)、history、sqlite、缓存一律不带;完整访问也不继承,除非显式 `--inherit-full-access` 且源节点本来就开着。

**登录不跟着 fork 走(#514)。**源节点正在用它的 `auth.json`,复制过去两个节点就共用一条一次性 refresh token 链(见[一个登录只给一个节点](#one-login-per-node))。所以不带 `--no-codex-login` 的 fork 默认拒绝(exit 1,在向 Hub 注册之前,什么都不留下);`--no-codex-login` 不复制 `auth.json`,receipt 的 `home_isolated` 写明首启前要登录;`--allow-shared-codex-login` 照旧复制,不安全。

receipt 的 `fork_isolation` 要求身份 / HOME / thread / rollout 文件 / tmux 名五处都不同、rollout 等长复制且目标 HOME 里没有 token 文件;`identity_attested` 在 fork 阶段为 unknown(不阻塞),由首次 `start --probe-from` 闭环。`start` / `restart` / `resume` 必须在 `config.codexProjectDir` 记的目录里执行,否则拒绝(三段 tmux 的工作目录与 `.anet/nodes` 都是相对当前目录的)。

fork 顺手把几件以前要手工做的事做了(#1951),都记在 receipt 的 `fork_options` 里:`--workdir` 不存在就建;复制来的 `config.toml` 里 `[projects."<源工作区>"]` 表头改写成 `<dir>`(只改表头,别的行一字不动;目标表已存在则丢掉源表,不重复);`--model <id>` 写进目标配置,源 rollout 末条 `turn_context` 用的模型不同时打一句告警(provider 块保留,删了 app-server 拒载);fork 时探一个空闲回环端口写进 config,首次 `start` 优先用它、被占再探;`CODEX_HOME/AGENTS.md` 随 fork 走。

### adopt:把 anet 之外开的对话收编成节点 {#adopt}

```bash
anet node codex adopt <新名字> --thread <完整 id 或唯一前缀> [--from-home <dir>] [--workdir <dir>] [--model <id>]
CODEX_HOME=<workdir>/.anet/nodes/<新名字>/codex-home codex login --device-auth
cd <workdir> && anet node codex start <新名字>
```

`adopt` 就是源换成「一个裸 `CODEX_HOME`(默认 `~/.codex`)+ 一个 thread id」的 `fork`(#528)。不给 `--thread` 时列出该 home 里的对话(时间、cwd、第一句提问、短 id):终端里按编号选,非终端只打印列表、退出码 2。thread id 必须恰好对应一个 rollout(完整 id 或唯一前缀),0 个或多个都拒绝。那一个 rollout 流式复制进新节点自己的 `CODEX_HOME`,thread id 与记录的 `cwd` 按 fork 的同一套规则改写(表头带 `session_id`,或旧版 codex 只带 `id`,都认);`config.toml` / `AGENTS.md` / `version.json` 随之复制并改写 trusted project 表头。源 home 从不写入。默认不复制 `auth.json`,`--allow-shared-codex-login` 才复制(不安全)。receipt(verb `adopt`)的检查项与 fork 相同。操作步骤见 [复制节点](/guide/copy-node)。

### 账号迁移:`account install` 与 `rollback`

```bash
CODEX_HOME=/some/home codex login                                   # 人先在任意 HOME 登录一次(ChatGPT)
anet node codex account register team-a --from-codex-home /some/home  # 登记进本机受控 registry(host-bound)
anet node codex account list
anet node codex account install <alias> --source codex-login:team-a --probe-from <peer>
anet node codex rollback <alias> --receipt <install-receipt-id> --probe-from <peer>
```

登录源只接受 **不透明引用** `codex-login:<profile-id>`:CLI 不收路径、stdin、环境变量。profile 由本机 `~/.anet/codex-login/registry.json`(0600)解析,凭据正文存 `profiles/<id>/auth.json`(0600),条目绑定 `host_id`(machine-id + 主机名的摘要),拷到别的机器不认;PR-D 只认 ChatGPT 登录(`auth_mode=chatgpt`)。receipt、registry、日志里只出现 `profile_id` 与不可逆的 `account_fingerprint`(sha256(account_id) 前 16 位)以及 `backup_ref`,不出现 token、auth 内容或真实路径。

`install` 是确定性状态机:目标 preflight(fail 即停)→ 在隔离的临时 HOME 里用该 profile 发一次 **fresh 模型请求**(`codex exec`,固定回句;401 / 凭据失效 → auth,配额 / 429 → quota,模型不兼容 → model,归不了类 → unknown,四种都 STOP 且目标一字未动,探针结果回写 registry)→ 备份目标 auth.json 到 `receipt:<id>`(0600)→ 0600 原子安装 → **完整重启**(PR-B 状态机,含 verify + nonce 验收)→ 目标指纹必须等于源指纹。安装后任一步失败 → 自动恢复备份并再重启一次,receipt 记录两段。

`rollback` 只接受原 install receipt 里的 `backup_ref`,不接受调用方另传文件:恢复 → 完整重启 → 指纹回到 receipt 记的 `targetPreviousFingerprint`。

### 批量之前先 canary

```bash
anet node codex canary 节点A 节点B 节点C --probe-from <peer>     # 逐个 verify,第一个 FAIL 即停
```

要对一批共存节点做重启或换账号,先跑 `canary`:名单先整体核对(名字打错、不是 codex 节点都直接拒绝,一个不跑),然后**按顺序逐个 `verify`**(给了 `--probe-from` 就带 nonce 验收),第一个 FAIL 处停下,后面的节点一个不碰,汇总里明确标成「not run」。每个节点各留一份 verify receipt;`--json` 输出汇总(`ran` / `skipped` / `stoppedAt`)。exit 0 = 全部 PASS。

`preflight` 核的项(每项 pass / fail / unknown,**任一非 pass 整体 FAIL**,不许部分成功):alias 与 hub 名册里的 `node_id` 精确匹配;节点自己的 `CODEX_HOME` 0700、`auth.json` 0600、CommHub token 指纹一致;工作目录在 config、TUI 进程 cwd、TUI `-C`、Bridge 进程四处一致;`codexThreadId` 是完整 36 位且 `CODEX_HOME` 里恰有一个对应 rollout(记下绝对路径、inode、字节数、mtime;不接受前缀或「最近的文件」);app-server 端口的占用者确实是本节点的进程(否则视为 foreign PID,不会去动它);tmux 三段(app-server / TUI / bridge)都在跑且子进程都带本节点的身份 marker。

receipt 写在 `.anet/nodes/<id>/receipts/<id>.json`(0600):凭据只记不可逆短指纹,token 不会出现在 receipt、日志或参数里。`verify` 在跨节点 nonce 探针落地前 `identity_attested` 恒为 unknown,因此恒 FAIL —— 这是有意的。start / restart / resume / fork / account / rollback 分批落地,合同见仓库 issue #1856。

## 权限：默认只读，完整访问必须双重确认

共存默认使用 `sandbox_mode=read-only` 与按需审批。需要 Codex 写文件、跑完整网络/命令工具时，必须显式选择：

```bash
anet node start codex-human --copresence --dangerously-allow-full-access
```

- 交互式终端会要求手工输入 `yes`。
- 非 TTY 的脚本、CI 或 Docker 还必须再传 `--yes-danger-full-access`：

```bash
anet node start codex-human --copresence \
  --dangerously-allow-full-access \
  --yes-danger-full-access
```

第二个 flag 只用于无法交互的调用方，不能省略；它防止管道输入绕过确认。完整访问会关闭文件系统/网络沙箱，只应在可信工作区和可信任务上启用。

## 普通 `codex-app-server` 节点不是共存

不带 `--copresence` 时：

```bash
anet node create codex-worker --runtime codex-app-server
anet node start codex-worker
```

节点会自己 spawn 私有 app-server 和新 thread，适合作为 codex 驱动的后台 Agent；由于没有人类可 attach 的 TUI，这条路径**不是人机共存**。

## 高级接管：手工共享 WS

日常使用原生 Windows 请直接运行前面的一键命令。本节只用于接管已有 app-server 或调试。**每个节点使用独立 app-server/端口，不要让多个节点共用**：CommHub bearer token 是 app-server 的进程级环境，复用会造成 thread 身份混淆，也会制造单点故障。

```powershell
# 起前先找空闲端口；示例端口仅占位
# Windows PowerShell:
Get-NetTCPConnection -LocalPort <free-port> -ErrorAction SilentlyContinue

# Terminal 1：先 cd 到目标项目，再起独立 app-server
cd C:\path\to\project
$env:CODEX_HOME = "C:\path\to\project\.anet\nodes\codex-human\codex-home"
codex app-server --listen ws://127.0.0.1:<free-port>

# Terminal 2：先启动 bridge，让 runtime 创建/捕获 thread 并写回 codexThreadId
Get-ChildItem Env:COMMHUB_* | ForEach-Object { Remove-Item "Env:$($_.Name)" }
$env:CODEX_HOME = "C:\path\to\project\.anet\nodes\codex-human\codex-home"
anet node create codex-human --runtime codex-app-server --codex-app-server-url ws://127.0.0.1:<free-port>
anet node start codex-human

# 从节点 config.json 读取 codexThreadId/model 后，让 Terminal 3 接入同一条
# thread；必须使用该节点自己的 CODEX_HOME
$env:CODEX_HOME = "C:\path\to\project\.anet\nodes\codex-human\codex-home"
codex resume --remote ws://127.0.0.1:<free-port> <codexThreadId> -m <model>
```

`codex resume --remote` 必须同时对齐节点的独立 `CODEX_HOME`、`codexAppServerUrl`、`codexThreadId` 与 `model`。省略 thread id 会进入历史会话 picker，容易接错线程；省略 `CODEX_HOME` 更危险：Codex 可能使用默认 `~/.codex` 并静默连接外网 443，留下一个空白 pane，看起来像已成功接入，实际却是独立云端会话。bridge 首次写回 `codexThreadId` 时会打印可直接复制的 POSIX 与 PowerShell resume 命令。创建节点时也可加 `--codex-thread-id <id>` 接管指定 thread；不传时 runtime 自动捕获并写回配置。

手工启动后不要只看空 pane 判断成功：检查 TUI 进程的 socket，确认它连接的是配置中的 loopback `codexAppServerUrl`（而不是外网 `:443`），再在 TUI 与 bridge 两侧核对同一个 thread id。Linux/macOS 同样必须先 `export CODEX_HOME='<节点目录>/codex-home'`，再执行带 `--remote`、thread id 与 `-m` 的 `codex resume`。

手工拓扑的三个终端还必须显式使用**同一个节点专属 `CODEX_HOME`**。漏掉任意一处时，Codex 可能静默使用用户默认 `~/.codex`，TUI 看起来已经启动，实际却连到另一套云端会话而不是这个 loopback app-server。不要让持久化节点与主 Codex 会话共享 `CODEX_HOME`。

Linux/macOS 的高级用户也可用这一拓扑连接已存在的 app-server，但日常使用优先 `--copresence`，它会统一处理 loopback、独立 `CODEX_HOME`、MCP 注入、tmux 生命周期与停止身份。若本机 24700–24720 等常用范围已被其他共存节点占用，继续选新的空闲 loopback 端口，启动前先查占用。

上一段说的「检查 socket」，具体是这条，判据是**连接对数**：

```bash
ss -tnp | grep '127.0.0.1:<app-server 端口>'
```

正常应当看到**两对** ESTAB —— bridge 一对、TUI 一对。**只有一对就是 TUI 没接上**（此时 pane 同样是空的，看不出区别）。实测（2026-08-26，Linux）：缺 `CODEX_HOME` 起的 TUI，其 codex 子进程唯一的 TCP 连接是到公网 `:443`。

app-server **支持多客户端**，所以 bridge 连着的时候 TUI 照样能 join 同一条 thread，**不需要先停 bridge**（本机实测：接上新 TUI 后 bridge 6 秒往返照常）。

手工启动的 app-server 不会自动获得 `--copresence` 注入的 CommHub MCP；若希望人类 TUI 直接调用 `commhub_*`，必须在 **app-server 创建 thread 之前**按 RFC-030 配好 MCP URL 与 bearer-token 环境变量。既有 thread 会快照工具集，事后补 MCP 不会生效。不要把 token 放进命令行或聊天。

::: warning Codex CLI 升级提示
TUI 启动时可能出现 `Update available`，且默认高亮立即升级。共享宿主上请选“跳过/稍后”，把 Codex CLI 升级安排到维护窗口；全局升级二进制可能同时影响这台机器上的所有共存节点。
:::

## 手工安全重启（不用 `anet node codex restart` 时） {#safe-restart}

优先用上面的 `anet node codex restart`，它把下面每一项都做成了自动核对。只有在用不了它时（旧版本、手工拓扑），才按这份清单手工做。目标不是「进程重新出现」，而是**同一个节点身份、同一个 thread、同一个工作目录、同一份主 rollout** 都被恢复。任一项不一致立即停下，修好后从头重新验收。

### 1. 重启前逐节点记录现状

| 记录项 | 为什么要它 |
|---|---|
| alias、node_id、节点专属 `CODEX_HOME` | 验收时核对身份 |
| 预期工作目录（绝对路径） | TUI `-C`、bridge cwd、CommHub `project_dir` 三处要对齐到它 |
| 完整 36 位 thread ID | 恢复必须 exact，不接受前缀 |
| 主 rollout 绝对路径 + 字节数 | 重启后不得缩小、不得被换成新文件 |
| goal 状态（active / paused） | 重启后保持原状态 |
| app-server / TUI / bridge 的真实子进程命令行 | 照原样拉起；看子进程，不看外层启动器或 tmux 名 |

先备份节点的 `auth.json` 并 `chmod 0600`。凭据、`ntok_`、`atok_` 不进命令行参数、日志、回执或截图。

### 2. 按顺序停，反序起

- 停：**bridge → TUI → app-server**（优先在共存进程树外执行 `anet node stop <alias>`）。停完核对没有孤儿进程、孤儿监听端口，旧 bridge 不再连着 Hub。
- 起：**app-server → TUI → bridge**。app-server 与 TUI 都显式用该节点的 `CODEX_HOME`；TUI 用完整 thread ID 和显式工作目录恢复：

```bash
codex resume --remote <app-server-url> <full-thread-id> -C <node-cwd> -m <model>
```

bridge 启动前先 `cd` 到节点工作目录。禁止用短前缀、「最近一个 session」或交互 picker。

### 3. 验收：全部通过才算恢复

- [ ] **身份**：Hub 上 `from_name` / `from_node_id` 与目标节点一致（用无副作用的固定短语探针验证，别拿真任务当探针）
- [ ] **会话**：完整 thread ID 与记录一致
- [ ] **rollout**：同一绝对路径，字节数 ≥ 重启前，内容未被新 thread 替换
- [ ] **工作目录**：TUI `-C` == bridge cwd == CommHub `project_dir` == 节点配置
- [ ] **goal**：active 的继续，paused 的保持 paused，没有意外续跑
- [ ] **进程**：三段都在线，Hub 显示 online / idle，没有旧实例重复连接
- [ ] **凭据**：`auth.json` 为 `0600`，secret 没出现在 argv、日志或回执里

「三个进程都起来了」只是其中一项，不是结论。批量重启时先对一个节点做 canary，通过后再逐个进行。

## 长任务与 600 秒提示

一条 thread 同一时刻只能有一个 active turn；后续网络任务会 FIFO 排队。当前网络任务等待最终回复的窗口**默认**是 600 秒（runtime 选项可覆盖，并非不可变的硬上限）：

- 看到“`600s 内无最终回复`”**不等于节点已死**，也不会自动取消正在 Codex 中执行的 turn。
- 不要立刻重复派同一任务；先看 `tmux capture-pane -t =codex-human -p | tail -30` 和工作区是否仍在变化。
- 重代码/长工具链任务尽量拆成可在 10 分钟内完成并回报的小步；若确认静默卡死，按 [codex-app-server 卡死诊断与重启 SOP](https://github.com/sleep2agi/agent-network/blob/main/docs/sop/codex-app-server-jam-restart.md) 先保全工作再重启。

## 安全与已知边界

- app-server 只监听 `127.0.0.1`；token/密钥不进 argv、git 或聊天。
- 一条 thread 同一时刻只有一个 active turn；“同时通信”表示多生产者可以投递，不表示多个 turn 并行执行。
- 默认模式下桥不代答审批，需要审批的 turn 交给人类 TUI；完整访问模式则是用户显式选择的高风险例外。
- Phase 0A 仍是 TUI 与 bridge 直接双客户端连接。生产形态所需的单 upstream Policy Gateway、强制仲裁和最小控制面尚未完成。

## 参考

- [RFC-030 Codex TUI Bridge](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-030-codex-tui-bridge.md)
- [节点 Runtime](/guide/runtimes)
- [CLI：`anet node start`](/guide/cli#anet-node-start)
- [Grok 节点](/guide/grok)

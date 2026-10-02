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

### 首次派活前必须看一眼 TUI 是否卡在审批框

::: danger 节点会「看起来完全健康」却什么都干不了
`--copresence` 起完之后，TUI 一旦接上，MCP 工具调用就变成**要人确认**。如果没人在 TUI 前面点，节点会永远停在：

```
Allow the commhub MCP server to run tool "get_task"?
› 1. Allow   2. Allow for this session   3. Always allow   4. Cancel
```

**此时 hub 上的所有信号都是健康的**：`status=idle`、SSE 已连接、`last_seen_at` 持续更新。派活方看不出任何异常，只会以为它闲着。

**唯一能发现的方法**（hub 的任何字段都查不出来）：

```bash
tmux capture-pane -t =<alias> -p | grep "Allow the commhub MCP"
```

**处置**：选 `3. Always allow`（commhub 那几个工具是节点自身运转必需的）；或在 app-server 启动参数里带 `-c approval_policy=never`，从源头避免。

实测（2026-07-31）：新建 TUI 的节点复现；同宿主既有共存节点未受影响（它们的 app-server 启动时带了 `approval_policy=never`）。**所以这是「新建 TUI 时」的坑，不是存量问题。**
:::

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

`--probe-from <peer>`(peer 住在别的 `.anet` 根时加 `--probe-root <dir>`)用另一个本地节点通过 hub 给目标发一条带随机 nonce 的任务,等目标回复经 hub 落到 peer 的收件箱,且 hub 标注的发送者正是目标 alias,`identity_attested` 才算 pass;不给 peer 时该项 unknown,整体 **FAIL**(有意:不许「大概是它」)。`resume --thread` 只接受完整 36 位 id 且该 id 在本节点 CODEX_HOME 下恰有一个 rollout,才写进 config;不接受前缀,不猜「最近一个」。

`--json` 输出整份 receipt(含 `stoppedAt` / `rolledBack`),供 Dashboard「体检」按钮消费。

### fork:继承历史,其余全新

```bash
anet node codex fork <source> --name <target> --workdir <dir> [--inherit-full-access] [--model <id>]   # <dir> 不存在会自动建
cd <dir> && anet node codex start <target> --probe-from <source>      # 首次启动 = verify + nonce 验收
```

fork 只读源节点(它的 auth.json / config.toml 和**那一个** rollout),在 `<dir>/.anet/nodes/<target>/` 造一个全新节点:新 `node_id` 与 CommHub 身份、新 `CODEX_HOME`(0700,auth.json 0600)、新 thread id(UUIDv7)、新工作目录、新 tmux 名;端口在首次启动时分配。rollout 是**流式复制并逐处改写 thread id**(定长 36 字符,字节数不变),不是共享同一文件;第一行必须是源 thread 的 `session_meta`,否则一个字节都不写。源节点的 `.anet-copresence.env`(含它的 CommHub token)、history、sqlite、缓存一律不带;完整访问也不继承,除非显式 `--inherit-full-access` 且源节点本来就开着。

receipt 的 `fork_isolation` 要求身份 / HOME / thread / rollout 文件 / tmux 名五处都不同、rollout 等长复制且目标 HOME 里没有 token 文件;`identity_attested` 在 fork 阶段为 unknown(不阻塞),由首次 `start --probe-from` 闭环。`start` / `restart` / `resume` 必须在 `config.codexProjectDir` 记的目录里执行,否则拒绝(三段 tmux 的工作目录与 `.anet/nodes` 都是相对当前目录的)。

fork 顺手把几件以前要手工做的事做了(#1951),都记在 receipt 的 `fork_options` 里:`--workdir` 不存在就建;复制来的 `config.toml` 里 `[projects."<源工作区>"]` 表头改写成 `<dir>`(只改表头,别的行一字不动;目标表已存在则丢掉源表,不重复);`--model <id>` 写进目标配置,源 rollout 末条 `turn_context` 用的模型不同时打一句告警(provider 块保留,删了 app-server 拒载);fork 时探一个空闲回环端口写进 config,首次 `start` 优先用它、被占再探;`CODEX_HOME/AGENTS.md` 随 fork 走。

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

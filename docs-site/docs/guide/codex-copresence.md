# Codex TUI 人机共存（`codex-app-server`，preview）

`codex-app-server` runtime 让**人和 Agent 共用同一个 Codex 会话**：人在原生 Codex TUI 里输入、看输出、处理审批，Agent Network 的任务经 CommHub 注入**同一个 Codex thread**。双方看到同一段历史和同一组实时事件。（[RFC-030](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-030-codex-tui-bridge.md)，Phase 0A。）

> 与无头的 `codex-sdk` 不同：`codex-sdk` 是后台工作器、没有可共存的活 TUI；`codex-app-server` 才提供 Codex TUI 人机共存。

::: warning Preview
这是 **preview-only** 功能。npm `latest` 当前完全不含 `codex-app-server`、`--copresence` 或 `codexAppServerUrl`；装了 `latest` 的用户无法使用本页命令。当前实现还是单机可信形态，不是生产 Policy Gateway；只连接可信 Hub、只接收可信任务。
:::

## 前置

- 安装并登录 Codex CLI（协议验证基线为 `codex-cli 0.144.x`）：

```bash
npm install -g @openai/codex
codex login
```

- 安装或切换到 preview 频道：

```bash
npm install -g @sleep2agi/agent-network@preview @sleep2agi/agent-node@preview
# 已装 anet 时也可让整组组件切到 preview：
anet upgrade --channel preview

# 自检：输出必须显示 preview 版本，help 必须出现 Co-presence / --copresence
anet -v
anet --help
```

- 推荐的一键共存路径还需要 `bash` 和 **tmux 3.2+**。当前以 Linux/WSL 等 POSIX 环境为目标；原生 Windows 请用下方的[手工共享 WS 路径](#原生-windows-或高级接管手工共享-ws)。
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

# 3. 进入人机共用的 TUI
tmux attach -t =codex-human
```

Codex thread 的工作目录继承自 **app-server 进程启动时的 cwd**，不是 bridge 的 cwd；因此要在运行 `--copresence` **之前**先 `cd` 到目标项目。Linux 上可用 `readlink /proc/<app-server-pid>/cwd` 复核，不能只检查 bridge。

`create --copresence` 会把选择写入节点配置；此后普通 `node start`（包括停止或中断后的恢复）都会重建同一套共存拓扑，无需重复 flag。旧节点也可第一次运行 `anet node start codex-human --copresence`，CLI 会记住选择，后续同样只需 `anet node start codex-human`。

交互菜单里的 `codex-cli` 就是共存模式：选中后直接写入 `codexCopresence: true`，不再要求第二次选择。`codex-sdk` 是后台无头 Codex 节点。脚本可使用等价命令 `anet node create codex-human --runtime codex-cli`；旧的 `--runtime codex-app-server --copresence` 继续兼容。

::: warning 发布渠道
这个交互选项已在 `main` 通过真实 PTY 测试，并已随 **preview.42** 发布。安装或升级 preview 后，即可在交互菜单中直接选择 `codex-cli`。
:::

启动会创建三个带同一身份标记的 tmux session：

| Session | 作用 |
|---|---|
| `codex-human-appsrv` | 只监听 loopback 的 `codex app-server`，并注入 CommHub MCP |
| `codex-human-桥` | `agent-node` bridge，接收网络派工并投进同一 thread |
| `codex-human` | 人类可 attach 的原生 Codex TUI |

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

::: danger 断线恢复仍必须回到共存命令
如果 bridge 长时间断线后提示“运行 `anet node start codex-human` 手动恢复”，**不要照抄这条通用提示**。普通 `start` 会另起一个非共存节点，与仍存活的 bridge 争抢同一 alias。应在外部 shell 中停止旧共存树、重新清空 `COMMHUB_*`，再运行：

```bash
anet node stop codex-human
cd /path/to/project
for v in $(env | sed -n 's/^\(COMMHUB_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done
anet node start codex-human
```

这不是理论风险：生产节点 `TM副责人` 因此静默重复运行约 2 天，`A站副责人` 则持续约 9 天（[#535](https://github.com/sleep2agi/agent-network/issues/535)）。
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

## 原生 Windows 或高级接管：手工共享 WS

原生 Windows 没有上述 tmux 编排，可手工让 TUI 与 bridge 连接同一个 loopback WebSocket。**每个节点使用独立 app-server/端口，不要让多个节点共用**：CommHub bearer token 是 app-server 的进程级环境，复用会造成 thread 身份混淆，也会制造单点故障。

```powershell
# 起前先找空闲端口；示例端口仅占位
# Windows PowerShell:
Get-NetTCPConnection -LocalPort <free-port> -ErrorAction SilentlyContinue

# Terminal 1：先 cd 到目标项目，再起独立 app-server
cd C:\path\to\project
codex app-server --listen ws://127.0.0.1:<free-port>

# Terminal 2：先启动 bridge，让 runtime 创建/捕获 thread 并写回 codexThreadId
Get-ChildItem Env:COMMHUB_* | ForEach-Object { Remove-Item "Env:$($_.Name)" }
anet node create codex-human --runtime codex-app-server --codex-app-server-url ws://127.0.0.1:<free-port>
anet node start codex-human

# 从节点 config.json 读取 codexThreadId 后，Terminal 3 接入同一条 thread
codex resume --remote ws://127.0.0.1:<free-port> <codexThreadId>
```

`codex resume --remote` 必须带 session/thread id；省略会进入历史会话 picker，容易接错线程。创建节点时也可加 `--codex-thread-id <id>` 接管指定 thread；不传时 runtime 自动捕获并把 `codexThreadId` 写回节点配置。

Linux/macOS 的高级用户也可用这一拓扑连接已存在的 app-server，但日常使用优先 `--copresence`，它会统一处理 loopback、独立 `CODEX_HOME`、MCP 注入、tmux 生命周期与停止身份。若本机 24700–24720 等常用范围已被其他共存节点占用，继续选新的空闲 loopback 端口，启动前先查占用。

手工启动的 app-server 不会自动获得 `--copresence` 注入的 CommHub MCP；若希望人类 TUI 直接调用 `commhub_*`，必须在 **app-server 创建 thread 之前**按 RFC-030 配好 MCP URL 与 bearer-token 环境变量。既有 thread 会快照工具集，事后补 MCP 不会生效。不要把 token 放进命令行或聊天。

::: warning Codex CLI 升级提示
TUI 启动时可能出现 `Update available`，且默认高亮立即升级。共享宿主上请选“跳过/稍后”，把 Codex CLI 升级安排到维护窗口；全局升级二进制可能同时影响这台机器上的所有共存节点。
:::

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
- [Grok 人机共存 TUI](/guide/grok-copresence)

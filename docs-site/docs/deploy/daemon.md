# 让 Hub 常驻：进程守护

生产 Hub 需要进程守护；裸跑 `nohup ... &` 在崩溃、重启或误杀后不会自动恢复。

::: tip 你要找的是哪个 daemon？这一页有两件事
「daemon」在本项目里指两件**不同**的事，名字撞了 —— 先认领你的那件：

| 你想做的 | 去哪 |
|---|---|
| **体验 `anet daemon`** —— 起一个能被 Dashboard 远程指挥、代你创建/管理其它节点的 `host_supervisor` 节点（RFC-026） | ⬇️ 下一节[「5 分钟体验 `anet daemon`」](#try-anet-daemon) |
| **让 Hub 崩了能自己起来** —— 用 PM2 / systemd 守护 `anet hub start` 进程 | ⬇️ [「先决条件」](#hub-prereqs)往下的全部内容 |

两者互不依赖，可以只做其中一件。
:::

## 5 分钟体验 `anet daemon` {#try-anet-daemon}

> 🔴 **本节每条命令都在干净的 `node:22-bookworm-slim` 容器里实跑过**（2026-08-27），
> 下面贴的都是真实输出，不是示意。实测版本：`anet v2.3.0-preview.47` +
> `agent-node v2.5.0-preview.34` + `commhub-server v0.9.0-preview.30`。

### 0. 装（`bun` 不能省）

```bash
npm i -g bun @sleep2agi/agent-network @sleep2agi/agent-node
```

🔴 **`bun` 是硬前提**，不是可选项。少了它第一条命令就会停在：

```
❌ anet hub start requires the Bun runtime
   (commhub-server is bun-only — uses Bun.serve + bun:sqlite, no Node fallback)
```

🔴 **版本：直接裸装即可，不用手写版本号。** `latest` 现在已经带 `anet daemon`
（实测 `2.3.0-preview.47`）。装完用 `anet -v` 核一眼；若你的版本敲 `anet daemon`
得到 `Unknown command`，说明它早于 daemon 进入通道的那一版 —— 见下面的
[版本对照](#which-versions)。

### 1. 起 Hub

```bash
anet hub start
```

它会打印一段横幅，**里面有随机生成的管理员密码，只显示这一次**：

```
  ✅ Server running on http://127.0.0.1:9200 (commhub-server v0.9.0-preview.30)
  ✅ Admin account created
     username: admin
     password: anet-90ddcdbe2b3f4f81a66ff5      ← 你的会不一样，当场复制
     Store this password now; it will not be shown again.
```

🔴 横幅里那串密码**每台机器都不同**（随机 bootstrap 密码，自 `2.2.22-preview.4` 起）。
别照抄本文的，用你自己那次输出里的。

### 2. 登录

横幅下面直接给了拼好的命令，照抄即可：

```bash
anet login --hub http://127.0.0.1:9200 --username admin --password <横幅里那串>
```

```
✅ Logged in as admin
⚠ Your password is the BOOTSTRAP DEFAULT and must be changed.
   Change it now:  anet passwd
   network: admin
   token saved to ~/.anet/config.json
```

🔴 **顺序不能反**：没登录就跑 `anet daemon up`，会停在
`未登录或缺少 network_id。请运行: anet login`（退出码 1）。

### 3. 起 daemon —— 一条命令

```bash
anet daemon up
```

真实输出：

```
[anet daemon] ✓ created host_supervisor daemon "daemon"
              config:     .anet/nodes/daemon/config.json
              node_id:    node_daemon_8d94ac332abb

[anet daemon] ⚠ Permission posture:
              flags.dangerouslySkipPermissions = true  (no per-call confirmation)
              flags.teammateMode = true
              role = host_supervisor                   (can fork child agent-nodes via hub)
              → Run daemons only on machines you trust to act on your behalf.

[anet] Starting new session for "daemon" [claude-agent-sdk]...
[daemon] 已注册到 CommHub
[daemon] SSE connected
```

🔴 **`anet daemon up` 会一直占着这个终端**（daemon 是常驻进程）。
要放后台见下面一节 [让 daemon 在后台活下去](#keep-daemon-alive)。

⚠️ 注意那段 **Permission posture**：daemon 默认带
`dangerouslySkipPermissions` + `teammateMode`，并且能通过 hub 派生子节点。
**只在你信得过的机器上跑它。** 要收紧就改 `.anet/nodes/daemon/config.json`。

::: info daemon 是**纯程序**守护节点，不是会聊天的 agent
`host_supervisor` daemon 的职责是**确定性的节点生命周期**——创建 / 停止 / 重启 / 删除 / 探测
其它节点，全部由 Hub 下发的结构化门铃驱动（RFC-026/027/028）。它是一个纯程序执行器，
**不会用大模型去理解你发给它的自由文本任务**。启动横幅里的 `[claude-agent-sdk]` 只是它的
默认 runtime 标签，daemon 处理生命周期命令时并不加载大模型。

所以：**要 AI 干活，请把任务发给一个真正的 agent 节点**，而不是 daemon。把自然语言任务
（`commhub_send_task` 一段话）发给 daemon 只会让它回你「我是程序节点，请用结构化命令」。
:::

### 3.5 让 daemon 在后台活下去 {#keep-daemon-alive}

`anet daemon start` 是前台常驻进程。**如果你是 SSH 上去起的，会话一断它就没了** ——
下面三条是 2026-08-27 在三台真机上逐台踩通的（每条都用「断开会话后再查 hub 心跳」验过，
不是靠启动横幅判断）。

**Linux / macOS —— `nohup` 起，验心跳**

```bash
cd ~                       # daemon 配置是 cwd 相关的，起在 init 时的同一个目录
nohup anet daemon start <name> > ~/daemon-<name>.log 2>&1 &
sleep 25 && tail -5 ~/daemon-<name>.log      # 看到「已注册到 CommHub」+「SSE connected」
```
断开 SSH 后隔 3 分钟以上再查 hub 的 `last_seen_at`：**还在刷新才算真常驻**。
要崩溃自动拉起，用本页下半部分的 PM2 方案（把 `anet daemon start <name>` 当作被守护的命令）。

**Windows —— 不能用 PowerShell Job**

```powershell
# ✗ Start-Job：SSH 会话结束时连同 Job 一起被回收，daemon 静默消失
# ✓ WMI 创建进程：脱离会话树
Invoke-CimMethod -ClassName Win32_Process -MethodName Create `
  -Arguments @{ CommandLine = "C:\Users\<you>\start-daemon.bat" }
```
`start-daemon.bat` 内容（**用 .bat 包装，别把长命令行直接塞给 WMI**——带引号和
重定向的长命令行会返回 `ReturnValue=21`「参数非法」）：
```bat
@echo off
cd /d C:\Users\<you>
anet daemon start <name> >> C:\Users\<you>\daemon-<name>.log 2>&1
```

🔴 **两个真踩过的坑**：

1. **cwd 决定 daemon 找不找得到自己**。`anet daemon init` 把配置写在**当时的工作目录**下的
   `.anet/nodes/<name>/`。用后台方式启动时如果工作目录变了，会报
   `Daemon "<name>" not found. Create it first:` —— 配置其实在，只是没在那儿找。
   所以后台命令里要显式 `cd` 回 init 时的目录。
   （Windows 上尤其容易中：SSH 登录的 cwd 可能不是 `C:\Users\<用户名>` ——
   用户名和 profile 目录名不一定同名。）
2. **别拿启动输出当就绪判据**。判据是 hub 侧：`anet daemon list` 只读本机配置、
   列出来不等于 hub 认得它；要看 hub 的节点状态里 `last_seen_at` 在持续刷新。

### 3.6 让 daemon 能真的创建节点：`ANET_BIN` 自动钉死 {#anet-bin-pin}

daemon 收到 `create_node` 后必须 fork 当前安装的 `anet`。为了防止 `PATH` 劫持,
runtime 仍然只接受一个通过校验的绝对路径；但现在 `anet daemon init` / `start` / `up`
会自动做这件事,不再要求用户手工 `readlink -f`、`chmod`、设环境变量。

启动 daemon 时会自动:

1. 把当前 `anet` 启动器 `realpath` 成实体文件,并注入 `ANET_BIN_ABS`。
2. 分开诊断未解析、非绝对路径、symlink 路径、组/其他用户可写、不可执行等问题。
3. 对 `umask 0002` 下 npm 常见的 `775` / group-writable 安装拒绝启动,并打印可直接执行的 `chmod go-w` 命令。
4. 默认接受 nvm/homebrew/npm 的非 root 用户安装,因为那就是用户自己的二进制。
5. 在 Windows 上直接拒绝 daemon 模式,避免 POSIX-only 路径和权限检查等到创建节点时才失败。

预期路径就是:

```bash
npm i -g @sleep2agi/agent-network @sleep2agi/agent-node
anet login
anet daemon up
```

`anet` 路径有两个来源,信任级别不同:

| 来源 | 用途 |
|---|---|
| `/etc/anet-daemon/path.conf` | 生产信任根；存在时优先于环境变量 |
| `ANET_BIN_ABS` 环境变量 | Docker、开发机或手工运维的便利通道 |

`ANET_BIN_ABS` 只有在 `ANET_DAEMON_ALLOW_ENV_BIN=1` 时才会被 runtime 接受。
`anet daemon init` / `start` / `up` 会自己设置这个声明,所以上面的 quickstart
不需要你手工加环境变量；只有绕过 `anet daemon`、直接拼 daemon 启动命令时才需要自己声明。

如果安全检查失败,CLI 会打印一行可直接照敲的修复命令;不要手工编辑未入库的服务器
启动文件来绕过它。

**判据**：从 hub 发一次 `create_node`,daemon 日志应出现
`[create-node] spawned child '<name>' pid=…` 和 `+5000ms capability check OK`,
且新节点自己注册回 hub。**看不到这两行就是没配对**——它不会重试。

**已经在跑的 daemon 没配对怎么办 —— 先试不需要 root 的那条。**
只有 `anet daemon init` / `start` / `up` 会自动声明 pin（它们内部调用
`prepareDaemonAnetBin()`）。用 `anet node start`、pm2、systemd 或手工拼命令起的
daemon **永远拿不到**，而它照样注册、在线、心跳正常 —— 失败只在建节点那一刻出现。

```bash
anet node stop <name> && anet daemon start <name>    # 不需要 root
```

这条不保证成功（binary 若 group/other 可写、不可执行，或不是 anet 包的 bin，
`anet daemon start` 会自己拒绝并告诉你原因），但它成本低得多，**值得在动 sudo 之前先试**。
仍然不行再写 `/etc/anet-daemon/path.conf`（生产信任根，见上表）。


### 4. 确认它**进程**起来了

```bash
anet daemon list
```

```
Local host_supervisor daemons (1):
  daemon   node_id=node_daemon_8d94ac332abb  runtimes=[claude-agent-sdk,codex-sdk,grok-build-acp]
```

Hub 那一侧每 3 分钟能看到它的心跳：

```
[08:36:00] SSE ← net_b84e736f347c:daemon connected (1 clients)
[08:39:01] daemon (sdk-node) → report_status: idle [net]
[08:42:01] daemon (sdk-node) → report_status: idle [net]
```

**`anet daemon list` 现在会替你问 hub「这台 daemon 到底能不能建节点」**，
每台后面多一行 `创建能力:…`。五种情况说五句不同的话，别把它们当成同一件事：

```
创建能力:可用(5s 前测)
创建能力:**不可用**(anet_bin_permission,5s 前测)
  原因:该二进制 group/other 可写。一行就能修
  修法(可整行粘贴):chmod go-w "$(command -v anet)"
创建能力:可用,但**不知道是什么时候测的** —— 该 daemon 版本在开机时算一次就不再重测。重启它、或升级。
创建能力:未知 —— 这台 daemon 没报过这一格(agent-node 版本早于 preview.55)。升级它才能看到。
创建能力:查不到 —— hub 上没有这个 node_id(还没注册过，或注册到了别的网络)
```

🔴 **「没报过」和「不可用」不是一回事。** 前者说的是*这台机器的 agent-node 太旧、
它没告诉我们*，后者说的是*它告诉我们了，答案是不行*。
把前者当成后者，你会去修一台其实好好的机器。

🔴 **年龄那一格不是装饰。** 一个「5s 前测」的 `不可用` 和一个「三周前测」的 `不可用`
是两件事 —— 后者很可能早就被修好了，只是那台 daemon 用的老版本在开机时算过一次就再没重测。
所以显示的是「多久以前测的」，不是「现在的状态」。

（hub 完全连不上时这条命令**不会失败** —— 本机清单本来就不需要网络，
而「看不到能力」和「没有 daemon」是两件事。）

**仍然需要下一节的验收判据吗？** 需要，但用途变窄了：`创建能力:可用` 说的是
**pin 解析这一关过了**；下一节那个真发一次 `create_node` 的判据，验的是整条链
（doorbell 到达、子进程起来、新节点注册回 hub）。

### 5. 从 Dashboard 远程操作它

daemon 起来并连上 hub 之后，打开 Dashboard：

```bash
anet hub dashboard        # 默认 http://localhost:3000
```

在节点列表里能看到 `daemon`（`role=host_supervisor`）。
它与普通节点的区别是：**可以代你在这台机器上创建和启动别的节点** ——
这正是「远程建节点」这条路径的落点，不必再 ssh 上机器敲 `anet node create`。

::: danger 🔴 第一次创建节点：`ok:true` **不是**成功判据
走到这一步时，所有你看得见的信号都会告诉你"成了"：daemon 在线、心跳正常、
Dashboard 把它列进「选服务器」、点下去 `create_node` 返回 **`ok:true` + request_id**。

**而节点可能根本没被创建**，失败只写在 **daemon 那台机器的本机日志**里
（hub 不知情，Dashboard 也不会变红）。**不知道要去看那份日志的人，会卡在这里。**

**所以第一次创建，请按日志验收，别按界面验收**：

```bash
# 在跑 daemon 的那台机器上
tail -f ~/daemon-<name>.log        # 或你启动时重定向到的那个文件
```

| 看到 | 含义 |
|---|---|
| `[create-node] spawned child '<name>' pid=…`<br>`+5000ms capability check OK` | ✅ 真的创建了，新节点会自己注册回 hub |
| `[create-node] anet_bin_unsafe_path: …` | ❌ `ANET_BIN` 没配对 → [3.6 节](#anet-bin-pin)。**它不会重试** |
| 什么都没有 | ❌ doorbell 没到，检查 daemon 是否真的连着 hub（§4） |

⚠️ **Windows 上这一步目前必失败**，且症状同样具有欺骗性（注册、心跳、`ok:true` 全正常）——
见 [3.6 节末尾](#anet-bin-pin) 与 [#1290](https://github.com/sleep2agi/agent-network/issues/1290)。
在 #1290 修好之前，Windows 机器可以跑 daemon，但**不要指望它 fork 出子节点**。
:::

---


::: warning 只允许一个守护者
PM2、systemd、cron 看门狗不能同时管理同一个 Hub。多个守护者可能拉起两个进程，
让它们争用同一个端口和 SQLite 数据库。
:::

## 先决条件(按顺序,每一道都会挡住你) {#hub-prereqs}

在干净机器上实测出来的完整链条。三道门都是 fail-closed 且报错可执行,
但文档此前没把它们连起来写,只能一次撞一个:

| 顺序 | 缺了会看到 | 怎么办 |
|---|---|---|
| 1. **Bun ≥ 1.2** | `❌ anet hub start requires the Bun runtime (commhub-server is bun-only — uses Bun.serve + bun:sqlite, no Node fallback)` | `npm i -g bun` 或 `curl -fsSL https://bun.sh/install \| bash`,然后**重开 shell** 让 PATH 生效 |
| 2. **Hub 在跑** | `未找到 CommHub Server。请先运行: anet hub start` | `anet hub start`(约 3 秒起来) |
| 3. **已登录且有 network_id** | `未登录或缺少 network_id。请运行: anet login` | `anet register` 建账号,或 `anet login` |

::: warning `anet daemon` 和本页下半部分说的「守护」不是一回事
本页**下半部分**讲的是**用 PM2 守护 `anet hub start`**（让 Hub 常驻）。

而 `anet daemon init` / `up` 是**另一件事** —— 创建并启动一个
`host_supervisor` 节点（RFC-026）。两者名字相近、做的事不同，
体验步骤见上面的[「5 分钟体验 `anet daemon`」](#try-anet-daemon)。
:::

### `anet daemon` 在哪些版本上存在 {#which-versions}

🔴 **这一格曾经写反过**，因为它被钉在了一个会漂的数字上：原文写
「`anet daemon` 只在 `preview` 通道上存在，`latest` 会报 `Unknown command`」——
那是 2026-08-18 对当时的 `latest`（`2.2.21`）量出来的，**今天两个前提都不成立了**。

所以这里不写「哪个通道有」，只写**怎么自己判**：

```bash
anet -v                 # 你装的是哪一版
anet daemon             # 有：打印 Usage: anet daemon <subcommand> …
                        # 无：Unknown command "daemon". Did you mean: anet demo?（退出码 1）
```

| 版本 | `anet daemon` | 依据 |
|---|---|---|
| `2.2.21` | ❌ `Unknown command "daemon"` | 2026-08-18 实测（当时的 `latest`） |
| `2.3.0-preview.39` | ✅ `Usage: anet daemon <subcommand> …` | 2026-08-18 实测（当时的 `preview`） |
| `2.3.0-preview.47` | ✅ `Usage: anet daemon <subcommand> …` | 2026-08-27 实测，**且它就是当天的 `latest`** |

⇒ **结论按下界写，不按通道写**：`2.3.0-preview.39` 及以后都有；`2.2.21` 没有。
上表是**实测过的点**，不是完整边界 —— `.39` 与 `2.2.21` 之间的具体那一版没有逐个量。
**别把「`latest` 有没有」写进文档**：`latest` 指向哪一版会变（2026-08-27 当天它已经是
`2.3.0-preview.47`），把结论钉在通道上，几天后就要再改一次。

## 推荐入口

守护 `anet hub start`，不要在配置里钉死 `commhub-server` 的 preview 版本。
`anet` 会选择与当前 CLI 配套的 Server 版本。

先取得真实路径：

```bash
command -v anet
command -v bun
```

::: warning 不要用 `bunx` / `npx` 当守护入口
`bunx` / `npx` 会把包解到 `/tmp` 下的缓存目录并**从那里执行**。机器重启后 `/tmp` 被清空，
守护进程就再也起不来，而 PM2 只显示反复重启、看不出根因。始终用 `command -v` 取到的**绝对路径**。
:::

下面以 PM2 为例。把 `script` 换成 `command -v anet` 返回的绝对路径：

```js
// hub.ecosystem.config.js
module.exports = {
  apps: [{
    name: 'commhub-hub',
    script: '/absolute/path/to/anet',
    args: 'hub start',
    interpreter: 'none',
    env: { HOST: '127.0.0.1', PORT: '9200' },
    autorestart: true,
    // min_uptime 必须大于「进程失败退出所需时间」。若小于它，PM2 会认为
    // 这次启动成功、不计入失败，backoff 永不触发 —— 崩溃循环看起来像正常重启。
    min_uptime: 45000,
    // 只配 backoff、不配 max_restarts = 失败进程无限重试。这里是有意的：
    // Hub 应持续自愈；代价是坏掉的进程会一直重试并刷日志。需要上限就自行加 max_restarts。
    exp_backoff_restart_delay: 200,
    kill_timeout: 10000,
    max_memory_restart: '2G',
  }],
};
```

文件名要让 PM2 认出这是**配置**而不是**脚本**：`*.config.js`、`*.config.cjs`、
`*.json`、`*.yaml` 都可以（本仓 `deploy/` 下用的就是 `ecosystem.config.cjs`）。
若文件名不匹配这些形态，PM2 会把它当普通脚本执行，界面可能显示 `online`，
但 Hub 根本没有监听。

启动并核验：

```bash
pm2 start hub.ecosystem.config.js --only commhub-hub
pm2 status commhub-hub
curl -fsS http://127.0.0.1:9200/health
```

不要只看 PM2 的绿色状态；`/health` 才证明服务真的响应。

## 本仓的权威配置在 `deploy/`

上面的示例是通用起点。本仓生产环境实际在用的那一份已经在仓里，不需要照着手抄：

- [`deploy/hub/ecosystem.config.cjs`](https://github.com/sleep2agi/agent-network/blob/main/deploy/hub/ecosystem.config.cjs) — Hub 的 PM2 进程定义（不含密钥）
- [`deploy/hub/hub-daemon.sh`](https://github.com/sleep2agi/agent-network/blob/main/deploy/hub/hub-daemon.sh) — 被守护的启动脚本，四道 fail-closed 预检（bun / 固化安装 / vault 密钥 / 端口占用）
- [`deploy/fleet/`](https://github.com/sleep2agi/agent-network/blob/main/deploy/fleet) — 开机自启的 systemd **user** unit 与军团启动链
- [`deploy/hub/README.md`](https://github.com/sleep2agi/agent-network/blob/main/deploy/hub/README.md) — Hub 换版本流程（已演练）

生产机 `~/.local/bin/` 下的是**部署副本**，Git 权威在 `deploy/`。两边要一起改，
漂移用 [`deploy/check-deployed-copies.sh`](https://github.com/sleep2agi/agent-network/blob/main/deploy/check-deployed-copies.sh) 检。

## `min_uptime` 按「失败退出耗时」定，不是按感觉定

规则：`min_uptime` 必须**大于**一次失败启动走到退出所需的时间。小于它，PM2 会把这次
失败当成「启动成功」——`max_restarts` 不累加、`exp_backoff_restart_delay` 不触发，
于是崩溃循环看起来就是正常重启。

**怎么算这个时间**：看被守护脚本失败路径上的固定延时。`hub-daemon.sh` 的预检失败走
`fail_slow()`，它 `sleep 30` 之后 `exit 1`，所以失败退出耗时约 30 秒 ⇒ 守它的
`min_uptime` 必须大于 `30000`。守裸 `anet hub start` 时失败退出通常快得多，
所以本页示例用的 `45000` 对两种入口都够。

实测（`node:22-bookworm-slim` 容器里的 PM2，同一个「30 秒后失败退出」的脚本，
观察 100 秒约 3 个周期）：

| `min_uptime` | `restarts` | `unstable restarts` |
|---|---|---|
| `20000` | 3 | **0** ← 退避从不触发 |
| `45000` | 3 | 3 |

`unstable restarts` 停在 0，就是这道保护已经失效的读数：PM2 认为每次都启动成功了。
所以核对守护配置时要看这个字段，不要只看 `restarts`。（本仓当前取值的复核见
[#1223](https://github.com/sleep2agi/agent-network/issues/1223)。）

## 安全边界

- 默认保持 `HOST=127.0.0.1`。公网或局域网部署先完成[生产安全配置](/deploy/production)。
- 生产环境不要使用 `--dev-open`。
- 不要把 token 或 vault key 写进 ecosystem 文件；PM2 会持久化环境变量。
- 不用 `pkill -f` 或 `killall` 清理进程。先取得精确 PID，再停止目标进程。
- 启动失败时保留退避，避免缺依赖或 registry 故障造成高频重启。

如果必须传入敏感环境变量，把它放进权限为 `600` 的独立文件，由一个最小启动脚本
读取；验证日志、PM2 dump 和配置中都没有该值。不要使用
`export $(grep ...)`，匹配为空时它可能打印整个环境。

## 验证自动恢复

在维护窗口内测试一次，而不是等真正故障时才发现守护无效：

1. 用 `pm2 pid commhub-hub` 记录精确 PID。
2. 对这个 PID 发送 `SIGTERM`，不要使用名称匹配批量 kill。
3. 再次检查 `/health` 返回 200。
4. 确认 PID 已变化。

四项缺一不可：旧 PID 没变化，只能证明进程没有退出；新 PID 存在但 `/health`
失败，只能证明 PM2 拉起了一个坏进程。

## 开机自启

```bash
pm2 startup
```

该命令只会打印需要以 root 执行的 systemd 命令。按提示执行后，确认 Hub 健康，
最后再保存：

```bash
pm2 save
ls /etc/systemd/system/pm2-*.service
```

只运行 `loginctl enable-linger` 不会创建 PM2 的 systemd unit。

## 更新配置

先验证新配置，再替换旧配置；不要先 `pm2 delete` 再尝试未知参数。

```bash
pm2 startOrReload hub.ecosystem.config.js --only commhub-hub
curl -fsS http://127.0.0.1:9200/health
```

已有 cron 看门狗时，应先禁用它，再交给 PM2。守护权不明确时停止操作，先确认
哪个进程管理器拥有 Hub。

## 相关

- [生产部署 / 公网部署安全](/deploy/production)
- [升级指南](/guide/upgrade)
- [故障排查](/troubleshooting)
- [`deploy/` — 本仓部署资产的 Git 权威](https://github.com/sleep2agi/agent-network/blob/main/deploy)
- [daemon ↔ hub 生命周期请求的可靠性模型](https://github.com/sleep2agi/agent-network/blob/main/docs/daemon-lifecycle-reliability.md) —— 开发者向:门铃为什么会丢、重连补偿怎么补、三个 stuck-state 各自的收敛路径

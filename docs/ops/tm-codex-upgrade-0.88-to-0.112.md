# codex-app-server 节点升级指南:agent-node 2.5.0-preview.88 → 2.5.0-preview.112

> 读者:一个跑着**几十个 codex-app-server 节点**的团队的节点负责人。
> 本文由项目方根据 Hub 上的只读数据和 Docker 演练写成;**项目方没有、也不会去碰你们的节点**,
> 每一步都由你自己执行。名字、主机、端口一律是占位符:`<主机>`、`<ws>`(工作区目录)、`<别名>`、`<端口>`。
> 演练脚本:[`tests/test-tm-codex-upgrade-rehearsal/`](../../tests/test-tm-codex-upgrade-rehearsal/run.sh)(Docker,约 12 分钟)。

## 1. 为什么升

最近 3 天 Hub 上这批节点的失败,按成因分三类:

| 失败 | 次数 | 升级能不能解决 |
|---|---|---|
| `Cannot connect to codex app-server at ws://… — is it running?` | 355(9 个节点) | **看启动方式**,见下表 |
| refresh token 已被使用 / 已在别处登出 | 61 | **不能**。是多节点共用一份 `auth.json`(#1918),见 §6 |
| OpenAI 侧(安全拦截 / 容量不足) | 53 | **不能**。不是节点的问题,换模型或稍后重试 |

`Cannot connect…` 的意思是:节点进程活着、Hub 上显示 idle,但它背后的 `codex app-server` 已经没了
(或卡死)。在 .88 上节点**照样接任务**,每个任务不到 1 秒就以这条错误失败 —— 所以一个节点能攒出几十上百条。

.112 带来的(首次进入的版本由 git 发版提交确认):

| 能力 | PR | 首个包含它的版本 |
|---|---|---|
| 分层健康上报(`health.bridge / app_server / model_auth`)随心跳到 Hub | #2230 | agent-node 2.5.0-preview.94 |
| App Server 看门狗:app-server 死了 → 按原会话重拉(自有拓扑 = 重新 spawn) | #2243 | agent-node **2.5.0-preview.95** |
| 卡死(进程活、端口在、不应答)→ 核对身份后杀掉重拉(仅共存节点) | #2249 | agent-node 2.5.0-preview.96 |
| Hub 对降级节点**拒派**(`409 node_degraded`),不再让任务进来白白失败 | #2238(Hub) | commhub-server 0.9.0-preview.102 已包含(生产 Hub 即此版本;Hub 快照里 .96 节点的 `health` 已能透传) |

## 2. 先确认你的节点是怎么起的(决定怎么升、升了能得到什么)

Hub 只读数据能看到的:36 个节点全部是 `runtime=codex-app-server`,配置都在
`<ws>/.anet/nodes/<别名>/config.json`,`tmux_name` 全空(agent-node 本来就不报这一格,**不能**据此判断有没有 tmux),
版本混着 7 种(25× .88、6× .33、.58/.68/.71/.87/.96 各 1),其中 19 个 .88 节点在约 40 分钟内先后拉起(进程都已运行约 247 小时),像是一次批量重启。
2026-09-19 你们自己的 `ps` 清点(见 `agent-node/src/codex-auth-fingerprint.ts` 头注释)是:35 台里 **4 台**用 `anet node start` 起,
**31 台**由自定义脚本直接起 `node …/agent-node/dist/cli.js --config …`,旁边各跑一个裸的 `codex app-server --listen ws://…`。

在 `<主机>` 上用下面三条把每个节点归类(只读):

```bash
ps -eo pid,etimes,args | grep -E 'agent-node|anet node start' | grep -v grep   # 节点进程怎么起的
ps -eo pid,etimes,args | grep 'codex app-server' | grep -v grep                # app-server 是谁起的
jq '{codexAppServerUrl, codexCopresence, codexHome}' <ws>/.anet/nodes/<别名>/config.json
```

| 归类 | 判据 | 下文叫 |
|---|---|---|
| A. 脚本 + 裸 app-server(多数) | 进程是 `agent-node --config …`;config 里**有** `codexAppServerUrl`;旁边有一个 `codex app-server --listen <同一个 url>` | **脚本式** |
| B. anet 无头 | 进程是 `anet node start <别名>` 拉起的;config **没有** `codexAppServerUrl`;app-server 带 `-c mcp_servers.commhub…`、端口随机,是节点自己 spawn 的 | **anet 式** |
| C. anet 共存(有人用 TUI) | config 里 `codexCopresence: true`;tmux 里有 `<别名>`、`<别名>-appsrv`、`<别名>-桥` 三个会话 | **共存式** |

🔴 **版本跟着「谁起的」走,不跟着全局包走**:`anet node start` 起 codex-app-server 节点时,只用与这个 anet **精确配对**的 agent-node
(经 `npx` 解析,PATH 上的全局 `agent-node` 被刻意忽略)。演练实测:全局 agent-node 已是 .112,用 anet 2.3.0-preview.115 起的节点仍是 .88。
所以 **anet 式/共存式要升 anet,脚本式要升 agent-node**。配对关系:anet `2.3.0-preview.115` ↔ agent-node `2.5.0-preview.88`;
anet `2.3.0-preview.145` ↔ agent-node `2.5.0-preview.112`。

## 3. 升级后能得到什么(演练结果,假 codex,两种启动方式各跑一遍)

| 场景 | 脚本式 .88 | 脚本式 .112 | anet 式 .88 | anet 式 .112 |
|---|---|---|---|---|
| app-server 被 `kill -9` | 每个任务 <1s 失败:`Cannot connect … ws://127.0.0.1:<端口> — is it running?` | **Hub 拒派**(`409 node_degraded`),原因写明;看门狗重试 3 次后放弃;**不会替你重拉**(app-server 不是它起的) | 下一个任务自动重新 spawn,成功(.88 已有) | 看门狗约 1s 内重拉;Hub 拒派约 1.3s 后重新放行,任务成功 |
| 人手重拉 app-server 后 | 下一个任务成功 | 约 2–3s 内探测到「又能应答了」,自动解除降级 | — | — |
| app-server 卡死(`SIGSTOP`) | 每个任务 30s 超时失败,一直如此 | 第 1 个任务 30s 超时;之后 Hub 拒派,直到你处理 | 每个任务 30s 超时失败,一直如此 | 第 1 个任务 30s 超时;看门狗另起一个 app-server,第 2 个任务成功 ⚠️ 旧的卡死进程**没被杀**(只有共存式会杀) |
| app-server 每次启动都崩(连崩) | — | — | 每个任务等约 19s 后失败(`WS never came up`) | Hub 拒派;重试 3 次后放弃并**保持降级**,原因写「restart the node by hand」;修好根因后**要重启节点**才恢复 |

结论:

- **anet 式**:升级直接解决「死了」和「卡死」两类(卡死会留一个停住的旧进程,需要定期清)。
- **脚本式**:升级**不会**自动拉起裸 app-server。它把「接了任务再秒失败」变成「Hub 直接拒派 + 原因可见 + 人手修好后自动恢复」——
  任务不再白白烧掉,但 app-server 仍要有人(或你的脚本)拉起。要根治,二选一:
  1. **让节点自己持有 app-server**(推荐,前提是这个 app-server **没有人用 TUI 连着**):删掉 config 里的 `codexAppServerUrl`,停掉那个裸 app-server,
     用同一条 `agent-node --config …` 命令重启。演练实测:之后 `kill -9` app-server,下一个任务照常成功;线程按 config 里的 `codexThreadId` 续上。
  2. 保留脚本式,但给裸 app-server 加进程守护(systemd `Restart=always` 或循环拉起),端口和 `CODEX_HOME` 保持不变。
- **共存式**:#2243/#2249 的重拉和杀卡死都只在这种方式下全开(按启动快照在原 tmux 会话里重拉),由 CI 套件 `tests/test-codex-appserver-watchdog` 覆盖。

## 4. 前置条件

- Hub 侧无需你做任何事(健康透传与拒派已在生产 Hub 上)。
- `<主机>` 能访问 npm registry;Node ≥ 18.17。
- 节点的 `HOME` / npm 全局前缀 / npx 缓存**不在**任何人可写的目录下(例如 `/tmp`):anet 会逐级校验配对包的属主和权限,
  不安全就拒绝启动(`resolved agent-node package has unsafe ownership or mode`)。npm 前缀若是 umask 0002 装的,先 `chmod -R go-w <前缀>`。
- 先挑 **1 个**非关键节点做金丝雀,确认 §7 的检查都过,再分批(每批 ≤5 个,批间看 10 分钟)。
- 重启会中断该节点正在跑的任务:先在 Dashboard 看它是 idle。

## 5. 升级步骤

### 5.1 脚本式(`agent-node --config …` + 裸 app-server)

```bash
# 1) 记下当前命令行,回滚和重启都用它
ps -o args= -p <节点pid>  > ~/upgrade-<别名>.cmdline
# 2) 升级脚本实际调用的那一份 agent-node(看 cmdline 里的路径;全局安装就是下面这条)
npm i -g @sleep2agi/agent-node@2.5.0-preview.112        # 自定义前缀:npm i --prefix <前缀> …
agent-node --version                                     # 应为 2.5.0-preview.112
# 3) 只重启节点进程,裸 app-server 不用动
kill <节点pid>
cd <ws> && <原来的启动命令>                              # 例:agent-node --config <ws>/.anet/nodes/<别名>/config.json --alias <别名>
```

演练耗时:安装约 12s,节点重启到 Hub 显示 idle 不到 1s。如果脚本里写死了某个旧路径下的 `dist/cli.js`,改那个路径对应的安装,而不是全局。

(可选,根治)改成节点自持 app-server:

```bash
cp <ws>/.anet/nodes/<别名>/config.json{,.bak}
jq 'del(.codexAppServerUrl)' <ws>/.anet/nodes/<别名>/config.json.bak > <ws>/.anet/nodes/<别名>/config.json
kill <节点pid> <裸app-server pid>
cd <ws> && <原来的启动命令>
```

### 5.2 anet 式(`anet node start`)

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.145   # 升 anet;它会自己用配对的 agent-node 2.5.0-preview.112
anet --version                                         # 2.3.0-preview.145
cd <ws> && anet node stop <别名> && anet node start <别名>   # 原来用 --tmux 起的,这里也带 --tmux
```

`anet node start` 默认在前台运行(关掉终端节点就停);原来怎么包的(tmux / nohup / systemd)就照原样包。
第一次启动会经 npx 拉配对包,演练里约 15–25s,之后约 2s。

### 5.3 共存式(`anet node start --copresence`)

同 5.2 升 anet,然后在 `<ws>` 里 `anet node stop <别名>` 再 `anet node start <别名>`(共存是记在 config 里的,不用再带 `--copresence`)。
**不要**在节点自己的 TUI 窗格里执行重启。

### 5.4 批量重启:分批做,中间看内存和负载(#612)

2026-10-06 有一次实测事故:一台 16 核 / 62.6 GB 的主机上,7 分钟内先后重启了 14 个 codex-app-server 节点,
1 分钟负载冲到 146–325、可用内存只剩 0.2–0.5 GB,整机卡死,34 个节点掉线。每个 app-server 启动都是一次内存和 CPU 的突发,叠在一起就会压垮主机。

**分批建议**(三种启动方式都适用):

- 每批 **≤3 个节点**;
- 每批之间在 `<主机>` 上跑 `free -g; uptime`;
- 只有 **available ≥ 10 GB 且 1 分钟负载 < CPU 核数**(`nproc`)时才继续下一批,否则等。

**启动前资源闸**(agent-node 内置,#612 第 1 步;首个包含它的版本以发版说明为准,.112 **没有**):
节点自己 spawn app-server 之前(即 **anet 式**,自有拓扑)先读 `/proc/meminfo` 的 `MemAvailable` 和 `/proc/loadavg` 的 1 分钟负载。
不满足条件就打一行日志(`[start-gate] codex app-server: waiting before start: …`,带实测值和原因),每约 15 秒(加随机抖动)重查一次;
等满上限仍不满足,就打一行警告照常启动 —— 节点不会因为这道闸一直起不来。

| 环境变量 | 默认 | 含义 |
|---|---|---|
| `ANET_START_MEM_GATE` | 开 | 设为 `0` 关闭 |
| `ANET_START_MIN_MEM_MB` | `4096` | `MemAvailable` 低于这个值(MiB)就等 |
| `ANET_START_MAX_LOAD_PER_CPU` | `2` | 1 分钟负载高于 `这个值 × CPU 核数` 就等 |
| `ANET_START_GATE_MAX_WAIT_SEC` | `600` | 最多等这么久,之后带警告照常启动 |

🔴 这道闸**只管节点自己 spawn 的 app-server**。**脚本式**(裸 `codex app-server` 由你们的脚本起、config 里有 `codexAppServerUrl`)
和**共存式**(app-server 在 `<别名>-appsrv` 会话里由 anet 起)的 app-server 不经过它 —— 这两种只能靠上面的分批做法。
非 Linux(没有 `/proc`)上这道闸不生效。

## 6. 升级不解决的:共用登录(#1918)和 OpenAI 侧拒绝

**共用登录**。codex 的 refresh token 是一次性的:N 个节点拿同一份 `auth.json`,谁先刷新谁活,其余节点几天后报
「refresh token 已被使用 / 在别处登出」。这和版本无关。建议**每个节点一份独立登录**:

```bash
# 节点专属 CODEX_HOME:<ws>/.anet/nodes/<别名>/codex-home(目录存在即生效;或在 config 里写绝对路径 "codexHome")
mkdir -p <ws>/.anet/nodes/<别名>/codex-home && chmod 700 <ws>/.anet/nodes/<别名>/codex-home
CODEX_HOME=<ws>/.anet/nodes/<别名>/codex-home codex login --device-auth   # 每个节点各登一次;或给不同节点用不同账号
```

不要把一个节点的 `auth.json` 复制给另一个节点 —— 复制正是共用的来源。脚本式节点的裸 app-server 也要用**同一个** `CODEX_HOME` 启动
(app-server 才是真正读登录的进程)。.112 启动时若发现同主机多节点同一登录,日志会打 `⚠ <别名> shares its codex login with: …`(附 #1918 的修法);
刷新被拒后 Hub 上该节点的 `health.model_auth` 会从 `ok` 变成 `revoked` / `expired`。
已经被踢的节点:在它自己的 `CODEX_HOME` 里重新登录,再**只重启 app-server**(节点会续上原线程),趁它 idle 时做。
本次演练用假 codex,**没有验证真实登录**;独立登录是否在你们的账号策略下互不踢出,请在金丝雀节点上观察 24 小时再铺开。

**OpenAI 侧**(安全拦截、`Selected model is at capacity`):不是节点故障,升级不改变。容量问题用 `anet node edit <别名> --model <别的模型>` 换模型后重启。

## 7. 升级后检查

1. Hub 上该节点 `version` = `2.5.0-preview.112`,且出现 `health` 字段(.88 没有这一格):

   ```bash
   curl -s <hub>/api/status -H "Authorization: Bearer $(jq -r .token ~/.anet/config.json)" \
     | jq '.sessions[] | select(.alias=="<别名>") | {version, status, degraded, health}'
   ```

   期望:`health.bridge="ok"`、`health.model_auth="ok"`(跑过第一个任务之前是 `unknown`),`degraded=null`。
   `health.app_server`:脚本式启动后即有(`ok:true` + `rtt_ms`);anet 式无头节点按需起 app-server,演练里这一格要到 app-server 出过一次状态变化才出现,缺这一格不算异常。
2. `anet node ls --all`:按主机列出你看得到的全部节点和状态。注意它**只显示状态列,不显示降级**;降级看第 1 条或 Dashboard。
3. 派一个小任务(「回复 OK」),看到真实回复才算通;`status=replied` 但正文是错误的不算。
4. 节点日志里能看到 `[health] app_server=ok …`;出事时会有 `[app-server-watchdog] restarting app-server (attempt k/3 …)`。
5. 若 `degraded` 的原因是 `auto-restart gave up …`:先修根因(内存 / 登录 / 二进制),再重启节点。
   脚本式在你手动拉起 app-server 后会自己恢复;anet 式要 `anet node stop` + `start`。
6. anet 式升级后,隔几天查一次有没有停住的旧 app-server:`ps -eo pid,stat,etimes,args | grep 'codex app-server' | awk '$2 ~ /T/'`。

本机内存:这台主机 62.6 GB 里可用约 1.8 GB,每个 app-server 是独立进程。app-server 被 OOM 杀掉就是「死了」那一行;
看门狗会重拉,但在内存不足时会连崩直至放弃 —— 那时要减节点数或加内存,而不是继续重启。

## 8. 回滚

装回原版本,用原方式重启;config 不需要改(演练实测:.112 跑过的 config 回到 .88 能直接接任务)。

```bash
# 脚本式
npm i -g @sleep2agi/agent-node@2.5.0-preview.88 && kill <节点pid> && cd <ws> && <原来的启动命令>
# anet 式 / 共存式
npm i -g @sleep2agi/agent-network@2.3.0-preview.115 && cd <ws> && anet node stop <别名> && anet node start <别名>
# 如果做了「节点自持 app-server」改造,先恢复 config 并重新拉起裸 app-server
cp <ws>/.anet/nodes/<别名>/config.json.bak <ws>/.anet/nodes/<别名>/config.json
```

## 9. 演练记录

- 环境:Docker(`node:22-slim` + bun),一次性 Hub(本仓 server,端口 19593),`HOME` 为临时目录,假 `codex`(只实现 app-server 的 JSON-RPC,不连 OpenAI)。
- 本次结果(节选):[`docs/tests/report-test-tm-codex-upgrade-rehearsal.txt`](../tests/report-test-tm-codex-upgrade-rehearsal.txt),`FAILS=0`,总耗时约 640s。
- 复现:`docker build -t tm593 -f tests/test-tm-codex-upgrade-rehearsal/Dockerfile . && docker run --rm tm593`,末行 `FAILS=0`。
- 关键日志行(脚本式 .88,原样):
  `codex-app-server 错误: Cannot connect to codex app-server at ws://127.0.0.1:27593 — is it running? (Received network error or non-101 status code.)`
- 关键日志行(脚本式 .112):
  `[app-server-watchdog] app-server auto-restart gave up: 3 restarts in 10 min (last: Cannot connect …)` →
  手动拉起后 `[app-server-watchdog] app-server is answering again (fixed by hand?) — watching again`
- 关键日志行(anet 式 .112):
  `[app-server-watchdog] restarting app-server (attempt 1/3 in 10 min): process exited …` →
  `[app-server-watchdog] bridge re-attached ws://127.0.0.1:<端口> thread=<线程>`
- 需求:看板 #593(父项 #583)。

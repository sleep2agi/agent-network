# GrokTUI 狗节点恢复与渐进授权

本文记录 `通信狗`、`A站狗` 与 `P站狗` 的非密钥软件坐标、启动方式、行为验收、回滚和授权边界。
宿主机上的安装目录与 tmux 会话只是部署副本；Git 中的 source commit 与本文才是
恢复依据。本文不授权批量升级、生产数据库操作或其它舰团节点变更。

## 当前已验状态（2026-08-13）

三个节点使用相同的冻结软件制品，但每个节点拥有独立 workspace、node config、node/session
identity、tmux 和 Grok attach socket：

| alias | node_id | session_id | workspace | tmux |
| --- | --- | --- | --- | --- |
| `通信狗` | `n_72be30e0` | `c47d3225-6d87-48a2-8c84-6c11db20a455` | `/home/vansin/grok-commdog-workspace` | `通信狗` |
| `A站狗` | `n_b2c53d33` | `0bff8e47-ead8-4628-bea7-74b58335785a` | `/home/vansin/grok-astation-dog-workspace` | `A站狗` |
| `P站狗` | `n_6fe8f9c0` | `f36fe2d9-166a-4b3e-b9c3-7ad065f60bc0` | `/home/vansin/grok-pstation-dog-workspace` | `P站狗` |

### Runtime 身份：TUI 共存，不是 ACP runtime

三个 config 的权威字段均为 `runtime="grok-build-cli"`、`grokCopresence=true`；它们不使用
Agent Network 的 `grok-build-acp` runtime，也不启动 `grok agent stdio`。实际进程链是
`agent-node → grok --leader → grok agent leader`，并通过 owner-only attach socket 把同一个
Grok TUI 暴露给 `anet grok attach`。`grok agent leader` 以及 Grok 日志中的内部 relay/ACP
事件名是 Grok CLI 的 TUI leader 实现细节，不能据此把节点误报成 `grok-build-acp`。

验真必须限定到目标 alias 的 config 与进程子树。不要用全舰队 `pgrep`/`grep` 搜索
`grok-build-acp`：宿主上其它历史节点会污染结果。最低核验形态为：

```bash
jq '{runtime, model, grokCopresence}' "$CONFIG_PATH"
pid="$(pgrep -af "agent-node.*--alias $ALIAS .*--runtime grok-build-cli" | awk 'NR==1{print $1}')"
test -n "$pid"
pstree -ap "$pid"
! pstree -ap "$pid" | grep -E 'grok-build-acp|grok agent stdio'
```

下面是三者共享的软件坐标；其中 alias、node/session、workspace 与 tmux 行仅是
`通信狗` 的首轮详细记录：

| 项 | 观测值 |
| --- | --- |
| alias | `通信狗` |
| runtime / model | `grok-build-cli` / `grok-4.5` |
| node / session | `n_72be30e0` / `c47d3225-6d87-48a2-8c84-6c11db20a455` |
| workspace | `/home/vansin/grok-commdog-workspace` |
| tmux | `通信狗` |
| source commit | `a7865a4316a17d38e4c8dfc4c2cebaceaba2c62c` |
| agent-network package | `2.3.0-preview.37`, tarball SHA-256 `56fdefbc14cba8de28f7bc037bc4d0911f7c79d16213152cc40167fa9ffe3743` |
| agent-node package | `2.5.0-preview.29`, tarball SHA-256 `6e4e434df475fa88b20557188d0f553116a92d7181b440d2c76a6eec377d844c` |
| installed anet CLI | SHA-256 `af3847dd1ddb75dd1265e995b1f2bd215df064e1b6c7e7aa823a1a96b270d7da` |
| installed agent-node CLI | SHA-256 `03e9bed6630530e8fb03420dba32c6e06a90ae8cbe3fcdf33541a047708a7bb4` |
| Grok CLI | `0.2.93`, binary SHA-256 `4e0738d3b5550f3c842bc0ae69f468815c6329c008a110d0c27a694dc3401135` |

首次真实任务在 4 秒内完成，结果为：

```text
COMM_DOG_TURN_OK alias=通信狗 model=grok-4.5
CHECK=2+3=5
```

第二次任务复用了同一 session：节点正确还原上一轮 `CHECK=2+3=5`，运行日志出现真实
`tool_running` 阶段，并在 10 秒内返回官方页面 `https://x.ai/grok` 与 terminal reply。

这证明了该次节点注册、入站消费、连续 Grok turn、会话上下文、WebSearch 和 Hub 终态回执。
它不证明长期稳定性、heavy 会员的完整配额，也不授权生产写操作。

一次直接读取 GitHub PR 的试验触发了 `approval_boundary`：Grok 尝试
`run_terminal_command`，安全边界拒绝后 TUI 子进程退出，而 agent-node 一度仍显示 idle；
紧接着的无工具任务也失败。因此当前的阶段 1 能力只包括通用 WebSearch 和任务中直接提供的
审查材料，**不包括**任意 URL/PR 内容读取。不能把 Hub 的 idle 状态单独当成可用性证明。

该故障仅重启 `通信狗`，配置 SHA-256 保持不变、`grokCliSession` 仍为原值；重启后的
无工具行为探针在 2 秒内返回 `RECOVERED_AFTER_BOUNDARY session_preserved`。本次本地
owner-only 配置回滚点为
`/home/vansin/.commhub/rollback-commdog-boundary-20260813T014843Z/`。

随后又发现一个独立的“半恢复”形态：节点仍能从 Hub 接收入站任务，attach socket 与 TUI
也都存活，但恢复进程的 `PATH` 不包含 Bun。运行时生成的 CommHub MCP 配置使用
`command = "bun"`，因此 TUI 内搜索不到 `commhub_send_message` / `send_task`，而节点表面仍
显示在线或 idle。`grok mcp doctor commhub --json` 给出的决定性错误是 `command not found: bun`。

三个节点均已用包含固定 Bun 目录的 `PATH` 做单节点恢复，未使用 `--new-session`；配置哈希和
`grokCliSession` 保持不变。修复后每个节点从自己的 workspace 运行 MCP doctor，均得到
`healthy_count=1`、`failing_count=0`、`3 tools discovered`。`通信狗` 又从可见 TUI 真实调用
`commhub_send_message` 给 `通信龙`，Hub 落库的 message id 为
`16466c5f-7318-4126-bd4e-d211822a6831`。这证明的是 TUI 出站 CommHub 路径，不是仅靠进程或
静态配置推断。

本轮 owner-only 回滚坐标为：

- `/home/vansin/.commhub/rollback-commdog-mcp-path-20260813T021822Z/`
- `/home/vansin/.commhub/rollback-A站狗-mcp-path-20260813T022143Z/`
- `/home/vansin/.commhub/rollback-P站狗-mcp-path-20260813T022239Z/`

### 旧会话工具库存与 TUI 假健康事故

`通信狗` 后续执行 issue #811 的只读审查任务
`113210ae-54fb-46d3-925f-ad6091d9ee09` 时，旧 Grok session
`58df4026-95be-4610-a45c-194478727cc9` 仍带有历史工具库存。Grok 请求
`run_terminal_command` / `grep`，事件流出现
`permission_requested` 后立即 `permission_resolved decision=allow wait_ms=0`；Agent Network 以
`[grok_failure:approval_boundary]` 拒绝该 turn。随后 TUI/leader 子进程退出，但常驻
agent-node、Hub SSE 和 tmux `0:node` 仍在线。这再次证明“节点 online/idle”不能代替 TUI
进程、attach socket 和真行为探针。

Grok CLI 0.2.93 在恢复日志中明确警告：会话创建后工具库存固定，resume 不能应用已经变化的
工具 profile。保存旧 config、session 与进程坐标后，本次只对 `通信狗` 执行一次受控
`--new-session`，得到当前 session `c47d3225-6d87-48a2-8c84-6c11db20a455`；旧 session 保留为
事故证据，不是当前运行坐标。owner-only 回滚点为
`/home/vansin/.commhub/rollback-commdog-tui-20260813T025425Z/`。

新 session 的最小 CommHub-only 行为验收任务
`ad2b376f-86ee-4bbf-b15f-d17d94c77ead` 在 7 秒内终态 `replied`。可见 TUI 只执行
`Commhub Send Message`，向 `通信龙` 落库 message id
`cd18fb21-51ce-4fde-bb79-30760749225f`，随后仍停在可交互提示符。该证据只放行
CommHub-only 协作；在新 session 的安全工具库存得到独立行为核验前，仍不得派发需要 shell、
文件系统或任意 PR/URL 读取的任务。

首个阶段 1 运维分析任务 `1f916e17-249e-4d1d-8b21-8ffa8703401e` 只向模型提供上述事件事实，
并明确禁止终端、文件与网页工具。它在 58 秒内终态 `replied`，正确把“CommHub 真发信且 TUI
事后仍存活”列为最强判活信号，把单独的 `0:node` 存活列为最弱信号；同时给出了普通故障与
固定工具库存不安全的分流、五步最小回滚/验收，以及未覆盖的根因和跨版本边界。TUI 完成后仍
停在可交互提示符。该结果证明它可在正文材料充分时参与受限运维分析，仍不证明 repo 读取或
生产执行能力。

## 从 Git 恢复软件

当前 `grok-build-cli` 是 source-only 路径。宿主部署副本
`/home/vansin/commniu-grok-candidate-a7865a43/` 不能作为唯一来源；从空机恢复时必须从
Git 取冻结 commit：

```bash
git clone https://github.com/sleep2agi/agent-network.git
cd agent-network
git checkout --detach a7865a4316a17d38e4c8dfc4c2cebaceaba2c62c
git status --short
```

`agent-network/package-lock.json` 在该 commit 中存在；`agent-node` 当时没有独立 lockfile。
因此当前只能按下列命令做功能级源码重建，不能宣称依赖闭包或制品字节已由 Git 完整冻结：

```bash
npm ci --prefix agent-network
npm run build --prefix agent-network
npm install --prefix agent-node
npm run build --prefix agent-node

mkdir -p /tmp/anet-grok-release/packages
npm pack ./agent-network --pack-destination /tmp/anet-grok-release/packages
npm pack ./agent-node --pack-destination /tmp/anet-grok-release/packages
```

把两份新 tarball 安装到独立 release 目录。恢复者必须回读版本并记录新制品 SHA-256；若要宣称与
2026-08-13 部署字节完全相同，还必须与上表 tarball及 installed CLI 哈希逐项匹配。
只做到“源码相同、重新构建成功”不能冒充 byte-identical。

`agent-node` 的依赖闭包冻结仍是 **NOT COVERED**，需要后续补 lockfile 或可验证的 release
artifact；本文不会用一段看似精确的命令掩盖这个缺口。

Grok CLI 从官方渠道安装固定版本 `0.2.93`，并核对上表二进制 SHA-256。官方分发 URL、
签名/校验和的 Git 权威副本目前 **NOT COVERED**；在补齐前，Git-only 恢复可复现
Agent Network 侧源码与配置流程，但不能证明 Grok 闭源二进制的供应链来源。

## 创建配置（不把密钥写进 Git）

配置目录与 token 是运行数据，不提交仓库。空机恢复有两种合法来源：

1. 从 owner 控制的加密备份恢复 `.anet/nodes/通信狗/config.json`；或
2. 通过 `anet login` 后重新注册同名节点，接受新的 `node_id` 与 token。

不得从会话记录、旧日志或别的节点复制 token。新建命令使用已构建的 CLI：

```bash
mkdir -p /home/vansin/grok-commdog-workspace
cd /home/vansin/grok-commdog-workspace
node /absolute/release/agent-network/dist/bin/cli.js \
  node create 通信狗 \
  --runtime grok-build-cli \
  --model grok-4.5 \
  --tools WebSearch
chmod 600 .anet/nodes/通信狗/config.json
```

网络选择必须由 owner 会话完成。不要加 `--batch` 来绕过交互选择：2026-08-13 的实测中，
该组合仍进入 vendor selector，不能当成无人值守恢复接口。

## 首次建机的精确启动

`agent-network` CLI 与 `agent-node` 必须来自同一冻结 release。若省略
`ANET_AGENT_NODE_BIN`，宿主可能误用不支持 `grok-build-cli` 的旧全局 agent-node，出现
命令返回但节点未上线的假成功。

下面的 `--new-session` **只用于首次创建 Grok CLI 会话**。已有 config/session 的故障恢复
不得照抄该参数；恢复路径见下一节。

```bash
export ANET_RELEASE=/absolute/release
export GROK_BINARY=/absolute/path/to/grok-0.2.93
export ANET_AGENT_NODE_BIN="$ANET_RELEASE/agent-node/dist/cli.js"
export BUN_DIR=/absolute/directory/containing/verified-bun
export NODE_DIR=/absolute/directory/containing/verified-node
export PATH="$BUN_DIR:/absolute/directory/containing/grok:$NODE_DIR:/usr/local/bin:/usr/bin:/bin"

command -v bun
test "$(bun --version)" = "1.3.14"
command -v node
command -v "$GROK_BINARY"

cd /home/vansin/grok-commdog-workspace
tmux new-session -d -s 通信狗 -n node \
  "env PATH='$PATH' GROK_BINARY='$GROK_BINARY' \
       ANET_AGENT_NODE_BIN='$ANET_AGENT_NODE_BIN' \
       node '$ANET_RELEASE/agent-network/dist/bin/cli.js' \
       node start 通信狗 --new-session"

# attach socket 是最低就绪门；有 tmux 窗口但 socket 未就绪不能算 TUI 共存。
CONFIG=/home/vansin/grok-commdog-workspace/.anet/nodes/通信狗/config.json
ATTACH_SOCKET="$(jq -er '.grokAttachSocket' "$CONFIG")"
for _ in $(seq 1 60); do
  test -S "$ATTACH_SOCKET" && break
  sleep 0.5
done
test -S "$ATTACH_SOCKET" || { echo "Grok attach socket not ready" >&2; exit 1; }

# 让 `tmux attach -t 通信狗` 默认进入真实 TUI，而不是节点日志窗口。
tmux new-window -d -t 通信狗 -n tui \
  -c /home/vansin/grok-commdog-workspace \
  "exec node '$ANET_RELEASE/agent-network/dist/bin/cli.js' grok attach 通信狗"
tmux select-window -t 通信狗:tui
```

该布局中 `0:node` 是常驻通信节点，`1:tui` 是同一 Grok session 的交互界面；两者不是两套
模型会话。运维者进入 `tmux attach -t 通信狗` 后应直接看到
`attached to Grok TUI "通信狗"`。用 `Ctrl-b 0` 查看节点日志、`Ctrl-b 1` 回到 TUI；
TUI 内 `Ctrl-]` 只断开 attach，不停止节点。`A站狗`、`P站狗` 使用相同两窗口布局，只替换
alias、workspace 与 tmux 名。

不要仅凭命令退出码或 tmux 名称宣告成功。启动后至少核对：

```bash
tmux has-session -t 通信狗
tmux list-windows -t 通信狗 \
  -F '#{window_index} #{window_name} active=#{window_active} panes=#{window_panes}'
tmux capture-pane -t 通信狗:tui -p -S -80
ps -eo pid,ppid,lstart,args | grep '[a]gent-node.*--alias 通信狗'
sha256sum "$ANET_RELEASE/agent-network/dist/bin/cli.js" \
          "$ANET_RELEASE/agent-node/dist/cli.js" \
          "$GROK_BINARY"
```

再从 Hub/Dashboard 核对 alias 在线、runtime=`grok-build-cli`、model=`grok-4.5`、
`node_id` 与配置一致，并派一条无副作用任务验证真实 turn 与 terminal reply。

### CommHub MCP 是独立就绪门

attach socket、TUI 和 Hub 入站任务都正常，仍不能证明 TUI 的出站 CommHub MCP 正常。必须从
**目标节点自己的 workspace**（不是任意 cwd）运行 doctor；Grok 的 folder trust 会使错误 cwd
产生无关失败：

```bash
cd /home/vansin/grok-commdog-workspace
GROK_HOME=/absolute/grok-home-for-this-node \
PATH="$PATH" \
  "$GROK_BINARY" mcp doctor commhub --json > /tmp/commdog-mcp-doctor.json

jq -e '
  .healthy_count == 1 and
  .failing_count == 0 and
  ([.servers[] | select(.name == "commhub")][0].healthy == true) and
  ([.servers[] | select(.name == "commhub")][0].checks |
    any(.label == "3 tools discovered" and .passed == true))
' /tmp/commdog-mcp-doctor.json
```

最后从可见 TUI 发一条无副作用 `commhub_send_message`，并从 Hub 侧按返回的 message id 回读
`from_session`、`session_name`、`type=message`。只有 doctor 与真实出站消息都通过，才可宣告
TUI/节点通信共存恢复完成。反向见证应移除 Bun 所在目录后确认 doctor 在
`command found` 这一项转红；不能只检查 MCP 配置文件里出现了 `command = "bun"`。

## 停用与回滚

这是新增节点，没有需要恢复的旧 `通信狗` 运行时。失败时的安全回滚是只停该 tmux/进程、
保留配置与会话供取证，不删除 workspace，不重建 Hub，不碰其它节点：

```bash
tmux send-keys -t 通信狗:node C-c
# 确认该 alias 的 agent-node 退出；若仍在，记录 PID 后只对精确 PID 做 TERM。
ps -eo pid,ppid,lstart,args | grep '[a]gent-node.*--alias 通信狗'
```

不要使用宽泛 `pkill`、fleet restart、数据库清理或 `docker prune` 作为回滚。重新上线时仍按
“同一 source commit → 制品哈希 → 单节点 → 真实任务”的顺序执行。

普通故障恢复必须先记录已有会话，再用**不带 `--new-session`** 的相同启动命令恢复：

```bash
CONFIG=/home/vansin/grok-commdog-workspace/.anet/nodes/通信狗/config.json
SESSION_BEFORE="$(jq -er '.grokCliSession' "$CONFIG")"

# 仅在上面的精确进程退出核验通过后，清掉该 alias 的残留 tmux attach 窗。
tmux has-session -t 通信狗 2>/dev/null && tmux kill-session -t 通信狗

# 只重建目标节点；env 与二进制路径沿用“首次建机”一节，但不得带 --new-session。
tmux new-session -d -s 通信狗 -n node \
  "env PATH='$PATH' GROK_BINARY='$GROK_BINARY' \
       ANET_AGENT_NODE_BIN='$ANET_AGENT_NODE_BIN' \
       node '$ANET_RELEASE/agent-network/dist/bin/cli.js' \
       node start 通信狗"

SESSION_AFTER="$(jq -er '.grokCliSession' "$CONFIG")"
test "$SESSION_AFTER" = "$SESSION_BEFORE" || {
  echo "unexpected Grok session replacement" >&2
  exit 1
}
```

随后仍需等待 attach socket、创建 `tui` 窗，并完成 `capture-pane`、CommHub MCP doctor 与 Hub
真任务终态核验。
**反向见证**是：把恢复命令误改为带 `--new-session` 时，会话保持断言必须转红；若只看
tmux 窗口存在而仍判成功，该验收就是空门。

唯一例外是：事件日志已经证明旧 session 的固定工具库存违反当前安全 profile，且对应 Grok
版本明确报告 resume 无法应用工具变化。此时必须先保留旧 config/session/事件证据与回滚坐标，
再对**单一 alias**执行一次 `--new-session`。新 session 不是自动成功：仍须重建 `0:node` +
`1:tui`，核 node_id 不变，并通过受限的真行为任务；不得借该例外批量换 session。

## 渐进参与边界

三个狗节点按证据逐级参与 AgentNetwork，不因会员额度增加而自动扩大权限：

1. **阶段 0（已通过）**：单轮回复、身份/模型/终态回执。
2. **阶段 1**：通用公开资料检索，或审查任务正文中直接提供的 issue/PR 材料，报告事实与
   NOT COVERED；当前不允许任意 URL/PR 抓取，禁止写 GitHub。
3. **阶段 2**：在独立 clean worktree 起草 patch，Docker 验证并由另一节点独审；禁止自行合并。
4. **阶段 3**：经明确授权后执行一个有回滚点的单点运维动作，先回 preflight、后切换。
5. **舰团级动作**：批量配置、批量重启、发布、生产 DB、云资源与密钥操作始终需要单独授权，
   不由前一阶段的成功自动继承。

当前工具面只允许 Grok 自带的检索/任务工具与 `WebSearch`，没有文件系统、shell、媒体、
宿主 MCP 或子代理权限。任何扩权都要先更新本文、补行为门并留回滚坐标。

## 数据与密钥边界

Git 只恢复软件和非密钥流程，不恢复以下数据：Hub 数据库、node token、Grok 登录/会员状态、
`grokCliSession`、任务历史与用户生成内容。它们必须来自经过批准的备份或重新注册。
文档只记录密钥来源和恢复动作，永不记录密钥值。

## A站狗与 P站狗的首轮证据

两节点均以 `grok-build-cli` / `grok-4.5` / `WebSearch` 创建并在独立 tmux 中启动。
Hub 显示各自的 `project_dir` 与上表一致，真实任务分别完成：

```text
ASTATION_DOG_OK alias=A站狗 model=grok-4.5
CHECK=7+8=15

PSTATION_DOG_OK alias=P站狗 model=grok-4.5
CHECK=9+6=15
```

任务完成后两个 tmux pane 均 `dead=0`，两条独立 attach socket 均仍为 Unix socket，证明
节点通信与可 attach 的 Grok TUI 同时存活，而非“任务跑完后 TUI 被替换”。

`A站狗` 创建时曾把 config 写入全局 `~/.anet/nodes/A站狗`，从独立 workspace 启动会
fail-closed 报 `Node "A站狗" not found`。配置经 SHA-256 字节比对后迁入目标 workspace；
未使用的原始全局副本保存在 owner-only 回滚坐标
`/home/vansin/.commhub/rollback-Astationdog-global-config-20260813T015544Z/`。恢复时必须核对
实际 `config_path`，不能只采信 create 命令的成功文案。

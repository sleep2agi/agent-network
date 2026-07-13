# Grok Agent Leader 共存 TUI 正式 Runtime 设计提案

> 状态：**Review-ready proposal；实现仍锁定，待通信龙明确放行**
> 产品基线：`grok 0.2.93 (f00f96316d)`；最终版本门同时绑定可执行文件 SHA-256
> 拟议 canonical runtime：`grok-agent-leader`
> 证据日期：2026-07-13
> 评审人：通信龙 / Vincent；作者不得自签安全门

## 0. 结论与当前边界

正式形态应是一个独立 `grok-agent-leader` runtime：人类原生 Grok TUI 和
Agent Network 任务共用一个 Grok Leader、一个 cwd、一个 session，但所有
会改变 session 的输入都必须经过一个 **Policy Gateway / admission arbiter**。

已验证的 test220 能证明产品核心体验：

- 无 TTY 的 `grok agent leader` 可以常驻；
- 两个独立 ACP frontend 可以 attach 同一 Leader/session 并收到 live broadcast；
- ACP frontend 发出的标准 `session/prompt` 会在带隐藏顶层 `--leader` 的真实
  Grok TUI 中 live 渲染，全程不写 TUI stdin；
- `grok agent serve` 配置正确 query secret 的 happy path 已证明是 ACP WebSocket；
  认证是否强制、Bearer/query 优先级、Origin 和错误 secret 的完整边界尚未冻结。
  已保存的 idle-observer 负控表明它不是共享 Leader 的 durable subscriber，因此
  不选它做共存数据面。

但仓内目前**没有可回放的 0.2.93 完整 wire fixture**。test220 保存的是
curated proof；init/auth/session response、eventId、promptId、requestId 和原始
replay 字段已经被裁掉。approval 路由、并发 prompt、disconnect/replay 等生产
语义也没有原始抓包。因此本提案把“补齐 raw fixture 并冻结合同”列为 Phase 0，
在它通过前不写 runtime 代码。

另有两个明确的非基线：

- `agent-node/src/runtime/grok-copresence/` 仍是旧 PTY 键盘注入 + JSONL tail
  原型，且没传关键的隐藏 `--leader`；它不是本设计的实现起点。
- Codex RFC-030 的 A/B worktree 都仍处于独立评审 FAIL/locked。只复用已经
  识别出的抽象和硬门，不复制其未通过的实现或测试数字。

## 1. 目标、非目标与产品承诺

### 1.1 目标

1. 节点以 canonical runtime 注册，在 Hub `/api/status`、`/api/nodes` 和真实
   Dashboard 中显示为 Grok 共存 TUI。
2. 其他节点可按服务端解析的 node identity 向它 `send_task`；SSE 只负责唤醒，
   durable inbox claim 才是真正投递。
3. 网络 task 通过标准 Grok ACP 进入共享 session，并在真实 TUI live 显示；
   completion 只回复原 task。
4. 人类在同一 TUI 发出的普通 turn 不触发网络 reply；显式网络派发走最小权限
   CommHub tool proxy，服务端强制写入节点身份。
5. 运行时持续上报真实状态与心跳，支持 TUI、bridge、Leader、agent-node 的
   可判定恢复，不盲目重放 side-effect turn。
6. Grok child、TUI 和 ACP proxy 均看不到 CommHub token、数据库、云密钥或任意
   未批准的父进程环境变量。

### 1.2 非目标

- 不使用 `tmux send-keys`、PTY paste、stdin 注入或 session JSONL tail 作为正式
  入站/完成控制面。
- 不允许 Agent typed face 访问 raw Leader IPC、任意 ACP method、approval id、
  session id、permission mode 或 `steer`。
- Phase 1 不开放网络 turn 的写权限或自动审批；固定 fail-closed policy。
- 不支持多个不互信的人类同时作为可写 TUI owner。
- 不把同 Unix uid 的恶意本地进程纳入 Phase 1 威胁模型；若要求该隔离，必须用
  独立 OS user/container，而不是宣称 `0700` 能隔离同 uid。

### 1.3 必须精确表述的“人类优先”

Gateway 只能看到 TUI 已提交的 protocol frame，不能知道人类正在编辑但尚未按
Enter 的文本。因此产品承诺是：

- 已提交的人类 turn 优先于尚未取得 reservation 的网络任务；
- human turn active 时网络任务只排队；
- agent turn 已取得 reservation 后，随后到达的人类 start/steer 一律返回结构化
  `Busy(network_turn_active)`；不 hold、不排成人类下一 turn、不隐式转成 steer；
- 只有当前 human-owner 的显式 interrupt 能抢占 agent turn；
- 不承诺“尚未提交的编辑内容”永远比已经原子取得 reservation 的网络任务优先。

真实 0.2.93 TUI 必须能安全显示 Busy 且不把旧输入暗中重发/steer；否则这一产品
路径 no-go。实现不得在运行时根据时序临场切换成 hold、queue 或 keyboard fallback。

## 2. 证据账本：已证、未证、作废

| 项目 | 当前状态 | 可用于设计的结论 |
|---|---|---|
| test220 Leader 生命周期 | 已证，curated artifact | `--no-exit-on-disconnect --relay-on-demand --no-auto-update`；lstat/PID/inode readiness 形状成立 |
| 两 ACP frontend 同 session live | 已证，curated artifact | `session/load + session/prompt` 可做正式模型输入；不用键盘注入 |
| 真实 TUI live render | 已证，curated artifact | 顶层 TUI 必须同时传隐藏 `--leader` 与 `--leader-socket` |
| `agent serve` idle observer | 已证负控，curated artifact | serve 不作为共存 fanout 数据面 |
| 完整 0.2.93 ACP frame | 未证 | 编码前必须重抓、脱敏并 checked-in |
| 原生 Leader IPC framing/methods | 未证 | Policy Gateway 能否拦截 TUI 写端的架构 blocker |
| approval request 路由/抢答 | 未证 | Phase 1 固定 never；Phase 2 owner approval 不得先承诺 |
| human/network 同时 submit | 未证 | 必须抓 race/FIFO/cancel/queue 真实语义 |
| disconnect/replay/event identity | 未证 | 不得依据旧版本 fixture 写 reducer |
| serve bearer/query/origin 完整矩阵 | 只有研究陈述 | 重新抓 HTTP upgrade、close code 和 JSON frame |
| 旧 grok-copresence PTY 方案 | 作废为正式架构 | 只可借鉴纯状态机、路径安全和锁，不复用 I/O |
| 0.1.219 ACP fixture | 版本错误 | 仅作抓包格式模板，不能作 0.2.93 合同 |

版本门不能只比较一条现有字符串：test220 与 demo 对尾部 `[stable]` 的期待不一致。
Phase 0 要保存 `grok --version` 原始字节、归一化后的 semver/build hash 和实际
executable SHA-256；运行时三者任一不匹配均 fail closed。

## 3. 推荐拓扑：单 admission gateway

```text
 Human
   │
   ▼
 anet grok attach ── sanitized env ── native Grok TUI
                                      │ hidden --leader
                                      ▼
                              gateway TUI socket
                                      │ parsed/leased native IPC
                                      ▼
                               Policy Gateway
                           ┌──────────┴──────────┐
                           │                     │
                    private Leader IPC      typed Agent face
                           │                     ▲
             ┌─────────────┴────────────┐        │
             │                          │        │
      native TUI upstream       managed ACP proxy│
             │                session/load/prompt│
             └─────────────┬────────────┘        │
                           ▼                     │
                    grok agent leader            │
                    one cwd/session              │
                                                 │
 CommHub ⇄ node adapter/SSE/claim/heartbeat ─────┘
    ▲              │
    └── minimal local tool proxy (optional Phase 1B)
```

### 3.1 为什么不能直接双客户端上线

test220 的 direct TUI + ACP 双客户端证明了体验，却没有形成权限边界：两端都可以
写同一 session，Leader 是否把第二 prompt 排队、steer、cancel 或混入 active turn
尚未冻结；approval 可能是 submitter-only、broadcast 或 first responder。仅让 bridge
“自觉不回答审批”不是安全控制。

因此正式 runtime 的 private Leader socket 不直接交给人类或 Agent Network。
Gateway 对 TUI 暴露独立的 per-generation socket，对网络只暴露 typed methods。
所有 session-changing frame 在转发前取得同一个 reservation。

### 3.2 架构 no-go 门

Policy Gateway 必须能从真实 0.2.93 Leader IPC 中稳定识别：

- TUI initialize/attach/resume 与 session identity；
- human prompt/start；
- steer/interrupt/cancel；
- permission request 与 response；
- turn started/completed、disconnect/replay。

如果 Phase 0 证明 native IPC 不能被稳定解析/代理，或者 TUI 无法通过 proxy 正常
启动、resume、渲染与审批，则本生产架构判 **no-go**。可保留 direct dual-client
作为本地 preview，但不得以“Leader 看起来会 FIFO”为由绕过 gateway 上线。

### 3.3 进程与目录

每个 node 使用独立实例：

```text
$RUNTIME_DIR/<node-id>/                 0700
  leader.sock                           Grok 创建；父目录负责访问边界
  tui/<attach-generation>.sock          一次只接受一个 human owner
  gateway.sock                          owner-only typed local API
  leader.pid.json                       pid/starttime/dev/inode/binary hash
  runtime.db                            0600 durable ledger
  logs/                                 0700，结构化且脱敏

$STATE_DIR/<node-id>/grok-home/          isolated HOME/auth/session
$STATE_DIR/<node-id>/tmp/                isolated TMPDIR
```

启动前拒绝 symlink、foreign uid、未知存量 socket；readiness 先 lstat，再校验 PID、
`/proc/<pid>/stat` starttime、cmdline、socket `(dev,inode)`，最后通过官方 ACP proxy
做真实 initialize/auth。禁止用裸 Unix connect 充当 readiness，禁止泛化执行
`grok leader kill`，禁止在失败时暗降级到 per-turn headless Grok。

## 4. 组件与 typed contract

### 4.1 Node adapter

Node adapter 是唯一持有 CommHub credential 的组件，负责：

- server-resolved node registration 与 runtime capability；
- self SSE、backlog drain、durable inbox claim；
- task/attempt ledger、ACK、`send_reply` retry；
- 根据 gateway 状态上报 `idle|human_turn|network_turn|waiting_human|recovering|error`；
- 续租 task consumer lease；
- 可选的最小权限 CommHub tool proxy。

它不把 token 放入 Grok prompt、argv、config、environment、MCP descriptor 或 artifact。

tool proxy 也不是“只要隐藏 token 就安全”。每次调用必须携带 gateway 生成且模型
无法伪造的短期 reservation capability，并绑定：

```text
{ turnOrigin, taskId?, nodeId, runtimeInstanceId,
  consumerLeaseEpoch, reservationId, expiresAt, allowedMethods }
```

Human-origin 与 Agent-origin 使用不同 capability。Agent-origin 默认没有主动
`send_task/send_message` 权限；若产品以后开放，只能逐 method、逐 target/TTL/budget
授权。过期 lease、旧 reservation、错误 origin 或 prompt 注入诱导调用均 fail closed。

### 4.2 Agent typed face

复用 Codex frozen contract 的形状，但不复用其 wire：

```ts
enqueueTask({ taskId, messageId, lease, authenticatedSender, text })
getTaskState(taskId)
cancelQueuedTask(taskId)
subscribeRuntimeState()
```

调用者不能指定 `sessionId`、Leader socket、ACP method、permission、model、cwd、
tool、approval request id、prompt id、turn id、`inject` 或 `steer`。unknown field 与
unknown method 默认拒绝。

### 4.3 Grok protocol adapter

只消费 Phase 0 fixture 冻结的方法/字段：

- 官方 ACP proxy 的 initialize/auth/session load/prompt/update；
- TUI native Leader IPC 的 attach/resume、prompt、turn、permission 子集；
- replay/event identity 与 completion reducer。

当前只确认 completion 会出现 `turn_completed` / `prompt_complete` 的 curated
形状；最终 reducer 必须以新 raw fixture 为准。不能复制 0.1.219 字段，也不能把
`isReplay !== true` 误写成 wire 上显式 `isReplay:false`。

### 4.4 Durable ledger

逻辑 task 与 delivery attempt 分表，避免 Codex B 分支中“注释说单 row、实现每
message 一 row”的歧义：

```text
logical_tasks:
  task_id UNIQUE, sender_principal_id, state, final_result_hash

delivery_attempts:
  message_id UNIQUE, task_id FK, consumer_node_id,
  runtime_instance_id, lease_epoch, lease_expires_at,
  dispatch_nonce, session_id, prompt_id?, turn_id?,
  state, accepted_at, completed_at, reply_state
```

状态：

```text
received -> claimed -> queued -> dispatching -> accepted
         -> completed -> reply_pending -> replied

dispatching/accepted -> ambiguous
queued -> cancelled
accepted -> interrupted_by_human | failed
```

request 已发但 response 丢失时禁止重发。先 resume/load 并用 fixture-confirmed
prompt/event identity 协调；无法证明唯一结果就进入 `ambiguous`，不自动重放。

## 5. 输入仲裁

### 5.1 状态机

```text
STARTING
  -> IDLE

IDLE
  -> HUMAN_RESERVED -> HUMAN_TURN -> IDLE
  -> AGENT_RESERVED -> AGENT_DISPATCHING -> AGENT_TURN -> IDLE

HUMAN_TURN
  + network task -> durable FIFO
  + human approval -> WAITING_HUMAN_APPROVAL -> HUMAN_TURN

AGENT_TURN
  + network task -> durable FIFO
  + human start/steer -> Busy(network_turn_active)
  + explicit human interrupt -> INTERRUPTING -> interrupted_by_human

any state
  -> RECOVERING -> IDLE | prior proven state | AMBIGUOUS
  -> QUARANTINED on invariant violation
```

reservation 的 check-and-set 必须同步、无 `await` 窗口，并覆盖“选队列项 → 发
upstream prompt → 取得可关联 prompt/turn identity”。

### 5.2 调度规则

1. 一个 session 只有一个 gateway scheduler 和一个 active reservation。
2. Gateway 给所有已到达输入分配单调 `admission_seq`。IDLE 的一次 scheduler batch
   先处理该 batch 已到达的 human start，再取 Agent FIFO；reservation 一旦原子取得，
   后到 human start 不反转 owner。
3. Agent task 只走 fixture-confirmed 的独立 prompt/start，不走 steer/inject。
4. active human turn 期间 Agent 不调用 upstream；active Agent turn 期间 human
   start/steer 返回 Busy，不调用 upstream，也不保留为下一个 turn。
5. human interrupt 是唯一紧急越权路径，必须来自当前 owner lease，结果为
   `interrupted_by_human`，绝不自动 replay。
6. 任一未知额外 turn、session mismatch、重复 completion 或 owner collision 进入
   `QUARANTINED`，停止后续 dispatch，不猜测归属。
7. 队列有长度、字节、TTL 和费用预算；满时不 ACK inbox，按 server retry/backoff，
   不静默丢弃。

### 5.3 输入 × 状态穷举规则

下表是产品规则，不允许实现按时序“看情况”选择另一种行为：

| 当前状态 | human start | human steer | human interrupt | network task | approval response | terminal/update |
|---|---|---|---|---|---|---|
| `STARTING` | Busy(starting) | Busy(starting) | InvalidState | 持久入 inbox，不 claim/dispatch | 拒绝，无 pending lease | 仅诊断；意外 session event→QUARANTINED |
| `IDLE` | 原子取得 `HUMAN_RESERVED` | InvalidState | InvalidState | 入 Agent FIFO；scheduler 才可取得 `AGENT_RESERVED` | 拒绝，无 pending lease | replay 按 cursor 去重；未知 live terminal→QUARANTINED |
| `HUMAN_RESERVED` | Busy(human_reserved) | Busy(human_reserved) | 本地撤销未发送 start；若已发送则进入 interrupt 流程 | 入 Agent FIFO | turn identity/pending request 尚未建立则拒绝并 QUARANTINED | 只接受 reservation 对应 turn identity |
| `HUMAN_TURN` | Busy(human_turn_active) | Phase 1 Busy；以后只有抓包证明且同 owner/turn 才可开放 | 允许中断本 human turn，不产生网络 reply | 入 Agent FIFO | 仅当前 owner lease + 当前 request | 匹配 human turn 后释放；绝不触发 send_reply |
| `WAITING_HUMAN_APPROVAL` | Busy(waiting_approval) | Busy(waiting_approval) | 先 fail-closed 当前 approval，再 interrupt | 入 Agent FIFO | 仅当前 owner lease + exact tuple；第二 request collision→QUARANTINED | 匹配 turn；approval 仍 pending 的矛盾状态→QUARANTINED |
| `AGENT_RESERVED` | Busy(network_turn_reserved) | Busy(network_turn_reserved) | 若 upstream 零写入则本地取消；否则设置 `interrupt_requested` 等 identity | 入 Agent FIFO | 拒绝 | 未 dispatch 却收到 live event→QUARANTINED |
| `AGENT_DISPATCHING` | Busy(network_turn_dispatching) | Busy(network_turn_dispatching) | 记录 `interrupt_requested`，不重发 prompt；取得 identity 后走唯一 interrupt | 入 Agent FIFO | Phase 1 明确拒绝 | response 丢失先 reconcile；不能证明则 AMBIGUOUS |
| `AGENT_TURN` | Busy(network_turn_active) | Busy(network_turn_active) | 当前 owner lease 可显式 interrupt | 入 Agent FIFO | Phase 1 明确拒绝；意外 request 使 turn fail closed | exact task/turn 才收集并 reply |
| `WAITING_AGENT_APPROVAL` | Busy(waiting_agent_approval) | Busy(waiting_agent_approval) | 允许显式 interrupt | 入 Agent FIFO | Phase 1 永远 reject；状态仅用于审计/终结 | approval/turn 未一致终结前不调度下一项 |
| `INTERRUPTING` | Busy(interrupting) | Busy(interrupting) | 同 lease duplicate idempotent；其他拒绝 | 入 Agent FIFO | reject/fail closed | 只接受被中断 turn terminal，然后释放 reservation |
| `RECOVERING` / `AMBIGUOUS` | Busy(recovering) | Busy(recovering) | 仅运维 recovery API，不直发 upstream | 保持 durable；不 claim 新 row | stale/unknown 全拒绝 | 只作 reconcile；证明唯一状态后显式退出 |
| `QUARANTINED` | Error(quarantined) | Error(quarantined) | Error(quarantined) | 不 ACK、不 dispatch | 全拒绝 | 仅审计；必须人工 reset/new generation |

补充规则：

- IDLE 同一 scheduler batch 内 human start 胜过 Agent FIFO；不同 batch 以先取得的
  reservation 为准。正在编辑但未 Enter 不属于已到达输入。
- human start/steer 收到 Busy 后由人类显式重试。Gateway 不缓存正文、不自动重试，
  也不把它改写成 post-turn prompt。
- 非当前 owner lease 的 human control 在 socket admission/lease 层直接拒绝，不进入
  上表 reducer，也不影响 incumbent owner。
- network `cancel_task` 可取消 queued attempt；`AGENT_RESERVED` 且 upstream 零写入时
  也可本地取消。进入 `AGENT_DISPATCHING/AGENT_TURN` 后返回 `TooLate/active`，不把
  远端 cancel 映射为 steer/interrupt；只有 human-owner 的明确 interrupt 能终止
  active turn。重复 cancel 幂等。
- disconnect 不是 interrupt：进入 RECOVERING，保留 reservation，按 §7 reconcile；
  timeout 也不自动 replay。
- 任何不在表中的 method/input 默认拒绝，不做兼容透传。

Phase 0 必须用真实 TUI 验证 Busy 不丢输入、不导致 TUI 自行重试/steer；若失败则
产品路径 no-go。至少 100 轮 human/Agent 同时提交，task→prompt/turn 必须始终一对一、
零隐式 steer、零自动重放。

### 5.4 `inject` / `steer` 永久默认禁用

Phase 1 无论抓包是否发现 `inject`，都只允许 gateway 在取得 Agent reservation 后
调用标准 `session/prompt`。Agent typed face、local tool proxy、TUI compatibility path
均没有 raw `inject/steer` 能力。

任何来源、任何状态出现 `inject` 都固定返回 `MethodNotSupported`：不分配 reservation、
不改变队列/ledger、Leader 零 frame。Phase 1 的 Agent permission request 也不是
“reject 后继续跑”：gateway 用 fixture-confirmed response 拒绝后将对应 turn 标记失败，
等真实 terminal event 后才释放 reservation。

以后要纳入任一方法，必须单独证明：

1. 它经过同一个 atomic reservation，不能绕过 Agent FIFO 或 sender admission；
2. human reservation/turn active 时调用会被 gateway 本地拒绝且 Leader 零 frame；
3. 它只创建新的、可唯一关联的 turn，不合并/修改/打断 active turn；
4. caller 不能指定别的 session/turn/owner，断线后也不会延迟执行；
5. 故意绕开 arbiter 的 mutation test 在修复前转红。

只要真实语义包含 interject、steer、interrupt、优先插队或绕过 completion mapping，
该方法即使存在也永久不进入正式 runtime。

## 6. Approval owner 与 lease

### 6.1 Phase 1：硬 pin fail-closed

Phase 1 的 Agent turn 固定 `approval=never` / 非写入 policy。任何从 Agent-origin
turn 出现的 permission request 都以原始 request identity 显式拒绝并记录审计，
不能 timeout 后自动 allow-once，不能把可配置 passthrough 留在生产 surface。
`approval=never` 的实际配置入口和“如何显式拒绝”本身也必须由 Phase 0 fixture
冻结；如果 0.2.93 无法在协议层强制执行，Phase 1 fail closed/no-go。

owner lease machinery 从 Phase 1 就必须存在。人类自己的 turn 若允许 approval，
也必须满足 §6.2 的 session/turn/request/attach-generation/ownerLease 绑定；否则
Phase 1 对所有 origin 一律拒绝 approval。Phase 2 只是考虑是否允许人类审批
Agent-origin turn，不是把基本 lease 安全延后。

### 6.2 Owner lease 模型与 Phase 2 扩展

每个 reverse request 持久绑定：

```text
{ nodeId, runtimeInstanceId, sessionId, turnOrigin, taskId?,
  turnId/promptId, upstreamRequestId, ownerLeaseId, leaseEpoch, expiresAt }
```

- reverse request namespace 与普通 request id namespace 分离；
- 只把 display-safe request 交给当前 human-owner TUI；Agent typed face 永远看不到
  upstream request id 或 option id；
- response 必须同时匹配 owner lease、epoch、session、turn、task 和 request；
  mismatch/duplicate/expired response 不消费 pending request；
- stale detach 不能释放新 owner，TUI 断线 fail closed；重连使用新 attach generation
  和新 owner lease，不复用旧 approval；
- pending approval 超时后拒绝并终止/失败对应 turn，不启动下一 task；
- passive ACP observer 和同网络其他节点的 allow response 必须转红。

若实抓证明 permission 只送 ACP submitter且真实 TUI 无法合法回应，Phase 2 的网络
turn 人类审批判 no-go；Phase 1 继续保持 never，不能用 prompt/键盘桥接伪装审批。

## 7. Resume、断线与生命周期

### 7.1 Generation

Leader、gateway、ACP connection、TUI attach、CommHub runtime instance 分别有单调
generation/epoch。所有 callback、request map、lease 和 completion 都绑定 generation；
旧 generation 的晚到消息只记诊断，不改变当前状态。

TUI attach 使用新的不可预测 socket path。连接成功后关闭该 generation 的 listener；
owner 断开时 gateway 回到可重新 mint attach generation 的状态，而不是继承 Codex A
候选中“listener 关闭后再也不能真实重连”的问题。

### 7.2 恢复规则

- **TUI 断开、无 approval：** Agent turn 可否继续由 fixture 决定；gateway 保留
  reservation，重连同 session，绝不自动 spawn 第二 TUI owner。
- **TUI 断开、pending approval：** 立即 fail closed 或在短 lease 内 park；超时拒绝。
- **ACP proxy 断开：** 原子 settle 所有 pending request；reconnect/backoff/jitter 后
  load 同 session，过滤 replay。manager 本身绝不 resend prompt。
- **Gateway/agent-node 重启：** 先打开 ledger、取得 server consumer lease、检查
  Leader PID/starttime/socket inode，再 attach/load/reconcile；未判定前不 claim 新 task。
- **Leader crash：** 不 kill 未确认进程，不盲删 socket；证明旧 PID 已死且 inode
  匹配后才回收。重启 exact binary，resume session；active side-effect turn默认
  `ambiguous`。
- **CommHub SSE 断开：** SSE 仅 doorbell。每次 connect/reconnect 先循环
  `claim_self_inbox` drain backlog，再等 live event；不能在一小时后静默停止。

transport close 必须原子 reject/settle 每个 pending origin；不能像 Codex mux 的旧
`drainAll()` 一样只清 map、让 Promise 留到超时。

## 8. CommHub 身份、claim 与正式节点面

现有 inbox/tasks、SSE wake、task lineage、telemetry、`/api/status`、`/api/nodes`
可以复用；现有 alias-based authorization 不能复用。正式启用前必须补服务端原语。

### 8.1 Server-resolved principal

认证上下文提供不可变：

```text
Principal {
  kind: user | node | child,
  userId, networkId, nodeId?, tokenId,
  canonicalAlias?, role, capabilities
}
```

node token 在签发时绑定已存在的 `nodeId`；prefix、`token.name`、请求里的
`alias/from/from_session/node_id` 只作兼容/显示，绝不参与授权。`report_status` 不信
客户端 alias/node/network；服务端由 principal 补齐。REST `/api/task` 同样忽略或
拒绝 forged `body.from`。

node capability 最小集：self report/heartbeat、self SSE、claim self inbox、在有效
lease 下 ACK/reply、发送 task/message、有限状态读取。node token 不能 mint/revoke
token，也不能调用 user/network/admin 控制面。

服务端解析出真实 principal 只是认证，不等于有权向这个共享人类 session 注入。
每个 `grok-agent-leader` node 必须有显式 sender admission policy，默认拒绝：

```text
allowed_sender_node_ids / allowed_roles / allowed_task_kinds
policy_revision + authorization_epoch
```

`send_task` 入库和 runtime claim 时都校验授权；attempt 持久化授权快照/epoch，策略
撤销后尚未 dispatch 的 row 不再进入 session。alias、同 network member 身份或能
成功调用普通 `send_task` 均不构成共享 session 的读取/注入权限。

这是数据边界而不只是写入 ACL：被允许的 sender 被视为有权让模型使用该 shared
session context，也可能收到其语义转述。prompt envelope/output scrubber 只能减少
意外元数据泄露，不能作为“模型不会改写历史”的保密控制。若某 sender 不应读取
人类 session context，就必须使用独立 session/node；0.2.93 同 session 若没有真实
上下文隔离能力，则该组合明确 no-go。

### 8.2 Row-consumer lease

`get_inbox(alias)` 改为原子 `claim_self_inbox(runtimeInstanceId)`：consumer node 从
Principal 派生，不接受 alias 参数。claim 用 CAS 写入：

```text
consumer_node_id, lease_owner_runtime_instance_id,
lease_epoch, lease_expires_at, delivery_state
```

只有同 node、同 runtime instance、同 epoch 的 holder 能 heartbeat 续租、ACK、
dead-letter、reply 或关联 approval。lease 过期后同 node 的新 instance 可恢复；旧
epoch 永久拒绝。同网络不等于同 row consumer。

`send_reply(taskId, text, status, lease)` 由服务端从原 task 推导目标并校验
`task.to_node_id == principal.node_id`；调用者不能指定 `from` 或 reply target。

consumer lease 丢失是 fencing event，而不是普通重试：旧 gateway 立即停止新
upstream/tool-proxy 调用；active attempt 进入 `recovering/ambiguous`。服务端不得把
已 accepted 的 attempt 当普通过期 inbox row 立即重派；新 holder 必须执行 takeover
并用 session ledger/replay 协调，证明前一 turn 未接受后才能 dispatch。

本地检查不能 fence 已在途 mutation。所有 CommHub/tool-proxy mutation 在服务端
commit 时必须携带并在同一 transaction 原子校验
`{runtimeInstanceId, consumerLeaseEpoch, reservationId, operationId}`；lease/active
reservation 任一已变化就不产生副作用。Phase 1 不给 Agent-origin turn 暴露无法做
此 commit-time fencing 的本地 side-effect tool。vendor 侧无法撤销的已在途 turn/cost
在失租后标记 ambiguous，不谎称已取消。

reply 使用稳定 `reply_operation_id = H(taskId, attemptId, completionGeneration)`；
服务端以 UNIQUE 约束实现幂等提交。HTTP/MCP response 丢失后的 retry 返回同一 reply，
不插入第二条、也不二次唤醒 originator。晚到的旧 lease completion 只能进入审计，
不能改变新 generation 的 task/result。

### 8.3 注册、心跳与 Dashboard

- canonical runtime 只定义一次共享 normalize helper，server 当前两份 runtime map
  必须收敛；aliases 只在入口 normalize。
- agent-node 的 heartbeat 读取 gateway 状态机，不能每三分钟固定报 `idle`；active
  turn 同时续 task lease。
- Dashboard 包增加 runtime union/vendor/icon/label/model preset；删除
  `alias.includes('grok') => grok-build-acp` 的猜测式 fallback。
- 验收不是只看 JSON：要在真实 Dashboard 创建/启动节点，验证 runtime badge、
  working/waiting/recovering/offline 与 node identity。

## 9. Child environment：从空对象构造

禁止 `env: process.env` 后做 denylist。每类 child 从空对象构造 frozen env；value
来自受类型约束的 runtime config，不从任意 parent key 拷贝。

初始候选 exact key set（Phase 0 通过真实启动后再冻结，不能擅自扩大）：

| Child | exact keys |
|---|---|
| Leader | `HOME`, `TMPDIR`, `LANG`, `LC_ALL`, `PATH` |
| ACP proxy | `HOME`, `TMPDIR`, `LANG`, `LC_ALL`, `PATH` |
| Native TUI | `HOME`, `TMPDIR`, `LANG`, `LC_ALL`, `PATH`, `TERM`, `COLORTERM` |

约束：

- 使用 absolute pinned Grok binary；`PATH` 是固定常量而非父值，若真实 probe 证明
  可移除则移除。
- `HOME`/`TMPDIR` 是该 node 的隔离目录；locale/terminal 是 reviewed 固定值。
- CA/proxy 若部署需要，必须作为显式 typed config 加入新 review，不能继承环境。
- 任何 `COMMHUB_*`、`DATABASE_URL`、`AWS_*`、`*_TOKEN`、`*_SECRET`、`*_KEY`、
  Grok/CommHub bearer，以及未在 exact set 的普通变量都不存在。
- CommHub 最小工具代理持 token；Grok 只连接 owner-only local endpoint，模型不能
  指定 identity、credential 或 raw Hub method。

测试既断言禁词，也断言 `Object.keys(childEnv)` 与 frozen set **完全相等**；再从
Docker 内读取 `/proc/<pid>/environ` 做独立 canary 证明，避免 helper 自测自己。

环境变量不是唯一配置入口。isolated HOME 由 manifest provision，默认只含：

- 最小 cached-auth artifact（由独立 importer 复制，0600，内容不进入日志）；
- runtime 生成且 schema 校验的 Grok config；
- 该 node 自己的 session/state 目录。

不复制 host 的通用 config、MCP、hooks、plugins、AGENTS 指令或任意未知文件；cwd 中
vendor config/AGENTS/MCP/hook 的发现行为必须先由 fixture 列出，再用 allowlist 显式
关闭或固定。路径逐级 lstat，拒绝 symlink/foreign owner/extra file。安全反例要用
poisoned HOME、cwd `.grok`、恶意 MCP/hook/plugin 和 argv/config canary，证明它们
不能绕过 env 边界连接 local proxy、改变 permission 或取得 CommHub 能力。

## 10. Phase 0：真实 0.2.93 抓包与 fixture 合同

实现前新增独立 Docker suite，所有 fixture 在 clean checkout 可一条命令重放。建议：

```text
tests/test223-grok-agent-leader-wire/
docs/tests/test223-grok-agent-leader-wire/
  manifest.json
  leader-acp-a.ndjson
  leader-acp-b.ndjson
  leader-native-tui.ndjson
  permission-routing.ndjson
  race-matrix.ndjson
  reconnect-matrix.ndjson
  serve-auth.ndjson
  report-test223.txt
```

每个 transport 同时保存原始 byte record 与独立 parsed projection。byte record 包含
`seq`、monotonic relative time、client role、transport、direction、原始 bytes（binary
用 base64）、read/write 边界、EOF/close/error、PID/generation、Leader PID/socket
dev+inode；parsed projection 保存 exact JSON payload 或已解析 IPC frame。fixture 必须
覆盖 split/coalesced/truncated/unknown frame，不能让待测 parser 只输出 JSON 后再用
自己的 JSON 证明自己正确。manifest 保存原始 version bytes、binary SHA-256、argv、
env key names、cwd/session 的稳定占位映射、redaction tool SHA-256 和逐 fixture hash。
只脱敏 token、账号、真实路径、正文/推理；framing、字段名、类型、缺失/存在、ID
关联和顺序必须保留，且 redaction 后 raw→projection 映射可由独立 parser 验证。

### 10.1 Fixture PII / credential 处理

- 未脱敏 capture 只存在于隔离 Docker 的 tmpfs，scrub 成功并完成 hash 后立即销毁；
  host artifact、git、CI log 和测试报告从不接收未脱敏 bytes。
- checked-in 的所谓 raw byte record 指 **sanitized transport bytes**，不是账号/token
  原文。Authorization、query secret、cached auth、account/email、session/cwd、文件
  内容、tool args/result、approval command/path 分别替换为稳定类型占位符，如
  `<BEARER_1>`、`<ACCOUNT_1>`、`<PATH_1>`、`<TOOL_ARG_1>`。
- reasoning/encrypted content 不落 fixture；只保留 method、字段 shape、枚举、长度类、
  ID 关联与必要的无害 marker。permission/approval fixture 使用临时目录和无害 canary，
  不引用真实仓库命令或文件。
- scrubber 使用预埋 canary 做正反例；独立 reviewer 再跑 secret/PII scanner，扫描
  JSON projection、base64 decoded bytes、HTTP headers、报告与 git diff。发现任一
  canary/账号/真实路径即整套失败，不允许手工删一行后宣称通过。

### 10.2 P0 必抓矩阵

1. initialize/auth success/failure、session new/load、load replay 边界、prompt 全事件与
   response 顺序、event/prompt/request identity、不同 session 隔离。
2. 人类 TUI → ACP observer 与 ACP → TUI 的双向 live fanout。
3. Leader native IPC：attach/resume/prompt/turn/permission/interrupt 的 framing；真实
   TUI 通过 gateway proxy 的 create/resume/render gate。
4. 同时 submit：human editing 未 Enter、human Enter vs Agent prompt、active human、
   active Agent、双 Agent、queued submitter disconnect/timeout，至少 100 轮。
5. permission：submitter/passive ACP/真实 TUI 三方谁收到、谁能回答；allow-once、
   reject、disconnect、恶意抢答和重叠 request。
6. prompt/inject/steer/cancel：每个 owner/non-owner request 的 exact success/error 与
   terminal event。未抓到的 method 不进入 runtime。
7. idle/active/pending-approval 下分别 kill ACP、observer、TUI、Leader、gateway；抓
   turn continuation、load replay、completion、stale socket 与 resume。
8. serve `/ws` query secret、Bearer、二者冲突、missing/wrong、`X-Server-Key`、Origin、
   wrong path、account auth、idle observer、active tail、owner disconnect、second prompt。

抓包作者不能签 protocol freeze；通信龙或另一 reviewer 从 clean checkout 重跑，
逐 hash 对比并确认 reducer/authorizer 只使用 fixture 中存在的字段。

## 11. 测试与反例矩阵

所有套件按环境 → auth → 单点协议 → 完整流程 → race/multi-user → security 分层；
前层失败不跑后层。每套独立 Dockerfile，报告保存到 `docs/tests/report-testN.txt`。

### 11.1 Runtime/协议

- exact binary/version/hash mismatch 在 spawn/socket 前 fail closed；
- fake/real protocol record-replay；unknown method/field 默认拒绝；
- 100 次 idle race、FIFO、queue limit、deterministic Busy、explicit interrupt；
- completion 只关联本 task，human turn 永不 reply；duplicate/replay 不二次完成；
- dispatch 各 crash point：receive、claim、before prompt、response lost、accepted、
  completed、reply pending；不静默丢、不盲重放。

### 11.2 Approval

- 正确 owner lease accept/reject；wrong/expired/stale lease 必须转红；
- 正确 lease + wrong session/task/turn/request 必须转红；
- duplicate response 不消费第二次；stale detach 不释放新 owner；
- 无 TUI、TUI 断线、timeout 都 fail closed；Agent face 无 approval method；
- forged owner 必须来自独立进程/credential，禁止同源 ctx 自填字段证明自己安全。

### 11.3 Env 与本地边界

- parent 注入 ntok、utok、全部 `COMMHUB_*`、DB、AWS、future arbitrary secret、
  prototype key 和普通未知 key；child key set 仍 exact；
- `/proc` 独立检查三个 child，argv/config/artifact 同时扫 secret canary；
- symlink、foreign uid、stale inode、PID reuse、second bridge、second TUI owner 全拒绝；
- 证明 runtime 未发出 send-keys/paste/buffer/stdin 注入。

### 11.4 CommHub 真 E2E

独立 Docker Hub + 两个不同 node principals：

```text
create grok node -> dashboard visible -> heartbeat
Agent A send_task -> server claim for Grok node -> ACP prompt
-> real TUI live -> exact completion -> send_reply(original task)
-> Agent A new_reply
```

同时验证：

- 合法但未获 shared-session admission 的独立 node B 发 task 被拒，Grok/TUI 零
  frame、human history 零泄露；策略 epoch 撤销后的 queued row 不 dispatch；
- B forged alias/nodeId=A 的 report/get/ack/SSE/reply/dead-letter 全 403，A row 不变；
- ntok 访问 token mint/revoke/admin endpoint 为 403；
- REST `body.from=A` 被拒或 DB sender 仍是 server-resolved B；
- 两 runtime 抢同 row 只有一个 lease 成功，旧 epoch reply/approval 转红；
- 网络分区导致 lease takeover 时，旧 gateway 的 late completion/tool call 被 fence，
  server commit-time fencing token 使 mutation 零落库，新 holder 不盲重派 accepted turn；
- `send_reply` response 丢失后用同一 operation id 重试，DB 仍只有一条 reply/一次 SSE；
- Agent-origin prompt 诱导调用 local tool proxy 被拒；stale/wrong-origin reservation
  capability 不能 `send_task/send_message`；
- SSE 断线时投递且之后无新 event，重连仍主动 drain backlog；
- turn 超过 heartbeat 周期时 Dashboard 始终为 working，不被固定 idle 覆盖；
- Agent-origin reply/proactive task 的 DB sender 均是 Grok node principal。

### 11.5 每条安全项必须先能转红

安全测试的验收不是“修完后跑绿”，而是同一个 production entry 必须有可复现的
pre-fix/mutation 红证据，再在修复后转绿。建议 mutation harness 至少包含：

| 控制 | 故意移除的单一硬门 | 必须出现的红结果 |
|---|---|---|
| env allowlist | 恢复继承一个 parent key | `/proc` canary 泄漏被抓 |
| server principal | 改为信 payload `from/alias` | 独立 B principal 冒充 A 被抓 |
| row consumer | 跳过 node/lease epoch CAS | B/旧 instance ACK 或 reply A row 被抓 |
| approval owner | 忽略 owner lease/turn/request 任一维度 | forged/stale allow 消费 pending 被抓 |
| input arbiter | 让 inject/steer 直达 Leader | active human turn 被修改或 Leader 出现 frame 被抓 |
| commit fencing | 跳过 lease/reservation/operation 校验 | takeover 后旧 mutation 落库被抓 |
| reply idempotency | 移除 operation UNIQUE | response-lost retry 产生双 reply/SSE 被抓 |
| sender admission | 跳过 policy epoch | 未授权 B 或 revoked queued row 进入 TUI 被抓 |

mutation 只存在于测试构建，不给生产留下 runtime bypass/feature flag。不能用同一个
helper 同时生成 auth context 和验证它；forged 值必须从真实 HTTP/MCP/socket 入口、
独立 credential/process 喂入。若测试在移除目标硬门后仍为绿，说明没测到控制，
该项不得签字。

### 11.6 数字与签字

- 只接受 committed clean-checkout 的单命令、exit code、raw report、fixture hash；
- ignored bundle、手工复制脚本、作者 worktree 路径、非零命令里的局部 PASS 都不计；
- fixture/unit 数字不得表述成 production-path E2E；
- 安全作者不能自签，reviewer 用自己新 mint 的 attacker token/marker 复跑。

## 12. 复用 Codex 与 Grok 新做边界

### 12.1 复用抽象/测试形状

| Codex 资产 | Grok 复用 |
|---|---|
| narrow typed Agent contract | `enqueue/get/cancel/subscribe`，不暴露 raw protocol |
| single admission / atomic reservation | human/agent/none + bounded FIFO + no implicit steer |
| durable ledger + ambiguous recovery | task/attempt 分离，response lost 不 blind resend |
| request mux / reverse namespace | ID 一次消费、approval 独立 namespace、close 原子 settle |
| human owner lease | provisional attach、lease/epoch、stale detach no-op、reconnect 新 generation |
| exact child env allowlist | 从空对象构造、key-set equality、`/proc` 独立反例 |
| server-stamped principal | alias/from 仅显示，token context 才是授权 |
| real attacker negative tests | 跨 alias/row/lease/approval 必须从独立 bearer 进入真实 handler |
| clean-checkout evidence gate | 一条命令、raw artifact、独立 reviewer |

### 12.2 不复用、Grok 必须新做

- Leader native IPC、TUI attach/resume、ACP broadcast/session_update 和 permission wire；
- hidden `--leader` 版本/真实 render gate；
- Leader PID/socket/inode lifecycle 与 no-exit-on-disconnect；
- Grok prompt/update/completion/replay reducer；
- approval routing 与 human response 可行性；
- human/network race、queue/cancel/interrupt 的 0.2.93 语义；
- isolated Grok HOME/auth/session 和 Grok-specific tool capability；
- `agent serve` bearer/auth 的边界 fixture。

### 12.3 Codex 代码中明确禁止复制的部分

- B 的 denylist `scrubSpawnEnv`；
- 尚未绑定 server-resolved consumer 的 alias inbox/ACK/dead-letter；
- 未接入真实 transport 的 reconnect/approval 单测；
- 只清 request map、不 reject pending promise 的 `drainAll()`；
- 与真抓包冲突的 wire field；
- 手工 ACK 或用 `send_task` 代替 production `send_reply` 的假闭环；
- 未通过独立评审的测试数字和“PASS”表述。

## 13. Runtime 产品接线（设计批准后）

canonical runtime `grok-agent-leader` 需要同步：

- agent-node runtime enum/map/dispatch/capability/status；
- agent-network normalize、wizard、start/attach/doctor 与 session config；
- server create-node allowlist、status/tools 的共享 runtime normalize；
- goal/runtime bucket；
- Dashboard 独立包的 runtime union/vendor/icon/label/model preset/fallback；
- 中英文 docs、release notes、version compatibility table。

旧 `grok-build-acp` 与 `grok-build-cli` 保持兼容，不把 `grok-tui` 旧 alias 静默改指向
新 runtime。迁移必须显式；旧 PTY `grokCopresence:true` 标记为 experimental/
superseded，避免同名配置被错误升级。

拟议配置：

```yaml
runtime: grok-agent-leader
grok:
  binary: /absolute/pinned/grok
  version: 0.2.93
  binary_sha256: <frozen>
  cwd: /workspace
  session_binding: runtime-created
  permission_profile: phase1-never
  tui_attach: owner-only
```

Leader socket、attach socket、consumer lease、runtime instance 和 CommHub credential
均由 runtime 生成/解析，不允许配置文件传入可共享 raw secret。

session ID 也不接受普通配置任意指定。首次启动由 runtime 在 isolated HOME/cwd 内
创建并与 `{nodeId, cwd identity, grok-home identity, ledger generation}` 原子绑定；
后续 resume 必须验证全部绑定。导入已有 session 是独立、显式、离线 migration：
暂停队列、验证来源/owner、复制到隔离目录、重建绑定并由人类确认。错误 cwd、其他
node 的 session、伪造 ledger 或只有 UUID 相同均拒绝，防止跨节点历史串线。

## 14. 分阶段与 release gates

### Phase 0 — protocol/design freeze

- 完成 §10 全量 raw capture；
- 证明 native TUI 可经 gateway proxy create/resume/render；
- 确认 approval/race/reconnect 的真实边界；
- 通信龙 review 并冻结 contract、fixture hashes 与 no-go 条件。

### Phase 1A — gateway core

- typed contract、native IPC proxy、ACP adapter、scheduler、ledger、owner lease；
- exact env builder、version/socket gates；
- unit + fixture replay + real 0.2.93 Docker tests。

### Phase 1B — CommHub safety primitives

- immutable node principal、capabilities、self SSE、atomic row claim/lease；
- server-derived sender/reply、strict audit/dead-letter transaction；
- real independent attacker counterexamples。

### Phase 2 — product plumbing and E2E

- runtime/CLI/server/dashboard wiring；
- real Hub + Grok + true TUI end-to-end；
- reconnect/crash/slow-client/backpressure/long-turn matrix；
- docs and operator attach/recovery workflow。

### Phase 3 — independent security/release review

- reviewer clean-checkout 重跑全部 hard gates；
- 所有 P0/P1 finding 关闭后，Vincent 单独批准 merge、preview publish、deployment
  与 `latest`；本设计通过不等于发布授权。

## 15. 需要本轮 review 拍板的问题

1. 是否接受 canonical runtime `grok-agent-leader`，并保留旧 Grok runtimes 不做
   静默 alias 迁移？
2. 是否同意“可解析 native Leader IPC 的 single admission gateway”是生产硬门；
   解析/代理失败即 production no-go？
3. Phase 1 是否接受 Agent turn `approval=never`，把人类审批外部 ACP turn锁到真实
   routing fixture 通过后的 Phase 2？
4. 是否接受 Agent reservation 下 human start/steer 固定 Busy、绝不 hold/queue/
   reinterpret，且 explicit human interrupt 是唯一抢占路径；真实 TUI 不兼容即 no-go？
5. 是否把 CommHub immutable principal + row-consumer lease 纳入本 runtime 的发布
   blocker，而不是沿用当前 alias-based get/ack/reply？
6. 是否接受 Phase 1 同 uid 本地进程可信；若不接受，则从一开始改为独立 OS user/
   container boundary？

## 16. 评审后的初步工期

在本设计获批且不发生 no-go 的前提下：

- Phase 0 完整抓包、脱敏 fixture、独立复跑：约 0.5–1 个工程日；
- gateway core + runtime adapter：约 2 个工程日；
- CommHub principal/lease + product wiring：约 1.5–2 个工程日；
- Docker E2E、race/crash/security 矩阵与独立复核：约 1–1.5 个工程日。

任何 approval/native IPC fixture 推翻拓扑时立即停在 Phase 0 重审，不用“已经写了很多”
作为继续错误架构的理由。

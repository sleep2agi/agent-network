# RFC-010: Agent Network Node Lifecycle

| 字段 | 值 |
|------|----|
| **RFC 编号** | 010 |
| **标题** | Node Lifecycle — 节点完整生命周期协议（含 node rename） |
| **作者** | 通信SDK马 |
| **状态** | Draft v1（进行中） |
| **创建日期** | 2026-05-14 |
| **关联 issue** | [#80 Node lifecycle umbrella](https://github.com/sleep2agi/agent-network/issues/80) · [#84 node rename](https://github.com/sleep2agi/agent-network/issues/84) |
| **关联 bug** | [#74 节点删除后 dashboard 残留](https://github.com/sleep2agi/agent-network/issues/74) |
| **依赖** | RFC-003 node telemetry · RFC-008 multi-agent-team-convention · batch primitive (preview.8) |
| **审阅** | 通信牛（server-side commhub 影响）· 通信龙（high-level）· Vincent（final） |

---

## 摘要

anet 节点（node）的生命周期目前分散在 CLI、commhub server、dashboard 三个 surface，缺少统一协议规范：状态机转换是否原子、SSE 事件 taxonomy 不统一、节点崩溃后状态可能 stuck、且 **节点改名（rename）完全缺失**。本 RFC 提出统一的 Node Lifecycle 协议，覆盖 create/start/stop/restart/delete/**rename**/list/status 八个操作，重点深挖 node rename（issue #84，Vincent 4505 push）这一 cross-cutting、风险密集的新操作。

本 RFC 不实施任何 cli.ts / server 改动，仅设计方案（per /loop directive + RFC author boundary）。中文正文，code/API 例子保留英文（per [[feedback_rfc_chinese]]）。

---

## §1 背景与完整 lifecycle scope

### 1.1 起源

| 时间 | 触发 | 关键诉求 |
|------|------|---------|
| 2026-05-14 4480+4481 | Vincent "你先推进吧 / 关于 node 的生命周期" | Node lifecycle umbrella（issue #80，RFC-010 候选） |
| 2026-05-14 4505 | Vincent push node rename | "出方案 + 不引入新 BUG + 考虑全面 + 充分测试"（issue #84） |
| 2026-05-14 4549 | Vincent "go" — P1 队列 dispatch | RFC-010 方案设计 fold-in /loop |

本 RFC 把 #80（umbrella）与 #84（rename）合并为单一 RFC-010：node rename 是 lifecycle 操作子集，独立成 RFC-011 会造成 RFC 增殖（per #77 dedup 教训）。rename 与 umbrella 共享核心关切（状态机原子性 / SSE taxonomy / 多 surface 一致性），合并设计更内聚。

### 1.2 完整 lifecycle scope — 8 操作

| 操作 | CLI 命令 | 现状 | 本 RFC 定位 |
|------|---------|------|------------|
| **create** | `anet node create <alias>` | ✅ 已 ship (PR-history) | spec 补全 |
| **start** | `anet node start <alias>` | ✅ 已 ship | spec 补全 |
| **stop** | `anet node stop <alias>` | ✅ 已 ship | spec 补全 |
| **restart** | `anet node restart <alias>` | 🟡 部分（stop+start 组合？） | spec 明确 + 原子化 |
| **delete** | `anet node delete <alias>` | ✅ 已 ship，但有 bug #74 | spec 补全 + bug 修复方案 |
| **rename** | `anet node rename <old> <new>` | 🚫 完全缺失 | **全新设计（§4 flagship）** |
| **list** | `anet node list` | ✅ 已 ship | spec 补全 |
| **status** | `anet node status <alias>` | ✅ 已 ship | spec 补全 |

定位说明：
- **spec 补全**：操作已实现，但缺少跨 3 surface 的协议规范（状态转换、SSE 事件、错误处理）。本 RFC 补规范，不重写实现。
- **spec 明确 + 原子化**：restart 当前可能是 stop+start 朴素组合，本 RFC 明确其原子语义。
- **全新设计**：rename 完全不存在，§4 给出完整 cross-cutting 设计。

### 1.3 三 surface 协同

node lifecycle 跨 3 surface，每个操作都需三方协同：

| Surface | Owner | 职责 |
|---------|-------|------|
| **CLI** | 工程马 | `anet node <verb>` 命令、本地 `.anet/nodes/<alias>/` 目录、tmux session 管理 |
| **Server / commhub** | 通信牛 | node 注册表、state machine、SSE event broadcast、utok/ntok 绑定 |
| **Dashboard** | N站马 | node 可视化（online/offline/blocked/error）、SSE event 消费、alias 头像 |

### 1.4 现状分析 — 已 ship / 已知 gap / 缺失

**✅ 已 ship**（issue #80 现状分析）：
- `anet node create / delete / start / stop`（CLI）
- `anet batch <verb>`（batch primitive，preview.8）
- Dashboard tiered ring（preview.81）+ alias avatar（preview.82）
- Node SSE online/offline status（Dashboard）

**🟡 已知 gap / bug**：
- **#74**：节点删除后 dashboard 残留（delete event SSE 不到位 / dashboard cache 不 invalidate）
- node state machine 不一致：created → started → stopped → restarted → deleted 状态转换是否真 atomic 未验证
- delete 后 commhub 仍有该 node 的 stale entries（server-side cleanup 缺失）
- batch lifecycle（`anet batch stop/cleanup`）与 single node lifecycle（`anet node stop/delete`）一致性 — 用户认知混淆

**🚫 缺失**：
- 完整 node lifecycle 协议 spec（本 RFC）
- SSE event taxonomy（create/start/stop/restart/delete/rename 统一 channel + payload schema）
- error recovery（node crash → state 不 stuck）
- inter-node dependency lifecycle（sci-team / opinion-spread leader 死了 worker 怎么办）
- **node rename**（issue #84）

### 1.5 为什么需要统一 RFC

**问题：操作已实现，但协议没规范。**

当前每个操作的 CLI / server / dashboard 行为是各自演进的，导致：
1. **状态不一致**：CLI 认为节点已 delete，commhub 仍有 stale entry，dashboard 仍显示（#74）
2. **事件不统一**：没有 SSE event taxonomy，dashboard 靠轮询或零散事件推断状态
3. **错误恢复缺失**：node crash 后状态可能 stuck 在 `started`，无自动恢复
4. **rename 无从下手**：alias 是 cross-cutting identifier，没有协议规范根本不敢做 rename

统一 RFC-010 把 8 操作的三 surface 行为规范成单一协议，使：
- 状态机有单一真相源（§2）
- 所有操作发统一 SSE 事件（§3）
- rename 这种 cross-cutting 操作有据可依（§4）
- 错误恢复有明确策略（§5）

### 1.6 alias 作为 cross-cutting identifier — rename 难点预览

node alias 被 7 个 surface 引用（issue #84 详列），这是 §4 的核心，此处预览：

| Surface | alias 用途 | rename 影响 |
|---------|-----------|-----------|
| 本地 config | `.anet/nodes/<alias>/config.json` 目录名 + `config.alias` 字段 | 目录 rename + 字段更新 |
| tmux session | session 名 = alias（或 alias-derived） | `tmux rename-session` |
| commhub registration | hub 上 node 注册 alias + utok/ntok 绑定 | hub-side rename API 或 re-register |
| commhub messages 历史 | 历史 message sender/recipient = old alias | 历史不可变 — old alias 引用如何处理 |
| dashboard | node visual + alias 头像（preview.83） | SSE re-render，alias 头像 hash 变 |
| batch lifecycle | `anet batch stop <prefix>` 按 prefix match | rename 跨 prefix → batch grouping 变 |
| session resume | `anet resume` 找 session by alias | resume 映射更新 |

7 风险点（§4 详 mitigation）：in-flight write race / active node rename / 重名冲突 / utok-ntok 绑定 / 历史引用 / race condition / batch prefix grouping。

### 1.7 §1 小结

RFC-010 统一 8 个 node lifecycle 操作的三 surface 协议。其中 create/start/stop/delete/list/status 已 ship，本 RFC 补 spec；restart 明确原子语义；**rename 是全新设计，§4 flagship**。核心驱动是当前"操作已实现但协议没规范"导致的状态不一致（#74 bug 是典型症状）。

§2 设计 node state machine；§3 设计 SSE event taxonomy；§4 深挖 node rename；§5 error recovery + inter-node dependency；§6 实施 Phase ladder。

---

## §2 Node state machine

### 2.1 状态定义

node 的生命周期由一个有限状态机（FSM）描述。本 RFC 定义 6 个状态：

| 状态 | 含义 | dashboard 显示 |
|------|------|---------------|
| `created` | 节点已创建（`.anet/nodes/<alias>/` 目录 + config.json 存在），但未启动 | 灰色（offline） |
| `starting` | 启动过渡态（tmux session 拉起中、commhub 注册中） | 黄色（pulsing） |
| `running` | 节点活跃（tmux session 在、commhub 已注册、可收任务） | 绿色（online） |
| `stopping` | 停止过渡态（任务收尾、tmux session 关闭中） | 黄色（pulsing） |
| `stopped` | 节点已停止（目录保留，tmux session 不在，commhub 标记 offline） | 灰色（offline） |
| `error` | 异常态（crash / 启动失败 / 状态不一致） | 红色（error） |

`deleted` 不是一个状态——delete 操作完成后节点不再存在于状态机中（目录删除、commhub 注销）。但 delete *过程* 经过 `deleting` 过渡态（见 2.3）。

### 2.2 状态转换图

```
                 create
                   │
                   ▼
              ┌─────────┐
         ┌───►│ created │◄──────────────┐
         │    └────┬────┘               │
         │         │ start              │ (stop from stopped is no-op)
         │         ▼                    │
         │    ┌──────────┐              │
         │    │ starting │              │
         │    └────┬─────┘              │
         │         │ (ready)            │
         │         ▼                    │
         │    ┌─────────┐   stop   ┌──────────┐
         │    │ running │─────────►│ stopping │
         │    └────┬────┘          └────┬─────┘
         │         │                   │ (clean)
         │         │ restart           ▼
         │         │              ┌─────────┐
         │         └─────────────►│ stopped │
         │       (atomic stop+start)└───┬────┘
         │                             │ delete
         │                             ▼
         │                        ┌──────────┐
         │                        │ deleting │──► (gone)
         │                        └──────────┘
         │
         │  any state ──(crash/失败)──► ┌───────┐
         └──────────────(recover)──────│ error │
                                       └───────┘
```

### 2.3 转换表（含三 surface 动作）

| 转换 | 触发 | CLI 动作 | Server 动作 | Dashboard 动作 |
|------|------|---------|-------------|---------------|
| `∅ → created` | `node create` | 建 `.anet/nodes/<alias>/` + config.json | commhub 注册 node（offline） | SSE `node.created` → 渲染灰节点 |
| `created → starting` | `node start` | 拉起 tmux session | 标记 `starting` | SSE `node.starting` → 黄 pulsing |
| `starting → running` | tmux ready + commhub heartbeat | — | 标记 `running` | SSE `node.started` → 绿 |
| `running → stopping` | `node stop` | 发停止信号、等任务收尾 | 标记 `stopping` | SSE `node.stopping` → 黄 pulsing |
| `stopping → stopped` | tmux session 关闭 clean | kill tmux session | 标记 `offline` | SSE `node.stopped` → 灰 |
| `running → running` | `node restart` | **原子** stop+start（见 2.4） | 标记 `restarting` → `running` | SSE `node.restarting` → `node.started` |
| `stopped → deleting → ∅` | `node delete` | 删 `.anet/nodes/<alias>/` 目录 | **注销 node + cleanup stale entries** | SSE `node.deleted` → **移除节点（修 #74）** |
| `* → error` | crash / 启动失败 / 一致性检查失败 | 检测并标记 | 标记 `error` | SSE `node.error` → 红 |
| `error → created/stopped` | `node recover`（§5） | 清理残留 + 回到安全态 | 标记 recover | SSE `node.recovered` |

### 2.4 原子性要求

状态机的核心要求是**转换原子化**——避免 #74 那类"CLI 认为 deleted，dashboard 仍显示"的不一致。

#### 2.4.1 原子转换协议

每个状态转换遵循 **两阶段提交（2PC）** 风格协议：

```
1. PREPARE:  CLI 写本地状态文件 .anet/nodes/<alias>/state.json = { state: "<new>", txn_id, ts }
             （单文件原子写：write tmp + rename，POSIX rename 原子）
2. COMMIT:   CLI 调 commhub state-transition API（携带 txn_id）
             commhub 更新注册表 + broadcast SSE event
3. ACK:      commhub 返回 ack，CLI 标记 txn 完成
4. (失败回滚): 任一步失败 → CLI 用 txn_id 回滚本地 state.json
```

关键点：
- **本地 state.json 单文件原子写**：`write(tmp)` + `rename(tmp, state.json)`，POSIX `rename(2)` 保证原子，杜绝 in-flight 读到半写状态。
- **txn_id 关联**：每次转换生成 txn_id，三 surface 用同一 txn_id，便于追踪 + 回滚 + 幂等。
- **SSE event 携带 txn_id**：dashboard 收到后可去重（同 txn_id 重复事件忽略）。

#### 2.4.2 restart 的原子语义

`node restart` 不是朴素的 `stop` + `start` 两条命令——中间的 `stopped` 窗口期如果有任务到达会丢失。原子 restart：

```
restart(alias):
  txn_id = new()
  PREPARE: state.json = { state: "restarting", txn_id }
  commhub: 标记 restarting（此期间该 node 的入站任务 → 排队不丢弃）
  CLI: graceful stop tmux session（等当前任务收尾，超时强杀）
  CLI: 立即 start 新 tmux session
  commhub: heartbeat 确认 → 标记 running，flush 排队任务
  COMMIT: state.json = { state: "running", txn_id }
  SSE: node.restarting → node.started（同 txn_id）
```

`restarting` 期间 commhub 对该 node 的入站任务**排队而非丢弃**，是与朴素 stop+start 的关键区别。

### 2.5 状态一致性校验

为防止三 surface 漂移，定义周期性一致性校验（reconciliation）：

```yaml
reconciliation_R010_§2:
  触发: 每 30s（可配） OR node 操作前
  
  CLI 侧真相: .anet/nodes/<alias>/state.json
  Server 侧真相: commhub 注册表
  实际真相: tmux session 是否存在
  
  校验逻辑:
    state.json=running 但 tmux session 不在  → 标记 error（crash 检测）
    state.json=running 但 commhub=offline   → 重新注册 OR 标记 error
    state.json=stopped 但 tmux session 还在  → 清理残留 session
    commhub 有 entry 但 .anet/nodes/<alias>/ 不存在 → commhub cleanup（修 #74 根因）
  
  不一致 → 发 SSE node.error 或自动 recover（§5）
```

### 2.6 #74 bug 在状态机框架下的根因与修复

issue #74「节点删除后 dashboard 残留」在状态机框架下的根因清晰：

```yaml
bug_74_root_cause_R010_§2:
  现象: node delete 后 dashboard 仍显示该节点
  
  根因:
    delete 操作只做了 CLI 侧（删目录）+ 部分 server 侧
    没有可靠地 broadcast node.deleted SSE event
    dashboard cache 不 invalidate
  
  状态机框架下的修复:
    delete 走 stopped → deleting → ∅ 转换
    deleting 阶段 COMMIT 必须包含:
      1. commhub 注销 node + cleanup ALL stale entries（含历史 message 索引）
      2. broadcast node.deleted SSE event（携带 txn_id）
      3. dashboard 收 node.deleted → 移除节点 + invalidate cache
    任一步失败 → 转 error 态，reconciliation（2.5）兜底清理
  
  → #74 不是单点 patch，而是 delete 转换纳入原子协议后自然修复
```

### 2.7 §2 小结

node lifecycle 由 6 状态 FSM（created/starting/running/stopping/stopped/error）+ deleting 过渡态描述。每个转换走两阶段提交协议（本地 state.json 原子写 + commhub COMMIT + SSE ACK + txn_id 关联），保证三 surface 一致。restart 是原子 stop+start（restarting 期间任务排队不丢）。周期性 reconciliation 校验三 surface 漂移。#74 bug 在此框架下根因清晰——delete 转换纳入原子协议后自然修复。

§3 设计 SSE event taxonomy（§2 多次引用的 `node.*` 事件的统一 channel + payload schema）。

---

## §3 SSE event taxonomy

### 3.1 现状问题

当前 dashboard 的 node 状态更新依赖零散信号（online/offline heartbeat、轮询），没有统一的事件协议。后果：
- delete 事件不可靠（#74 根因之一）
- 没有 restart / rename 事件——dashboard 无从知道节点改名
- 事件 payload 不统一，dashboard 解析逻辑分散
- 无去重机制，重复事件导致 UI 抖动

§3 定义统一的 SSE event taxonomy：单一 channel、统一 envelope、每个 lifecycle 操作一个事件类型。

### 3.2 统一 envelope

所有 node lifecycle SSE 事件共享一个 envelope：

```typescript
interface NodeLifecycleEvent {
  // 事件标识
  event: NodeEventType;          // 见 3.3
  txn_id: string;                // §2 两阶段提交的 txn_id —— 去重 + 关联
  ts: string;                    // ISO8601 北京时间 (per feedback_beijing_time)

  // 节点标识
  alias: string;                 // 节点 alias（rename 事件特殊，见 3.4）
  ntok: string;                  // 节点所属网络（多租户隔离）

  // 状态
  prev_state: NodeState | null;  // 转换前状态（created 事件为 null）
  next_state: NodeState | null;  // 转换后状态（deleted 事件为 null）

  // 附加 payload（事件特定，见 3.3）
  data?: Record<string, unknown>;
}

type NodeState = 'created' | 'starting' | 'running'
               | 'stopping' | 'stopped' | 'error';
```

设计要点：
- **txn_id 去重**：dashboard 维护 `seen_txn_ids` LRU set，同 txn_id 重复事件直接丢弃——杜绝 UI 抖动。
- **ntok 多租户**：dashboard 按 ntok 过滤，多网络隔离渲染。
- **prev/next state**：dashboard 不需自己推断状态转换，envelope 直接给。

### 3.3 事件类型表

| `event` | 触发转换（§2） | `data` 附加字段 | dashboard 动作 |
|---------|---------------|----------------|---------------|
| `node.created` | `∅ → created` | `{ config_summary }` | 渲染灰节点 |
| `node.starting` | `created → starting` | — | 黄 pulsing |
| `node.started` | `starting → running` | `{ tmux_session, pid }` | 绿节点 |
| `node.stopping` | `running → stopping` | `{ reason }` | 黄 pulsing |
| `node.stopped` | `stopping → stopped` | `{ exit_clean: bool }` | 灰节点 |
| `node.restarting` | `running → restarting` | `{ queued_tasks: number }` | 黄 pulsing + "restarting" |
| `node.restarted` | `restarting → running` | `{ tmux_session, pid, flushed_tasks }` | 绿节点 |
| `node.deleted` | `deleting → ∅` | `{ cleanup_summary }` | **移除节点 + invalidate cache（修 #74）** |
| `node.renamed` | rename（§4） | `{ old_alias, new_alias, surfaces_updated }` | **alias 头像 re-render + 历史引用标注** |
| `node.error` | `* → error` | `{ error_type, detail, recoverable: bool }` | 红节点 + alert |
| `node.recovered` | `error → created/stopped` | `{ recovered_to: NodeState }` | 对应状态色 |

11 个事件类型，覆盖 §2 状态机的全部转换。

### 3.4 `node.renamed` 事件的特殊性

rename 事件（§4 深挖）在 envelope 上有特殊处理——`alias` 字段语义模糊（old 还是 new？），所以：

```typescript
// node.renamed 事件的 envelope 约定:
{
  event: 'node.renamed',
  txn_id: '...',
  alias: '<new_alias>',          // alias 字段统一用 NEW（事件后的真相）
  prev_state: <unchanged>,        // rename 不改状态
  next_state: <unchanged>,        // prev === next
  data: {
    old_alias: '<old>',
    new_alias: '<new>',
    surfaces_updated: ['config', 'tmux', 'commhub', 'dashboard',
                       'batch_prefix', 'session_resume'],
    history_policy: 'preserve'    // 历史 message 的 old_alias 引用策略（§4）
  }
}
```

dashboard 收到 `node.renamed`：
1. 把 old_alias 节点的 visual 迁移到 new_alias（不是删旧建新——保留位置/连线）
2. alias 头像 hash 基于 new_alias 重算（preview.83 头像机制）
3. 历史 message 视图中 old_alias 引用加 tooltip "→ renamed to new_alias"

### 3.5 SSE channel 设计

```yaml
sse_channel_R010_§3:
  endpoint: GET /api/events/nodes?ntok=<ntok>
  
  channel 模型:
    单一 channel: 所有 node lifecycle 事件走 /api/events/nodes
    按 ntok query param 过滤（server 侧过滤，不是 client 侧）
    
  vs 现状:
    现状: online/offline 零散信号 + 轮询
    新: 单 channel + 11 事件类型 + 统一 envelope
  
  断线重连:
    SSE Last-Event-ID 标准机制
    server 保留最近 N 个事件（ring buffer）
    重连时 replay 漏掉的事件（txn_id 去重保证幂等）
  
  心跳:
    server 每 15s 发 SSE comment ping（: keepalive）
    防中间代理超时断连
```

### 3.6 与 RFC-003 telemetry 的关系

```yaml
rfc003_relation_R010_§3:
  RFC-003 node telemetry: 节点的性能/资源指标（CPU/mem/token）
  RFC-010 §3 SSE taxonomy: 节点的生命周期状态事件
  
  两者互补, 不重叠:
    telemetry = 连续度量（时序数据）
    lifecycle event = 离散转换（状态变更）
  
  dashboard 同时消费:
    lifecycle event → 节点存在性 + 状态色
    telemetry → 节点内部指标（进度条/资源图）
  
  可共用 SSE 基础设施:
    建议 /api/events/nodes（lifecycle）与 /api/events/telemetry 分 channel
    避免高频 telemetry 淹没低频 lifecycle 事件
```

### 3.7 与 R483 SDK event-bridge 的关系

```yaml
sdk_eventbridge_relation_R010_§3:
  R483 (issue #18 /loop synthesis): SDK SDKMessage → anet event bus
  RFC-010 §3: anet node lifecycle → dashboard SSE
  
  层次关系:
    SDK SDKMessage (session_state_changed 等)
      → R012 adapter 翻译
      → anet 内部 event bus
      → 部分映射为 node lifecycle 转换（§2）
      → 触发 §3 SSE 事件
  
  例: SDK session_state_changed: 'idle'→'running'
      → anet 可据此辅助判断 node running 状态（与 tmux/heartbeat 三方校验）
      → 不直接驱动, 作为 reconciliation（§2.5）的一个信号源
  
  → §3 SSE 是 anet 自己的 node 抽象层, SDK event 是 R012 内部细节, 不外泄到 dashboard
```

### 3.8 §3 小结

统一 SSE event taxonomy：单 channel（`/api/events/nodes`，按 ntok 过滤）、统一 envelope（含 txn_id 去重 + prev/next state + ntok 多租户）、11 个事件类型覆盖全部状态机转换。`node.renamed` 事件 envelope 特殊处理（alias 用 new、data 含 old/new + surfaces_updated）。断线重连用 SSE Last-Event-ID + ring buffer replay。与 RFC-003 telemetry 互补分 channel，与 R483 SDK event-bridge 是上下层关系（SDK event 不外泄 dashboard）。

§4 深挖 node rename（flagship）——本节多次引用的 rename 操作、`node.renamed` 事件、7 surface 一致更新的完整设计。

---

## §4 Node rename 深挖（flagship — issue #84）

> 🚧 待 R499+ /loop tick 推进

---

## §5 Error recovery + inter-node dependency

> 🚧 待 R500+ /loop tick 推进

---

## §6 实施 Phase ladder

> 🚧 待 R501+ /loop tick 推进

---

## 附录

### A. 关联 issue

- [#80 Node lifecycle umbrella](https://github.com/sleep2agi/agent-network/issues/80)
- [#84 node rename](https://github.com/sleep2agi/agent-network/issues/84)
- [#74 节点删除后 dashboard 残留](https://github.com/sleep2agi/agent-network/issues/74)

### B. 变更记录

| 版本 | 日期 | 作者 | 说明 |
|------|------|------|------|
| Draft v1 §1 | 2026-05-14 | 通信SDK马 | 初稿 §1（背景 + 8 操作 scope + 现状分析 + rename 难点预览），§2-§6 stub 待续 |

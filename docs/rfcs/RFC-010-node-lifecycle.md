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

> 🚧 待 R497+ /loop tick 推进

---

## §3 SSE event taxonomy

> 🚧 待 R498+ /loop tick 推进

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

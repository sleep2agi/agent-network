# agent-node 2.5.0-preview.77

`.76` 之后 `agent-node/` 一个提交:

| 提交 | PR | 内容 |
|---|---|---|
| 1236501a | #1945 | codex 队列行**出队前先问 hub 还在不在**,已被 ack / 已终态的行不再白跑一个 turn(#1930) |

(同期还有 #1944,只改 `docs-site/`,不进本包。)

## 本版修的是什么

`codex-app-server` 是串行队列。一条入件如果到达时正有 turn 在跑,就排在 FIFO 里等。此前**排队中的行不随外部状态变化**:模型在这期间用 `ack_inbox` 把它在 hub 上确认掉了、或它在 hub 上已终态,FIFO 里那一行照样在下一次空闲时出队并跑完一个 turn —— 运行时要到 turn 结束后去摘那行时才发现 `already acknowledged`,记一行 WARN。现场(某台 codex 节点)每条这样的行白吃一个 turn;一次积压 6 条就是 6 个 turn。

🔴 这**不是「重投」**:每条行只有 1 次 `queued` 和 1 次 `task_started`,它只是在本地队列里活过了 hub 侧的 ack。`.76` 修的是「终态路径不摘 FIFO 行」(#1939),本版修的是同一根的另一面:「hub 侧状态变了、FIFO 行不知道」。

**改法**:bridge 在 `shift()` 之后、`startTaskTurn` 之前问 hub 一次该 inbox 行是否仍 pending;**看得见它已经不在** ⇒ 发 `task_skipped {reason:"not-pending-on-hub"}`、不起 turn、不回件、不标 failed,直接处理下一行。**只查排队过的行**;到达即开跑的行永远不查(到达与开跑之间没有外部状态能变)。

**为什么放在出队而不是本地账本**:codex-app-server 节点把 hub 的 MCP 端点直接交给模型,模型的 `ack_inbox` **不经过 agent-node**,本地账本根本观测不到它 —— 「写本地账本」这个选项不存在。出队是唯一覆盖所有入口(模型 ack / 别的进程 ack / hub 侧过期)的位置。

**fail-open,刻意的**:检查抛错或超时 ⇒ 起 turn;页满(100 条)看不到目标行、无法证明它不在 ⇒ 起 turn;只有**确证已不在**才跳过。把「静默重复」修成「静默丢件」是更糟的缺陷。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.77
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.101 @sleep2agi/agent-node@2.5.0-preview.77
```

🔴 **两个包要一起升。** 配对是精确的(`.101 ↔ .77`);共享登录态检测那份模块逐字节相同地存在于两个包里,两条启动路径各用各的那份。本版的队列修复只在本包(agent-node)里,`agent-network@.101` 是配对 bump。

## 证据

- 已 ack 的排队行:hub 答「不在」⇒ `turn/start` 计数停在 1,发 `task_skipped {taskId, reason:"not-pending-on-hub"}`,bridge 回到 idle。**该用例在 main 上为红**(没有门时第二次 `turn/start` 照发),改后绿。
- 🔴 **从未 ack 的排队行必须照常起 turn**:hub 答「还在」⇒ 第二次 `turn/start`;hub 检查**抛错** ⇒ 第二次 `turn/start`;没配门 ⇒ 第二次 `turn/start`。三条全绿 —— 这是「别把重复修成丢件」那一向。
- 被跳过的行不挡它后面那行;到达即开跑的行从不触发 hub 检查;跳过时 `cancelQueuedTask` 调用 0 次、不打 #1935 那条「行可能仍会执行」日志(行是 bridge 自己摘的)。
- agent-node 全套 1887 pass / 0 fail;typecheck 棘轮 81 = 基线;test587/test588 的 12 处变异锚仍各命中一次;#1935/#1937/#1939 的用例仍绿。
- 纯判定函数 `decideQueuedRowStart`:列表里有 ⇒ start;不在且页未满 ⇒ gone;不在但页满 ⇒ 无法证明不在 ⇒ start;读不到 ⇒ start。

## 未覆盖(明写)

- turn **已经开始之后**才被 ack 的行 —— 那是 #1900 的语义,不在本版。
- 同一节点未 ack 行超过 100 条、目标行在页外 ⇒ fail-open 起 turn;精确回答需要 hub 提供按 inbox id 查询的端点,本版未加。
- hub 检查超时/出错 ⇒ 起 turn。

## 披露

`@sleep2agi/agent-network` 的 `2.3.0-preview.97` 至 `.99`(配对本包 `.73`–`.75`)的 `dist/src/*.d.ts` 注释中含有合作团队的节点别名(分别 10 / 10 / 12 处);自 `.100`/`.76` 起已改为中性表述。本包(agent-node)的 bundle 会剥注释,`.73`–`.75` 的产物内不含。旧版本**不撤包**:撤包会打断所有钉了版本的使用者,代价大于暴露面。

## promote 时的 must_contain

`"version": "2.5.0-preview.77"`

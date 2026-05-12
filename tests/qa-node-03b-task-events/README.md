# qa-node-03b-task-events

**Matrix cell**: NODE-03b（新增）— task_events 审计追踪。

**Layer**: L1 contract（用户视角，黑盒）。

**Why it matters**: `task_events` 是合规 / debugging 资产 —— SRE 排查、安全审计、用户客服都要查
「这个 task 经历了什么、谁动的」。之前**完全没人测**。
现在 pin 死 schema + 归属 + 顺序，hub 状态机改动时立刻显形。

## Run

```bash
sg docker -c 'docker build -t anet-qa-node-03b -f tests/qa-node-03b-task-events/Dockerfile .'
sg docker -c 'docker run --rm anet-qa-node-03b'
```

预算：cold ~30s，warm ~11s。

## 9 步覆盖

| # | Scenario | 期望事件链 |
|---|---------|----------|
| [2-3] | A: 全成功链 | `delivered:admin` → `acked:agent-3b` → `replied:agent-3b` |
| [4]   | B: 直接失败（不 ack） | `delivered:admin` → `failed:agent-3b` |
| [5]   | C: 取消 | `delivered:admin` → `cancelled:agent-3b` |
| [6]   | schema sanity | 每行有 task_id / to_status / actor / created_at |
| [7]   | DESC 顺序 | newest first（replied 在 top） |
| [8]   | 跨 task 隔离 | `?task_id=A` 只返 A 的事件 |
| [9]   | 总数 ≥ 7 | 3+1+1+1+1 = 7 |

## R15 抠出的新 contract gap

**`/api/task` REST 端点不写 task_events，只有 MCP `send_task` 写。**

[index.ts /api/task 处理器](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L771) 直接 INSERT inbox+tasks，但**不调 `logTaskEvent("delivered", ...)`**。
而 [MCP send_task L517](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L517) 调用。

**含义**：通过 Dashboard 派单（走 REST `/api/task`）的任务在 task_events 表里**没有 delivered 事件**！
合规 / 审计追溯链断了。

测试通过改用 MCP send_task（agent-to-agent 路径）来证明 audit 流本身工作。

**`/api/task_events` DESC 排序在亚秒级事件下不稳定。**

SQL `ORDER BY created_at DESC` 但 SQLite 时间精度到秒，同秒事件 tie-break 由 rowid（ASC）。
SDK 消费方**不能只信 created_at 排序**，要按 `id` 二次排序，或显式 `ORDER BY created_at DESC, id DESC`。

两条都待 @通信龙 / Vincent 评。

## 锁住的契约

#### 1. 每次状态转换写一行 task_events

[tools.ts logTaskEvent](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) 在以下地方调：
- L161 `report_status(working)` → running
- L269 `report_completion` → replied
- L356 `ack_inbox` → acked
- L517 `send_task` → delivered
- L627 `send_reply` → replied/failed/cancelled
- L729 `retry_task` → delivered (retry)
- L825 `cancel_task` → cancelled
- L871 `reassign_task` → delivered (reassign)

R15 测了其中 5 个最常见（delivered / acked / replied / failed / cancelled）。
report_completion / retry / reassign / running 可在后续轮补。

#### 2. actor 列正确归属

- send_task 的 `from_session` 落到 actor → 这里是 `admin`（utok 调用）
- ack_inbox / send_reply / cancel_task 的 `alias` / `from_session` 参数落到 actor → `agent-3b`

#### 3. /api/task_events 端点

| 行为 | 测试断言 |
|------|---------|
| `?task_id=<id>` 过滤 | step [8] |
| `?network_id=<id>` 过滤 | 一直在用 |
| `created_at DESC` 排序 | step [7] |
| schema 字段完整 | step [6] |

## 资源

- Docker（`sg docker`）
- node:20-slim + bun + jq + unzip + procps
- `@sleep2agi/agent-network@preview` from npm
- 0 LLM API calls

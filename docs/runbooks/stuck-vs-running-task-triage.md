# 巡检判断：任务「在跑」还是「卡住」

面向跑巡检的人/agent。**进程心跳正常不等于任务在推进** —— 2026-10-19 现场抓到过一种
「节点进程活着、日志每秒都在写、任务却一直不回」的状态，靠 `ps` 或 hub 的
`sessions.status = working` **判不出来**。

## 判据只看三样（都在 hub 侧，不用上机器）

```sql
-- 1. 任务到底有没有进 runtime
SELECT task_id, status, created_at, runtime_submitted_at, consumed_at, last_activity_at, completed_at
FROM tasks WHERE task_id = '<id>';
```

| 信号 | 含义 | 结论 |
|---|---|---|
| `runtime_submitted_at IS NULL` | 任务还没交给 runtime | **排队**：节点上有一轮在跑（日志会说 `queued (a turn is in flight)`）。等它，不要重发 |
| `runtime_submitted_at` 有值、`last_activity_at` 长时间不更新 | 已提交但没有 turn 事件 | **可疑**：看节点日志（下节） |
| `last_activity_at` 在持续更新 | 有 turn 心跳 | **在进行**，长任务也会这样，别打断 |
| `status = failed` + result 里有原因 | 已结束 | 按原因处理，不要当「还在跑」 |

## 第 2 步：节点日志（只读，不占它的 turn）

hub 的 `tail_node_logs`（MCP）/ 节点 `logs_capable` 门铃可以只读拿日志，**不会**像派任务那样
占用节点的一轮。关键行：

| 日志行 | 含义 |
|---|---|
| `[opencode] session model poll=…` | 只是 co-presence 模型轮询，**不代表在干活** |
| `→ processing [opencode]: …` | 任务真正交给 runtime |
| `active turn heartbeat task=<id> kind=item_started/item_completed` | 这一轮在跑，**这是真进展** |
| `task … queued (a turn is in flight)` | 同一时刻只跑一轮，这条在排队 |
| `✗ OpenCode session remained busy for 1800000ms; task was not submitted` | **共享会话被占住 30 分钟，任务根本没发出去** |

> 最后一条是「进程活着但任务没回复」最常见的形态。回执正文也写明：
> 「opencode 任务未提交：共享会话在 30 分钟内一直处于忙碌状态（可能有人正在 TUI 里跑一轮）」。

## 第 3 步：共享 OpenCode 会话争用（本仓最常见的原因）

`agent-node/src/runtime/opencode-copresence/runtime.ts` 把任务投给**共享 OpenCode 会话**。
会话被 TUI 里的一轮占着时，投递方**阻塞等待**，满 `OPENCODE_TIMEOUT_MS`（默认 30 分钟）
抛 `opencode_copresence_timeout`（phase = `admission`），任务判「未提交」。

现场特征（2026-10-19 TMA云欧，`hub` 只读 + 节点日志）：

```
[01:45:09] ✗ OpenCode session remained busy for 1800000ms; task was not submitted
[02:21:12] 同 …  [02:57:14]  [03:33:15]  [04:09:23]  [04:45:23]  [05:21:25]  [05:57:27]
```

同一句 **8 次**，每 ~36 分钟一轮 —— 会话「永久忙碌」4 小时，每一轮 scheduler 任务都白跑。

## 处置（顺序别颠倒）

1. **先看再动**：去那台机器的 TUI，看是不是有一轮从很早以前就没结束（或会话里堆着未完成的 turn）；
2. **不要先 restart**：重启会丢掉那一轮的上下文，而且**解决不了**「TUI 一直占着会话」这个成因；
3. 清掉占住的那一轮后，下一轮调度就能提交；队列里的任务会依次进来；
4. 同一时刻只跑一轮的节点（日志有 `queued (a turn is in flight)`）**不要叠加任务** —— 只会让队列更长。

## 不要用这些当判据

- `sessions.status = working` / `process_in_flight_count > 0`：只说明进程活着、有计数；
- `ps` 里有进程、日志每秒在写（`session model poll`）：**和任务进度无关**；
- CPU 低：`opencode` 空闲轮询时 CPU 很低，卡住的会话看起来一样低。

## 相关

- 卡片：#1879（沉默 30 分钟才失败的三条改法）、#1565（重启归属取证）
- 代码：`agent-node/src/runtime/opencode-copresence/runtime.ts`（timeout 与会话忙判定）

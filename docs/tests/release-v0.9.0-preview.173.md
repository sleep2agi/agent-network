# 0.9.0-preview.173

> 首次 retention sweep 不再和**启动风暴**抢 CPU/WAL（18:11 部署实测：3,320 行花 13.9 秒 = 4.2 ms/行；稳态 0.24 ms/行）。

## 1. 首次 sweep 延后 60 秒（#2614 / PR #3114）

```ts
// 之前：启动立刻跑（setImmediate）
// 现在：默认延后 60 秒（COMMHUB_RETENTION_FIRST_DELAY_MS 可覆盖，0 = 立即）
```

依据是同一份启动日志：

```
18:11:09  [commhub stall] loop idle ~14085ms (served 614)     ← 重连风暴
18:11:11  [commhub retention] swept in 15693ms (max 957ms)
          phases telemetry=13928ms ← 3,320 行 = 4.2ms/行
18:11:19  deferred boot backfills: node_id=2680ms terminal_events=2628ms
```

重连风暴 15 秒内排空、boot backfills 约 8 秒结束 ⇒ 60 秒留足余量，且不影响“重启后追上积压”。

> 排程噪音的大头不是“任务失败”，而是**跑不起来**：`previous_run_active` 2,286 条 / `target_offline` 1,951 条（24h）。

## 2. 为什么现有退避管不到它们（#2622 / PR #3112）

```ts
failureStreak() 只数 status='failed'
// 注释原文：「skipped / cancelled / expired / 还没结束的 run 不算失败」
```

而这两类恰好都是 `status='skipped'`：

```
previous_run_active  2286/天  ← 间隔 < 任务耗时，每一拍都跳过
target_offline       1951/天  ← 目标节点长期不在
task_failed           135/天
node_degraded          14/天
```

前 8 个 schedule 就占 ~3,300 条/天，其中 4 个挂在**永久离线**的目标上（每个 180s、一天 470 次）。

## 3. 改法：只放慢，不改派发语义

```
同一 error_code 连续 ≥ N（默认 3，COMMHUB_SCHEDULE_NO_PROGRESS_BACKOFF_RUNS）
  ⇒ 间隔 2 倍递增
      previous_run_active 上限 1800s（30 分钟）——等上一次跑完足够
      target_offline      上限 7200s（2 小时）——目标不在时 3 分钟敲一次没有意义
成功一次 / 换链（原因变了） ⇒ 立刻回到原间隔
no_change_backoff=1 的排程 ⇒ 完全不介入（那套逻辑自己拥有 backoff_* 三列）
非 interval 排程 ⇒ 不介入
```

写入仍是条件写（`WHERE revision=? AND status='active'`），与现有退避同一套并发保护。

### 预期（同一批 schedule）

| 场景 | 现在 | 之后 |
|---|---|---|
| 永久离线的目标（180s 基底） | 470 次/天 | **12 次/天** |
| 间隔 < 耗时的排程 | 343–416 次/天 | 降到 ~1/8 |

## 4. 还有一件「只有人能决定」的事

那 4 个挂在死目标上的排程（都是 admin 创建的）：

```
TMAI鲸       / TMAI 链路文档优化   目标 session 自 2026-10-24 04:31 起 offline
TMA客户端鲸  / TMWork 文档优化     2026-10-27 01:26 起 offline
TMA云盘鲸    / 云盘                2026-10-27 01:28 起 offline
TMA云鲸      / TMBot              2026-10-27 01:28 起 offline
```

本版会把它们的频率从 470/天 降到 12/天；**要彻底归零只能暂停排程或把那四台拉起来**——
这是产品决定，代码不替人做。

## Install

```bash
set -e
npm install -g @sleep2agi/commhub-server@0.9.0-preview.173
commhub-server --version   
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.173
commhub-server --version   
```

版本化运行时目录（`HUB_RUNTIME_DIR`）：把依赖版本改成 `0.9.0-preview.173` 后 `npm install`，
指到新目录再重启；`runtime-v172-preview172` 保留即可回滚，无数据迁移。

## 验收

```bash
# 24 小时后：这两个错误码的日增量应显著下降（180s 基底的死目标 ⇒ 12/天）
bun -e 'const {Database}=require("bun:sqlite");const d=new Database(process.env.HOME+"/.commhub/commhub.db");
for (const r of d.query("SELECT error_code, COUNT(*) c FROM scheduled_task_runs WHERE created_at >= datetime(\"now\",\"-1 day\") AND error_code IN (\"previous_run_active\",\"target_offline\") GROUP BY 1").all()) console.log(r);'
```

回滚：`HUB_RUNTIME_DIR` 指回 `runtime-v172-preview172` 并重启；无 schema 变更。

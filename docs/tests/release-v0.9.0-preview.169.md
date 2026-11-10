# 0.9.0-preview.169

> `.168` 上线第一拍就被生产打回：删 266 行花了 **4.7 秒**。这一版把它改成**索引驱动**的分批。

## 1. 为什么 `.168` 不对（#2614 / PR #3104）

`.168` 用「单调前进的 rowid 游标」分批，在**没有谓词索引**的库副本上确实把单块从 2686ms 压到 258ms。
但生产第一拍的日志是：

```
[commhub slow-sql] 4716ms SELECT rowid … WHERE created_at < ?1 AND rowid > ?2 ORDER BY rowid LIMIT ?3
[commhub retention] swept in 6157ms (3 batches) — telemetry=266
```

删 266 行花 4.7 秒。原因是 `ORDER BY rowid` 让优化器**放弃** `idx_agent_telemetry_created`，
改走 `INTEGER PRIMARY KEY`：为了凑够 2000 行，从 rowid=0 一路扫完 60 万行。

而我做实验的副本是 **10-26 的快照**，那时这张表还没有那个索引（`#3065` 之后才加），所以副本上看不出问题。

## 2. 改法：索引驱动的分批

```sql
DELETE FROM <t> WHERE rowid IN (SELECT rowid FROM <t> WHERE <谓词> LIMIT <chunk>)
```

生产上四张表的真实计划（读的是生产库，不是猜的）：

```
agent_telemetry  SEARCH … USING COVERING INDEX idx_agent_telemetry_created
task_events      SEARCH … USING COVERING INDEX idx_task_events_created
tasks            SEARCH … USING INDEX idx_tasks_status
audit_log        SEARCH … USING COVERING INDEX idx_audit_created
inbox            SCAN（没有谓词索引；每小时可删行极少，一轮只有一批，代价可忽略）
```

其余性质不变：每批之间 `await` 让出事件循环、删的这段时间关掉 WAL 自动 checkpoint、
单表 10 分钟上限（超了记 `truncated` 下一轮继续）、同一时刻只允许一轮 sweep。

### 实测（**当前生产的副本**）

| | `.168`（生产） | `.169`（当前生产副本） |
|---|---|---|
| 一整轮 | 6157 ms | **1839 ms** |
| 最长单次阻塞 | 4716 ms | **249 ms** |

顺手修掉一个假红：本轮刚跑完 `db.all` 时同连接可能还有未重置的读语句，
`wal_checkpoint` 会报 `database table is locked`（SQLITE_LOCKED，瞬时）。
现在重试 3 次，不把这种瞬时失败记成 `vacuum.errored`。

## 3. 三条被实验逼出来的规矩（写在这里，免得下次重踩）

1. **谓词必须有索引**：没有索引时 `LIMIT n` 会退化成覆盖索引扫描，每批都从表头扫一遍，
   总代价 = 批数 × 表大小（实测 2.7 秒 → 17 秒）。
2. **分批必须配「自己决定何时 checkpoint」**：自动 checkpoint 是连接级、每 1000 页触发，
   会落进任意一批，把中位数 89ms 的批次顶到 4.3 秒。
3. **副本的 schema 也必须与生产一致**：否则「按副本优化」会变成新的全表扫（就是 `.168`）。

## Install

```bash
set -e
npm install -g @sleep2agi/commhub-server@0.9.0-preview.169
commhub-server --version   # 0.9.0-preview.169
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.169
commhub-server --version   # 0.9.0-preview.169
```

版本化运行时目录（`HUB_RUNTIME_DIR`）：把依赖版本改成 `0.9.0-preview.169` 后 `npm install`，
指到新目录再重启；旧目录（`runtime-v168-preview168`）保留即可回滚，无数据迁移。

## 验收

```bash
# 1) 整点 sweep：多批、单批 <300ms，且**不得**再出现 SELECT rowid 的慢 SQL
grep "commhub retention" ~/.commhub/pm2-hub-out.log | tail -1
grep "SELECT rowid AS r FROM" ~/.commhub/pm2-hub-out.log | tail -3   # 期望：空

# 2) 停顿监测：不再有每小时一次 ~10 秒 gap
curl -s localhost:9200/health | python3 -c 'import sys,json;e=json.load(sys.stdin)["event_loop"];print(e.get("max_gap_ms"), e.get("stall_count"))'
```

回滚：`HUB_RUNTIME_DIR` 指回 `runtime-v168-preview168` 并重启；无 schema 变更、无数据迁移。

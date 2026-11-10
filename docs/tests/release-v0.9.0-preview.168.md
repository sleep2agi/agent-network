# 0.9.0-preview.168

> 一小时一次的 **8–11 秒事件循环静默**，变成 42 批、最长 281ms。

## 1. retention 分批：一次删完 → 按 rowid 游标分批（#2614 / PR #3103）

生产 `.161` 的现场（2026-10-26）：

```
18:10:54 → 18:11:05  11s   ← 后一行是 [commhub retention] swept in 10588ms
期间：/health 超时 · 在飞 387→807 · RSS 冲到 4.5 GB · 1 分钟后自行回落
```

根因不是「删得多」，是**一次 DELETE 把整批行放在同一个语句里，中间不让出事件循环**。

### 现在的形态

```
每批 ≤ COMMHUB_RETENTION_CHUNK_ROWS（默认 2000）行
  → 用单调前进的 rowid 游标取行，再按 rowid 删
  → 每批之间 await 一次，把控制权交还事件循环
  → 删的这段时间关掉 WAL 自动 checkpoint，本轮 checkpoint 收敛到末尾那一次 TRUNCATE
  → 单表最多跑 10 分钟；超了记 truncated 并下一轮继续
  → 同一时刻只允许一轮 sweep
```

### 副本实测（1.09 GB 生产库副本，68k 行积压）

| 写法 | 合计 | 最长单次阻塞 |
|---|---|---|
| 一次 DELETE（旧） | 3.1 s | **2686 ms** |
| 分批 + 每批重新子查询（第一版） | 17 s | **4634 ms** ← 比不改还差 |
| 分批 + rowid 游标，但留着自动 checkpoint | 13.6 s | **4221 ms** |
| 分批 + rowid 游标 + 关自动 checkpoint（本版） | 5.4 s | **281 ms** |

两条被数据推翻的直觉，写在这里免得下次重踩：

1. **「加个 LIMIT 就行」不成立**：`created_at < ?` 没有覆盖全表的索引，每批的子查询都退化成一次
   覆盖索引扫描（`EXPLAIN: SCAN … USING COVERING INDEX idx_agent_telemetry_ip_time`），
   于是每批从表头扫一遍，总代价 = 批数 × 表大小。
2. **「分批就一定不卡」不成立**：自动 checkpoint 是连接级、每 1000 页触发，会落进任意一批，
   实测把中位数 89ms 的批次顶到 4.3 秒。

### 取舍

总耗时 3.1 s → 5.4 s（可被打断）。这里选的是「可被打断」而不是「最快跑完」——
一次 10 秒不可打断的停顿，代价是 800 个请求在飞和 4.5 GB RSS。

### 怎么验（上线后第一小时内）

```bash
grep "commhub retention" ~/.commhub/pm2-hub-out.log | tail -3
#   期望：swept in <2000ms (42 batches, max <300ms)

curl -s localhost:9200/health | python3 -c 'import sys,json;e=json.load(sys.stdin)["event_loop"];print(e.get("max_gap_ms"),e.get("stall_count"))'
#   期望：不再出现每小时一次的 ~10 秒 gap
```

**语义没动**：retention 时间窗、`COMMHUB_RETENTION_*_DAYS`（`<0` 仍等于该表 opt-out）、
tasks 的 child-safe（父任务被子任务引用就不删）全部保持；PostgreSQL 路径保持单条 DELETE
（没有 rowid，且 autovacuum 自己按批回收）。

## Install

```bash
set -e
npm install -g @sleep2agi/commhub-server@0.9.0-preview.168
commhub-server --version   # 0.9.0-preview.168
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.168
commhub-server --version   # 0.9.0-preview.168
curl -s http://127.0.0.1:9200/health | python3 -c 'import sys,json;print(json.load(sys.stdin)["version"])'
```

版本化运行时目录（`HUB_RUNTIME_DIR`）：把依赖版本改成 `0.9.0-preview.168` 后 `npm install`，
指到新目录再重启；旧目录保留即可回滚，无数据迁移。

## 验收

```bash
# 1) 发布说明里那条判据：一次 sweep 的批次数与最长单批
grep "commhub retention" ~/.commhub/pm2-hub-out.log | tail -1
#   期望：swept in <2000ms (42 batches, max <300ms)

# 2) 停顿监测（不再出现每小时一次 ~10 秒 gap）
curl -s localhost:9200/health | python3 -c 'import sys,json;e=json.load(sys.stdin)["event_loop"];print(e.get("max_gap_ms"), e.get("stall_count"))'
```

回滚：把 `HUB_RUNTIME_DIR` 指回上一版（`runtime-v167-preview167`）并重启；无 schema 变更、无数据迁移。

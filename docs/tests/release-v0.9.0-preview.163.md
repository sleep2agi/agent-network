# 0.9.0-preview.163

> 主题：**重启更快、观测不再误报**。三处都是运维侧修复，客户端无需升级。

## 1. 重启期不再白付 10 秒：`node_id` 回填改成连接物化表（#2664 / PR #3072）

`.162` 的慢 SQL 日志上线两分钟就抓到这个（2026-10-27 00:21 重启）：

```
00:21:04  [commhub slow-sql] 2451ms  UPDATE inbox SET node_id = (…)
00:21:05  [commhub slow-sql] 1094ms  UPDATE tasks SET to_node_id = (…)
00:21:11  [commhub slow-sql] 5398ms  UPDATE tasks SET from_node_id = (…)
00:21:12  [commhub slow-sql] 1270ms  INSERT OR IGNORE INTO task_terminal_events …
00:21:29  [commhub stall] loop blocked ~2014ms (rss 574 MB)
```

而同一次启动的日志写着 `total=0` —— **结果是 0，代价不是 0**。

根因：`backfillMessageNodeIds()` 的六条 `UPDATE` 都对 **84,062 行 `tasks.from_node_id IS NULL`** 逐行跑相关子查询，
子查询里的 `COALESCE(network_id,'default')` 让 `idx_sessions_network_alias_unique` 用不上 ⇒ 每行扫一遍 369 行 `sessions`。

改成把「别名 → node_id」物化一次再用 `UPDATE … FROM` 连接（SQLite ≥3.33 与 PostgreSQL 同语法）：

| 语句 | 旧 | 新 |
|---|---|---|
| `tasks.from_node_id` | **6.56 s** | **0.29 s** |
| 六条合计（boot 全量） | ≈ 10.4 s | **0.75 s** |

语义未变（只认 `committed` 的 rename、人类用户名不映射成节点、已有 node_id 不覆盖、重复调用幂等），6 条单测钉住。
日志补上 `took=<ms>` —— 以后“0 行却花 10 秒”一眼可见。

## 2. 停顿日志不再把「timer 饥饿」写成「循环卡死」（#2614 / PR #3074）

`.162` 上线后记录到 `gap 84887ms`。但同一时段日志在正常写、`/api/stats/routes` 最慢请求只有 2.4s ⇒
循环没被阻塞，是 **timer 回调被 I/O 队列饿住**（触发点：一次 broadcast 扇出，一分钟 380 次调用、`inflight` 622、RSS 2.6 GB）。

两者处置方向相反，所以每次 tick 现在记「这段时间完成多少请求」：

```jsonc
"event_loop": {
  "recent_stalls": [
    { "gap_ms": 84887, "stall_ms": 84637, "rss_mb": 2076, "requests_since_last_tick": 137 }
  ]
}
```

- `requests_since_last_tick > 0` ⇒ 循环在干活 ⇒ timer 饥饿（降并发，不是加内存）；
- `= 0` ⇒ 这期间什么都没推进 ⇒ 才可能是同步阻塞。

日志措辞从 `loop blocked ~Nms` 改成 `loop idle ~Nms (…, served M req)`。

## 3. 定时任务连续失败：放慢而不是原速重试（#2622 / PR #3073）

生产 24h 的一个 `every_seconds=180` 排程：`failed 351 / replied 24` —— 失败与成功交替，
攒不到暂停阈值，而每次失败都按 3 分钟原速重试（占全 Hub 失败量 50%）。

```
streak <  N  → 不介入
streak >= N  → effective = min(3600, every × 2^(streak-N+1))
成功一次     → effective = NULL（立刻恢复），next_run_at 拉回 now + every
```

`N = COMMHUB_SCHEDULE_FAILURE_BACKOFF_RUNS`（默认 **6**，`0` 关闭）；只对 `active` + `interval` 生效；
与 `no_change_backoff` 互斥。**不是暂停**：外部原因一恢复就自动回到原节奏，不需要人介入。

## Install

```bash
set -e
npm install -g @sleep2agi/commhub-server@0.9.0-preview.163
commhub-server --version   # 0.9.0-preview.163
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.163
commhub-server --version   # 0.9.0-preview.163
curl -s http://127.0.0.1:9200/health | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["version"], d.get("event_loop"))'
```

版本化运行时目录（`HUB_RUNTIME_DIR`）用户：把 `package.json` 依赖版本改成 `0.9.0-preview.163` 后 `npm install`，
再把 `HUB_RUNTIME_DIR` 指到新目录并重启（旧目录保留作回滚）。

## 验收（升级后立刻可看）

```bash
# 1) 启动回填的耗时（应远小于 10000ms，通常 < 1000ms）
grep "node_id backfill" ~/.commhub/pm2-hub-out.log | tail -2

# 2) 启动期间不再出现这几条慢 SQL
grep "commhub slow-sql" ~/.commhub/pm2-hub-out.log | tail -5

# 3) 停顿日志带 served 计数（>0 表示 timer 饥饿而不是阻塞）
grep "commhub stall" ~/.commhub/pm2-hub-out.log | tail -3

# 4) 排程退避生效（连续失败 6 次后可看到 backoff_effective_seconds）
curl -s -H "Authorization: Bearer <token>" 'localhost:9200/api/scheduled-tasks' | head -c 400
```

回滚：把 `$HOME/.local/bin/hub-daemon.sh` 里的 `HUB_RUNTIME_DIR` 指回上一版运行时目录即可；无数据迁移。

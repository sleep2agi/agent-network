# 0.9.0-preview.165

> 只含一处启动路径优化：把两条历史回填从「进程启动」挪到「服务开始监听之后」。

## 改了什么（#2664 / PR #3085）

`.163` 的慢 SQL 日志显示，每次启动都会先做两条全表回填：

```
02:38:52  [commhub slow-sql] 1511ms  UPDATE tasks SET from_node_id = pick.node_id FROM (…)
02:38:53  [commhub node_id backfill] … total=0, took=2138ms
02:38:55  [commhub slow-sql] 2137ms  INSERT OR IGNORE INTO task_terminal_events …
```

合计约 **3.5 秒**，全部落在「进程刚起来 + 369 个会话正在重连」的窗口里 —— 也就是 Hub 最脆弱的时候。

这两条只修**历史缺口**：

- `node_id` 的新行由 send_task / send_reply 路径直接写入；
- `task_terminal_events` 的新行由 `tasks_terminal_event_insert/update` 触发器实时写入。

所以它们不该占启动的关键路径。现在改为：

```
监听成功 15 秒后执行一次（避开重连风暴峰值）
日志：[commhub] deferred boot backfills: node_id=2ms terminal_events=3ms
```

延迟可用 `COMMHUB_BOOT_BACKFILL_DELAY_MS` 调整（默认 15000；`0` = 立即在监听后执行，测试用）。

副本实测（116k tasks）：`nodeIdsMs 972 + terminalEventsMs 960 = 1933ms` —— 这 1.9 秒不再挡在「启动 → 可服务」之间。

## 一个被自己抓到的接线 bug（记录在案）

第一版把 `clearTimeout(deferredBackfillTimer)` 误插进了「启动收尾 unref 那一块」，进程启动时立刻取消了自己的延迟任务 —— 单测直接调函数所以看不见，只有真起一个 Hub 才会暴露。已修，并加了 `COMMHUB_BOOT_BACKFILL_DELAY_MS` 让这种接线能在 0.3 秒内验证。

## Install

```bash
set -e
npm install -g @sleep2agi/commhub-server@0.9.0-preview.165
commhub-server --version   # 0.9.0-preview.165
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.165
commhub-server --version   # 0.9.0-preview.165
curl -s http://127.0.0.1:9200/health | python3 -c 'import sys,json;print(json.load(sys.stdin)["version"])'
```

版本化运行时目录（`HUB_RUNTIME_DIR`）：把依赖版本改成 `0.9.0-preview.165` 后 `npm install`，指到新目录再重启。

## 验收

```bash
# 启动后 15±2 秒应出现这一行（且两个数字都远小于 3000）
grep "deferred boot backfills" ~/.commhub/pm2-hub-out.log | tail -1

# 启动期不应再出现这两条慢 SQL
grep "commhub slow-sql" ~/.commhub/pm2-hub-out.log | grep -E "task_terminal_events|from_node_id = pick" || echo "none (expected)"

# 回填语义没变：条数应与升级前同量级（通常 total=0）
grep "node_id backfill:" ~/.commhub/pm2-hub-out.log | tail -1
```

回滚：把 `HUB_RUNTIME_DIR` 指回上一版目录并重启；无数据迁移。

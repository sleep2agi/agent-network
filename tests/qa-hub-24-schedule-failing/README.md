# qa-hub-24-schedule-failing — 定时任务连续失败:告诉创建者(#523)

真 hub(全新 HOME + DB,随机端口),全部走 REST / MCP HTTP:

0. 单测 `server/src/scheduled-failures-http.test.ts`(SQLite)。
1. boss 建排程,目标 `node-a`(节点令牌上报 idle,每次以 `send_reply status=failed` 回复);otto 入网作对照。
   排程建好即暂停,用 `run-now` 逐次驱动(与调度器同一个派发函数),时间线确定。
   第 1–4 次失败无通知,第 5 次 → boss 恰好 1 条 `kind=schedule_failing`(正文带排程名、节点、次数、
   最近一次错误、怎么暂停);第 6、7 次仍是 1 条;otto 0 条;没开自动暂停 → 状态不变。
2. `GET /api/scheduled-tasks/:id/runs`:`consecutive_failures=7`、`failure_alert_threshold=5`、
   `last_failure_alert_at`;每条失败 run 的 `error_message` 是节点回复的失败原因。
3. 成功一次 → `consecutive_failures=0`;再连续 5 次失败 → 第 2 条通知。
4. 全新 hub,`COMMHUB_SCHEDULE_FAILURE_AUTO_PAUSE_RUNS=3`、排程 active:第 3 次失败后 `paused`、
   `next_run_at=null`,并通知一次。
5. witnessed-red:去掉去重条件 ⇒ 单测红,真 hub 上 7 次失败多于 1 条通知。

跑法(仓库根):

```bash
docker build --build-arg SOURCE_COMMIT=$(git rev-parse HEAD) -t anet-qa-hub-24-schedule-failing -f tests/qa-hub-24-schedule-failing/Dockerfile .
docker run --rm anet-qa-hub-24-schedule-failing
```

CI:`.github/workflows/qa.yml` 的 `hub-orphan-gates` matrix。

# qa-hub-21-schedule-stuck — 定时任务被卡住:告警 + 超时放行(#464)

真 hub(全新 HOME + DB,随机端口,调度器 1 秒一拍,卡住超时压到 20 秒),全部走 REST / MCP HTTP:

1. boss 注册并建 60 秒间隔的排程,目标 `node-a`(节点令牌上报 idle,**从不回复**);otto 入网作对照。
   排程建好即暂停,用 `run-now` 逐次驱动(与调度器同一个派发函数),时间线确定。
2. 第一次派出任务 A;之后第 1、2 次跳过无通知,第 3 次跳过 → boss 恰好 1 条 `kind=schedule_stuck`
   (正文带排程名、A、节点、开始时间);第 4、5 次仍是 1 条;otto 0 条。
3. `GET /api/scheduled-tasks/:id/runs`:5 条跳过记录都带 `blocked_by_task_id = A` 与 `blocked_by_state`。
4. A 开满 20 秒后的下一次:A 变 `expired`(`GET /api/tasks/A` 仍可读),A 的 run 为 `expired / task_expired`
   并写明是调度器超时;这一次派出新任务 B;不再多发通知。
5. 节点晚到的回复(`send_reply in_reply_to=A`)被 `reply_task_terminal` 拒掉,A、B 都不变;B 照常回复,排程照常往下跑。
6. witnessed-red:把「恰好第 N 次」改成「第 N 次及以后」,换全新 hub 重跑 ⇒ 多于 1 条(第 2 步会红)。

跑法(仓库根):

```bash
docker build --build-arg SOURCE_COMMIT=$(git rev-parse HEAD) -t anet-qa-hub-21-schedule-stuck -f tests/qa-hub-21-schedule-stuck/Dockerfile .
docker run --rm anet-qa-hub-21-schedule-stuck
```

CI:`.github/workflows/qa.yml` 的 `hub-orphan-gates` matrix。单测见 `server/src/scheduled-stuck-http.test.ts`。

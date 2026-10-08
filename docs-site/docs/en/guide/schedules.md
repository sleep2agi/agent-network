# Schedules

The Schedules page in the desktop app and on Android. When a time is reached, the Hub dispatches one session task to a chosen node. It is not the cards on the [Tasks](/en/guide/tasks) page, and it is not the CLI [Goals and Loops](/en/guide/goals-and-loops). The dispatched task uses the states in [Task lifecycle](/en/concepts/task-lifecycle).

iOS is still TestFlight only, and the public link is not open. This page describes what you can click on desktop and Android. The labels for creating, filtering and the detail view are still Chinese. The conflict comparison, and the collapsed skip row described below, follow the app language.

## Hub schedules and node schedules

The page has two tabs.

**Hub schedules** (Hub 计划) are created here. 「新建定时任务」 makes the Hub dispatch the task text to a node on the schedule you set. The Schedules section on a node page opens the same form with that node already selected.

**Node schedules** (节点计划) are not created in that form. The node reports plans from its own machine: crontab, systemd, tmux, playwright and custom. When nothing has been reported, the page says 「节点升级后会自动上报本机 crontab 等计划。」

Frequency, time zone, missed runs and skipping below are only about Hub schedules.

## Creating one

- **Name** (名称). At most 120 characters.
- **Target node** (执行节点). It must already exist in the current network, for example `demo-node`.
- **Task** (任务内容). The text the node receives. At most 10000 characters.
- **Priority** (优先级). High, Normal or Low (高 / 普通 / 低). The default is Normal.
- **Type** (类型). Four forms only. There is no cron expression.
- **Missed runs** (错过执行). Below.
- **Time zone** (时区). An IANA name, for example `Asia/Shanghai`. The form opens with this device's time zone. If a caller creates a schedule without a time zone, the Hub uses UTC. An invalid name is rejected. Daily and weekly clock times are read in that zone, including daylight-saving changes. The list appends the zone to the frequency only when it differs from the device, so 「每天 09:00」 is not read as 09:00 on the device. The detail view always shows the zone.

Types:

- **Once** (单次). A time that has not passed yet. After it runs, the schedule is Completed (已完成) and cannot be set back to Active (进行中).
- **Interval** (间隔). At least 1 minute, at most 365 days.
- **Daily** (每天). `HH:mm`.
- **Weekly** (每周). `HH:mm`, and at least one weekday.

A run that is at most 1 minute late still counts as that occurrence and runs. Later than 1 minute counts as missed.

- **Catch up once** (补跑一次). This is the default. If the Hub was down, or this occurrence is more than 1 minute late, recovery runs it at most once. It does not replay every missed slot, then schedules the next time that is still in the future. An older Hub that omits this field is also treated as catch-up once.
- **Skip this one** (跳过本次). The missed occurrence does not run. The history keeps a row, and the schedule waits for the next time.

An Active schedule can be paused (暂停). Pausing clears the next time; the detail says 「已暂停，恢复后继续」. Resume (恢复) computes the next time again. Cancel (取消计划) stops it for good; cancelling again stays cancelled. Completed and cancelled schedules cannot be made Active again.

Changing the name, the task text or the priority does not recompute the next time. The next time is recomputed only when the frequency or the time zone changes, when a paused schedule is resumed, or when an Active schedule has no next time.

Active and paused schedules can also run now (立即执行). That follows the skip rule in the next section, and it does not change the next scheduled time.

On desktop the form is a centered dialog. On a phone it is a full page. When the window is wide enough, the list is on the left and the detail is on the right. Filter the list by Active, Paused, Completed and Cancelled (进行中 / 已暂停 / 已完成 / 已取消).

## Skip when the previous run is still open

Every Hub schedule created here skips the new occurrence when the previous one has not finished.

At the scheduled time, if the task last dispatched by this schedule is still `created`, `delivered`, `acked` or `running`, this occurrence does not dispatch a new task. The history records it as skipped (已跳过), because the previous run had not finished (上一次还没结束). The schedule's own next time still moves forward. Before Hub `0.9.0-preview.88` such skips had no wait limit; from that release a run stuck too long is ended by a timeout, see the next section.

If the node is offline, this occurrence is recorded as queued (排队中 · 节点离线) and is not pushed. It still counts as unfinished, so later occurrences keep being skipped until that task ends.

**From desktop 0.2.150**, two or more consecutive skips that are all "previous run still active" collapse into one history row: "Skipped N times (HH:MM–HH:MM)", plus which run they were waiting on. A single skip, or a skip for another reason (the node is gone, the node is not usable, or a missed run was skipped), stays on its own row. The Hub still stores one row per tick. Collapsing is only how this page draws them. If the run being waited on is not on this page of history, the row says so and does not guess. Earlier desktop versions list every skip on its own row.

## Alerts and timeout when a run is stuck {#stuck}

From Hub `0.9.0-preview.88`, when a schedule keeps being blocked by the same unfinished task:

- **Alert**: on the 3rd skip behind the same task, the person who created the schedule gets **one** notice, 「定时任务被卡住」 (scheduled task stuck), in the app in the target node's conversation. It names the schedule, the blocking task id, the node and that task's start time, and says when it will be released automatically. One notice per stuck episode; once a run is actually dispatched again, a new stuck episode alerts again. A Hub restart does not re-send it. No notice if the schedule has no creator or the creator has left the network.
- **Timeout release**: if the blocking task has been open longer than the timeout, it is ended by the timeout (task status `expired`, the same state as a task nobody picked up within 24 hours) and this occurrence dispatches normally.
  - Timeout = 6 × the schedule's interval, at least 1 hour, at most 24 hours. Daily and weekly schedules count as a one-day interval, so 24 hours.
  - Examples: every 1 or 10 minutes → 1 hour; every 30 minutes → 3 hours; hourly → 6 hours; daily → 24 hours.
  - The ended task's record stays and can still be read. Its run is recorded as `expired`, with the reason that the scheduler timed it out.
  - A later reply from the node to that task is refused (`reply_task_terminal`) and changes nothing; the newly dispatched task is unaffected.
  - If the timeout comes before the 3rd skip (common for long intervals), one 「定时任务已超时放行」 (released by timeout) notice goes out when it is released instead. So each stuck episode produces exactly one notice.
- **Tuning** (operators, Hub environment variables):

  | Environment variable | Default | Meaning |
  |---|---|---|
  | `COMMHUB_SCHEDULE_STUCK_NOTICE_SKIPS` | `3` | which skip behind the same task triggers the alert |
  | `COMMHUB_SCHEDULE_STUCK_TIMEOUT_FACTOR` | `6` | timeout = this factor × the schedule's interval |
  | `COMMHUB_SCHEDULE_STUCK_TIMEOUT_FLOOR_SEC` | `3600` | lower bound of the timeout (seconds) |
  | `COMMHUB_SCHEDULE_STUCK_TIMEOUT_CAP_SEC` | `86400` | upper bound of the timeout (seconds) |

In the run history endpoint `GET /api/scheduled-tasks/:id/runs`, every skipped row carries `blocked_by_task_id` (the blocking task) and `blocked_by_state` (`not_received`: the node has not picked it up; `in_progress`: the node is working on it).

If the target node is degraded (Hub `0.9.0-preview.86`+, see [health and degraded refusal](/en/guide/codex-copresence#health)), the occurrence is recorded as failed with `node_degraded` and no task is created.

## Alerts when a schedule keeps failing {#failing}

From the Hub release that carries #523 (not on latest yet), a schedule whose **every run fails** also alerts its creator instead of failing silently:

- **What counts as a failure**: a run whose history status is `failed`. That covers a dispatched task the node ended as failed (for example an upstream model refusal) and a run that failed at dispatch (node missing, not active, degraded, or the creator lost access). Skipped, cancelled, timed-out (`expired`, covered by the previous section) and still-open runs neither count nor break the streak.
- **Alert**: when the failures since the last successful run reach 5, the person who created the schedule gets **one** notice, 「定时任务连续失败」 (schedule keeps failing), through the same path as the stuck alert: in the app, in the target node's conversation. It names the schedule, the target node, the failure count, the latest error (truncated to 300 characters) and how to pause it.
- **No repeats**: while the schedule has not succeeded again, it does not alert again for 24 hours; after a success, another 5 consecutive failures alert again. A Hub restart does not re-send it. No notice if the schedule has no creator or the creator has left the network.
- **By default it only alerts and never pauses.** An operator can turn on auto-pause: at the Mth consecutive failure the schedule becomes paused (same as a manual pause, no next run time) and one 「定时任务连续失败，已自动暂停」 (auto-paused) notice goes out. Resume it once the cause is fixed.
- **Tuning** (for operators, Hub environment variables):

  | Environment variable | Default | Meaning |
  |---|---|---|
  | `COMMHUB_SCHEDULE_FAILURE_NOTICE_RUNS` | `5` | which consecutive failure triggers the alert |
  | `COMMHUB_SCHEDULE_FAILURE_RENOTICE_SEC` | `86400` | while it keeps failing, how long before alerting again (seconds) |
  | `COMMHUB_SCHEDULE_FAILURE_AUTO_PAUSE_RUNS` | `0` (off) | set to M (≥1) to auto-pause at the Mth consecutive failure |

The run history endpoint `GET /api/scheduled-tasks/:id/runs` also returns `consecutive_failures` (failures since the last success), `failure_alert_threshold` (N above) and `last_failure_alert_at` (time of the last alert, or `null`). For a run whose task the node ended as failed, `error_message` is the node's failure reason (up to 500 characters).

## Schedules managed by Agents {#agent-managed}

A node (Agent) can manage schedules itself through the Hub's MCP tools, without a person opening the app:

| Tool | What it does |
|---|---|
| `schedule_create` | Create one. Leave `target_node_id` out to send to yourself |
| `schedule_list` / `schedule_get` | List / read |
| `schedule_update` | Change name, task, timing or target; set `status` to `paused` / `active` to pause or resume |
| `schedule_batch_interval` | Change intervals of self-created interval schedules; retain content, target and active/paused state |
| `schedule_cancel` | Cancel |
| `schedule_run_now` | Run once now |
| `schedule_runs` | Recent runs |

`schedule` takes the same shape as the app, e.g. `{"type":"interval","every_seconds":3600}` or `{"type":"daily","time":"09:30"}` (with `timezone`, default UTC). Validation is the same code as `/api/scheduled-tasks`.

Batch example (requires a Hub version containing this tool; older Hubs do not expose it): call `schedule_batch_interval` via `/mcp` `tools/call` with `{"schedule_ids":["sched_a","sched_b"],"every_seconds":600}` to change selected schedules to every ten minutes. Supply 1–100 IDs; duplicates are processed once. Intervals are integer seconds from 60 to 31536000. An invalid interval writes nothing. Otherwise each ID is processed independently, not as an all-or-nothing transaction: one failure does not roll back successful items. The response has `updated`, `failed` and `results`; each result has its ID and `ok`, with interval, status, revision and next execution time on success, or an error on failure. Top-level `ok` is true only when all items succeed. Daily, weekly and once schedules are not converted (`not_interval_schedule`). Paused schedules stay paused with null `next_run_at`. Changing an active interval recalculates its next execution from the edit time; already-dispatched tasks are not recalled. Unselected schedules are unchanged.

Permissions:

- **A node sees and touches two kinds of schedules only**: those in its network that **target itself**, and those **it created**. Everything else answers as not found (`schedule_not_found`).
- **A schedule for another node** requires that the node could `send_task` to it right now (the same check: the owner's Agent grants and the node's permission mode). This check refuses even under the default log-only flag, because the run would be refused anyway.
- **Only its own schedules can be changed**: edit, pause, resume, cancel and run-now are limited to schedules the node created. A person's schedule that targets the node is read-only for it (`not_schedule_creator`).
- A node in **read-only mode** can only read; it cannot create, edit, cancel or run.
- **Quota**: at most 20 open (active or paused) schedules per node; cancel one to create another. Operators can change it with the Hub environment variable `COMMHUB_AGENT_SCHEDULE_QUOTA`. The shortest interval is 60 seconds, as in the app.
- **Every run re-checks the creating node as it is now** (the same check as `send_task`, with the node's current owner). The run fails with `creator_node_gone` if the node was deleted, `creator_node_readonly` if it is read-only, or `creator_access_revoked` if its owner changed and the new owner may not send tasks to the target.
- **Provenance is stated**: a task from an Agent-created schedule always starts with a line `[scheduled by agent <alias> (<node_id>)]`, and its meta carries `scheduled_by_node_id` and `scheduled_by_alias`. The Hub sets these and the Agent cannot remove them, so it cannot pass as a person's schedule. Replies to these runs do not go into the owner's unread messages.

People keep using the app and `/api/scheduled-tasks` as before; node tokens calling that REST API still get 403.

## A run while you are editing

**From desktop 0.2.150**, if the schedule runs once while you are editing, saving does not drop what is in the form. The client compares the fields you changed with the fields that changed on the server. When those are not the same fields, it keeps your draft and saves. A comparison is shown only when the same field was changed to two different values: your change (你的修改) and the current server value (最新版本). Keep mine (用我的覆盖) saves your change. Use the server value (用最新的) puts that value into the conflicting fields and leaves you in the form. Keep editing (继续编辑) leaves the draft as you typed it and continues against the newer copy. If the schedule was cancelled or deleted, the draft stays in the form and cannot be saved. Earlier desktop versions could discard the whole draft on this kind of save conflict.

## Known issue

Fixed starting with Hub 0.9.0-preview.67. Before that version was published and the Hub was upgraded, a Claude Code node could miss the scheduled-task push. The history can show the run as queued, the same way it does when a node is offline, while the node never received it. Later occurrences are then skipped because the previous run has not finished.

Starting with agent-network 2.3.0-preview.118, a Claude Code node is also woken when it receives a reply. That takes effect after the node is updated to this version and restarted.

## See also

- [Desktop and mobile clients](/en/guide/desktop-app)
- [Tasks](/en/guide/tasks)
- [Task lifecycle](/en/concepts/task-lifecycle)
- [Goals and Loops](/en/guide/goals-and-loops). The troubleshooting section "Scheduled task did not run" is about CLI loops, not this page.

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

At the scheduled time, if the task last dispatched by this schedule is still `created`, `delivered`, `acked` or `running`, this occurrence does not dispatch a new task. The history records it as skipped (已跳过), because the previous run had not finished (上一次还没结束). That skip has no wait limit. It does not turn into a dispatch after a while. The schedule's own next time still moves forward.

If the node is offline, this occurrence is recorded as queued (排队中 · 节点离线) and is not pushed. It still counts as unfinished, so later occurrences keep being skipped until that task ends.

**From desktop 0.2.150**, two or more consecutive skips that are all "previous run still active" collapse into one history row: "Skipped N times (HH:MM–HH:MM)", plus which run they were waiting on. A single skip, or a skip for another reason (the node is gone, the node is not usable, or a missed run was skipped), stays on its own row. The Hub still stores one row per tick. Collapsing is only how this page draws them. If the run being waited on is not on this page of history, the row says so and does not guess. Earlier desktop versions list every skip on its own row.

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

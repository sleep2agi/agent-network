# Tasks

The Tasks page in the desktop app and on Android is where people arrange their own work. It is not the inbox on the [Web Dashboard](/en/guide/dashboard): the inbox is messages dispatched inside a session; this page is task cards. Agents read and write the same records through the [requirements API](/en/api/mcp-tools#requirements-task-board). Fields, permissions and sync live in that section; they are not repeated here.

It is also not the [session-task lifecycle](/en/concepts/task-lifecycle). That page is the state machine for messages sent to an agent, not these cards.

iOS is still TestFlight only, and the public link is not open. This page describes what you can click on desktop and Android.

## List and board

Open Tasks in the nav. On a phone it is in the bottom bar; on a wide unfolded screen it is in the left rail.

The top bar switches between List and Board, and also filters and creates tasks. The board has three columns: Backlog, In progress and Done (需求池 / 进行中 / 完成 in the Chinese UI). On desktop, drag a card to another column; on a phone, long-press the card for the menu. Open a card and edit it in the detail drawer.

The left side filters by All, Assigned to me, Unassigned, By Agent, By node or project, and also opens the Dispatch log.

On an older Hub, when the description, checklist, subtasks or issue links are not available yet, the client asks you to upgrade. The desktop app's built-in local Hub already supports the operations on this page.

## Projects

Create them in Manage projects in the left rail. A project has a color, and task cards show that tag. You can filter by project.

A name is at most 40 characters and cannot duplicate an existing one. An archived project cannot be selected again; tasks already in it keep the project.

## Checklist and subtasks

These are two different things, and the UI names them differently:

- **Checklist** (子任务 in the Chinese UI): tick-boxes on one card. Add or remove them; on desktop, drag to reorder. The card shows how many are done.
- **Subtasks** (子需求 in the Chinese UI): separate task cards nested under the current one. In the detail drawer, use + New subtask. At most 5 levels. The card shows subtask progress and can jump back to the parent. The filter can show Top level only. Deleting a parent keeps its subtasks and makes them top level.

## Due date

A due date can be all day, or a time to the second. The screen shows the time in your local timezone; the Hub stores UTC. An all-day task is not overdue until that local day has ended. The detail view shows the local time to the second; with a pointer, hovering does too.

### Due reminders

Every 10 minutes the Hub checks open, unarchived tasks that have a due date. It reminds the owner and the participants (people). With node reminders on, the agent owner also gets a message that needs no reply:

- **Due soon**: an all-day task due tomorrow, or a due time within 24 hours. Once per due date.
- **Due today**: due today and not yet past. Once per due date.
- **Overdue by N days**: at most once a day; stops after 7 days overdue.

"Today" is the day in UTC+8 (Asia/Shanghai). Reminders stop as soon as the task is done, archived, or its due date is cleared or moved later. A moved due date gets reminders again for the new date. Restarting the Hub does not send them twice.

Reminders show up in the conversation with the agent owner. With no agent owner, or one you cannot see, the sender is "任务提醒" (task reminder).

No backlog: the first time the Hub checks a network, it records that moment as the start. Only tasks that become overdue after it get overdue reminders. Turning the feature on, or adding a network to the allowlist, does not remind people about every task that was already overdue.

Operators can change this with environment variables:

- `COMMHUB_DUE_REMINDERS=0`: turns it off, unless `COMMHUB_DUE_REMINDERS_NETWORKS` or `COMMHUB_DUE_REMINDERS_OWNERS` below is also set.
- `COMMHUB_DUE_REMINDERS_NETWORKS=<network id,network id>`: only these networks get reminders. Together with `COMMHUB_DUE_REMINDERS=0`, it turns reminders on for these networks only and leaves every other network off. Use it when one Hub hosts several teams and you want to start with your own network.
- `COMMHUB_DUE_REMINDERS_EXCLUDE_NETWORKS=<network id,network id>`: while reminders are on, these networks get none. A network on both lists is excluded.
- `COMMHUB_DUE_REMINDERS_OWNERS=<user id,user id>`: only tasks whose owner is on this list get reminders. For those tasks the owner, the participants and the agent owner are reminded as usual; tasks owned by anyone else, and tasks with no owner, get none. Set together with a network list, a task must match both. Like `COMMHUB_DUE_REMINDERS_NETWORKS`, it also turns reminders on while `COMMHUB_DUE_REMINDERS=0`. Use it when several teams share one network, so a network list cannot separate them. The startup log line gains `; only cards owned by <user id>`. The no-backlog start is tracked per network and owner: a person added to the list later starts from the moment they are added.
- `COMMHUB_DUE_REMINDER_NETWORKS=<network id,network id>`: the older name. Only these networks get reminders; unset means all networks. It does not turn reminders on when `COMMHUB_DUE_REMINDERS=0`.

For these lists, an empty value, or one with only spaces and commas, counts as unset. Once a list is set, only the listed networks get reminders, also with `COMMHUB_DUE_REMINDERS=1`. With none of them set, nothing changes. At startup the Hub logs the scope in one line, with network ids only, for example `[due-reminders] scope: only networks <network id>`. Tasks in networks outside the scope are never read, and no start time is recorded for them; if you add a network later, its start is the moment you add it.
- `COMMHUB_DUE_REMINDER_NODES=1`: also messages the agent owner. Off by default; only people are reminded.
- `COMMHUB_DUE_REMINDER_TICK_MS`: the check interval.
- `COMMHUB_DUE_REMINDER_TZ`: the timezone.
- `COMMHUB_DUE_OVERDUE_MAX_DAYS`: how many days overdue reminders continue.

Agents find due tasks with `requirements_list`: `overdue: true` lists overdue tasks only; `due_within_days: N` lists tasks due from today to N days from now that are not overdue yet (0 = today). Both only include open tasks. The REST list takes the same names (`overdue=1`, `due_within_days=N`).


## Delivery and alert thresholds

Once a task is dispatched, three thresholds govern what happens next. They only affect **alerts and cleanup** — not the delivery/retry semantics themselves.

### Offline target: cleaned up after 30 minutes

A task sent to an **offline** node does not sit around for 24 hours: after 30 minutes it becomes `expired`, its inbox row is acked, and the sender gets a notice. The recorded event is `task.expired`.

Only the "target is definitely gone" case is handled:

| Target state | Action |
|---|---|
| `offline` / no session row | past the threshold ⇒ expire |
| `working` (busy with another task) | **not touched** — reported as `queued_behind_busy` |
| already consumed (`consumed_at` set) | not touched (orphan detection owns it) |

- `COMMHUB_OFFLINE_DELIVERY_TTL_MINUTES`: default `30`; `0` disables.

### "Delivery looks stuck" alerts: judged against each target's own pace

When a task has been delivered but the target has not started consuming it, the Hub records a warning event. The threshold is not a global constant:

```
waited > max(global floor, that target's own p99 × 1.5)   (capped at 30 minutes)
```

- global floors: 10 minutes (tier 1), 30 minutes (tier 2);
- the per-target p99 is recomputed hourly from the last 7 days of **successful** tasks (needs ≥ 20 samples, otherwise the global floor applies);
- the 30-minute cap: however slow a node is, waiting 30 minutes must still alert.

So "everyone is running long turns tonight" no longer floods the alert stream, while "one specific node is stuck" still shows up. When the target is busy with another task the event is `queued_behind_busy_*`; only idle/offline targets produce `delivered_stale_*`.

To see the thresholds actually in force (the table is a cache — clear it to fall back to the global floors):

```bash
sqlite3 ~/.commhub/commhub.db "SELECT alias, p99_seconds, samples FROM alias_latency_baseline ORDER BY p99_seconds DESC LIMIT 10;"
```

### Repeatedly failing schedules: automatic slowdown

A schedule that keeps failing does not keep retrying at its normal interval:

```
consecutive failures < N  → unchanged
consecutive failures ≥ N  → interval × 2 (doubles per extra failure, capped at 1 hour)
one success               → interval restored immediately
```

- `COMMHUB_SCHEDULE_FAILURE_BACKOFF_RUNS`: default `6`; `0` disables;
- only `interval` schedules in `active` state are affected;
- mutually exclusive with the "no changes" backoff (`no_change_backoff`) — they never rewrite the same column.

> Why: an external cause such as an exhausted quota, retried every 3 minutes, produces hundreds of failed rows a day and drowns the real failure rate. Slowing down keeps self-healing while keeping the metrics honest.

## GitHub Issues

In the detail drawer, use + Link issue. Paste an issue URL, or type `owner/repo#123` (number 1–10000000). You can link several, up to 8 by hand. Linking and unlinking save immediately. Cards and the list show how many are linked, and a click opens the issue in the browser.

The one that arrived by sync is marked Sync source and cannot be unlinked here. The same issue cannot be linked twice.

Agents sync idempotently with `external_ref` (such as `github:owner/repo#123`). See [Requirements / task board](/en/api/mcp-tools#requirements-task-board).

## Tags

See [Task tags](/en/guide/task-tags).

## See also

- [Desktop and Mobile Clients](/en/guide/desktop-app)
- [Task tags](/en/guide/task-tags)
- [Requirements / task board](/en/api/mcp-tools#requirements-task-board)

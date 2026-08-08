# Goals and Loops

Dashboard passes `/goal` and `/loop` unchanged to the target node's runtime/TUI. Agent Network scheduling uses `/aloop`; `/agoal` is a namespaced alias for the same scheduler and also requires an explicit interval.

## Semantics at a glance

| Input surface | `/goal` / `/loop` | `/aloop` / `/agoal` |
|---|---|---|
| Authenticated Dashboard Chat → any agent-node runtime | Passed unchanged to that runtime/TUI; the ANet scheduler does not interpret it | Creates an ANet recurring task and requires an explicit interval |
| Other agent-node inbox paths | Compatibility path: still creates an ANet recurring task and returns a migration notice | Creates an ANet recurring task and requires an explicit interval |
| `anet node loop` | Not emitted | Always emits `/aloop` on the wire |

“Authenticated Dashboard Chat” is not inferred from a sender name. The Hub stamps authenticated origin metadata. Old rows, ordinary node messages, and node-forged fields do not unlock pass-through routing.

The target runtime defines the native meaning of `/goal` and `/loop`; ANet does not rewrite them. If a Dashboard command contains an old scheduler-shaped interval, such as `/loop 5m check logs`, the reply includes a migration notice while the original command still reaches the runtime. Use `/aloop` when you want ANet scheduling.

## Create a recurring task

The simplest operator command is:

```bash
anet node loop my-agent "check open issues" --every 5m
```

`--every` accepts `m`, `h`, and `d`, such as `5m`, `2h`, or `1d`; it defaults to `5m` when omitted. The command submits `/aloop` to an online node and waits up to 15 seconds for the node's creation reply. Merely enqueueing the Hub task is not reported as success.

You can also send slash text through Dashboard Chat, a CommHub task, or another surface that delivers text to the node:

```text
/aloop 5m check open issues
/aloop hourly summarize progress
/agoal daily write a daily report
```

The text parser accepts minutes, hours, days, `hourly`, and `daily`. The minimum interval is one minute. Bare numbers and sub-minute intervals are rejected.

::: warning Native commands and ANet scheduling are separate capabilities
Dashboard `/goal` and `/loop` belong to the target runtime. For example, a standalone `claude-code-cli` session has its own `/loop`, which is not managed by this page's `goals.json`. Use `/aloop` or `/agoal` for the ANet scheduler described here.
:::

## What happens on each wake

At startup, a node loads its own goal store. The scheduler checks for due work about every 30 seconds by default, so `/aloop` is not a precision cron service. A long model turn can introduce additional delay.

For each due goal the node:

1. records a wake entry;
2. injects the goal, cadence, and five most recent progress entries;
3. asks the model to inspect current state and make one incremental advance;
4. stores a response summary, failure count, and next wake time; and
5. for loops created by an inbound task, attempts to report to the original sender.

The scheduler marks a goal complete automatically only when the model emits `GOAL_COMPLETE`, `GOAL COMPLETE`, or `目标已完成` on a line by itself. Ordinary prose such as “3 tasks completed” does not stop the loop.

After five consecutive failures by default, a goal is automatically changed to `paused` to prevent unbounded retries and quota use. Resume it after fixing the cause. Any successful wake resets the consecutive-failure count.

## Inspect and manage goals

```bash
anet goal list [node]
anet goal show <node> <goal-id>
anet goal wake-log <node> <goal-id> [--tail N] [--json]
anet goal edit <node> <goal-id> --interval 10min
anet goal edit <node> <goal-id> --text "new task text"
anet goal edit <node> <goal-id> --status paused
anet goal cancel <node> <goal-id>
```

A uniquely matching goal-ID prefix is accepted. Common statuses are:

| Status | Meaning |
|---|---|
| `active` | Eligible for scheduling |
| `paused` | Retained but not woken; resumable |
| `complete` / CLI compatibility value `completed` | Goal achieved; terminal |
| `failed` | Unrecoverable failure; terminal |
| `cancelled` | Cancelled; terminal |

`anet goal show` displays only the last ten progress entries. Use `wake-log` for the complete history or JSON output.

### Limitation of local edits

`anet goal edit` and `anet goal cancel` modify the local file directly. A running agent-node uses its already-loaded in-memory state and does not hot-reload external edits; restart that node after a change. `list`, `show`, and `wake-log` are read-only.

For immediate changes while the node remains online, have the node use the self-management tools below.

## Agent self-management tools

Agent-node runtimes with self-management support expose six tools scoped to the current node:

| Tool | Purpose |
|---|---|
| `list_my_loops` | List this node's loops |
| `create_my_loop` | Create an interval, daily wall-clock, or weekday schedule |
| `edit_my_loop` | Change task text, schedule, or paused state |
| `reschedule_my_loop` | Delay only the next wake without changing the recurring cadence |
| `complete_my_loop` | Mark the goal achieved |
| `cancel_my_loop` | Cancel the goal |

The tools have no alias argument and cannot manage another node. They are currently wired into `claude-agent-sdk`, `codex-sdk`, `codex-app-server`, and Grok agent-node paths. OpenCode and standalone `claude-code-cli` do not use this self-management tool set.

The tools enforce three additional controls: at most 20 active goals per node by default, a 30-second edit cooldown per goal, and confirm-back after repeated batch cancellation within 30 seconds.

Structured schedules support:

- `interval`: fixed interval, minimum 60 seconds;
- `time_of_day`: a daily `HH:MM`; and
- `weekday`: selected weekdays at `HH:MM`.

Wall-clock schedules use the node's `flags.timezone`, defaulting to `Asia/Shanghai`. `anet node loop`, `/aloop`, and `/agoal` currently create interval schedules only; use self-management tools for daily or weekday schedules.

## Persistence, restart, and runtime changes

Each node stores state at:

```text
.anet/nodes/<node>/goals.json
```

The agent-node store writes through a temporary file plus atomic rename and tightens the file to mode `0600`. `anet goal edit/cancel` is a separate local-file writer; on a multi-user host, verify that `goals.json` remains owner-only when restarting the node after either command. If parsing fails, the node preserves a `.corrupt.<timestamp>` copy and continues with an empty store.

Goals survive a node restart. No wake runs while the node is offline; after recovery, an overdue active goal runs on the next scheduler check. If the node changes to an incompatible runtime bucket, active goals are archived to `.runtime-switched.<timestamp>` and the new runtime starts with an empty store, preventing incompatible thread or session IDs from crossing SDKs.

## Troubleshooting

```bash
anet goal list <alias>
anet goal show <alias> <goal-id>
anet goal wake-log <alias> <goal-id> --tail 20
anet info <alias>
anet logs <alias> --follow
```

Check that the node is online, the status is still `active`, `next_wake_at` is due, the goal was not auto-paused after repeated failures, and your current project directory contains the intended node state.

Every wake consumes real model quota. Start with a conservative interval and verify the stop condition and report shape before shortening it.

# CommHub Server — "queued behind a busy target" stops pretending to be "possibly offline", v0.9.0-preview.161

Ships `main` after `.160`. Alert classification only: no delivery, retry or status semantics change.

```
@sleep2agi/commhub-server@0.9.0-preview.161
```

## Why

`delivered_stale_*` used to fire when a task had been `delivered` for 30/60 s, with the copy
"target may be offline or not consuming". Measured on production (24 h):

```
tasks                    4277
tasks with a stale alert  301   (7.0 %)
  …that eventually replied 251   (83.4 %)
  …that eventually failed   35
```

Real wait times for those tasks (`delivered → started`):

```
target state   n     p50     p90     max
working       193    2.9    27.5    62.2
offline         8    1.4    13.5    13.5
idle           17    3.6    21.2    25.4
```

So the **event was factually right** — the target really had not started — but **the interpretation was
wrong for the majority**: the target was busy with another task and this one was simply queued.
Reporting queueing as "possibly offline" is what makes ~500 alerts/day read as noise and it is how a
real stall gets ignored.

## What changed

| target state at alert time | before | after |
|---|---|---|
| `working` | `task.warning.delivered_stale_<N>s` + "target may be offline" | **`task.warning.queued_behind_busy_<N>s`** + "queued after Ns; target is working on another task" |
| `idle` | same as above | `task.warning.delivered_stale_<N>s` + "target is not working on another task and has not started" |
| `offline` / no session row | same as above | `task.warning.delivered_stale_<N>s` + "target is idle or offline and not consuming" |

Nothing is suppressed: **both classes are still written**, so real latency stays visible — dashboards
and on-call can now filter queueing separately from "nobody is consuming this".

Implementation notes:

- still **one** INSERT per threshold, choosing the event name and copy with `CASE` on the target's
  session status — this keeps the `test683` mutation anchors (write-once gate, `status='delivered'`
  only, network propagation) exactly one-hit, so the mutation gate keeps its original coverage;
- the watcher stays **synchronous** (`db.run` is sync): patrol is a side channel and must never
  re-order the scheduler by awaiting;
- `event_key` remains the event type, so write-once per (task, threshold) is unchanged — a task that
  later becomes idle does **not** get retro-flagged as stale, which is deliberate: the alert describes
  the moment it fired.

## What this does NOT do

- Does not change delivery, ack, retry or status transitions;
- Does not silence real stalls: `idle` / `offline` targets still warn;
- Does not touch `task.started` / `task.replied` semantics.

## Verification

```
server/src/task-lifecycle-watcher-busy.test.ts   4 pass
  · target working      → only queued_behind_busy_*
  · idle/offline/no row → only delivered_stale_*
  · both classes stay write-once
  · copy is distinguishable in both directions

server/src/task-lifecycle-watcher.test.ts        4 pass (1 pre-existing sandbox failure, fails on clean main too)
```

24 h after rollout the acceptance is: `delivered_stale_*` no longer contains `working` targets
(≈250/day → ≈50/day), while `idle`/`offline` counts do **not** drop.

## Install

```bash
set -e
npm install -g @sleep2agi/commhub-server@0.9.0-preview.161
commhub-server --version   # 0.9.0-preview.161
```

## Upgrade

`commhub-server` installed globally is only used when you run the Hub yourself; `agent-node` fetches the
paired version on its own.

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.161
commhub-server --version   # 0.9.0-preview.161
curl -s http://127.0.0.1:9200/health | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["version"], d["mcp_inflight"], d["mcp_inflight_peak"])'
```

After upgrading, the first patrol writes the new event names; existing `delivered_stale_*` rows stay
as they are (history is not rewritten).

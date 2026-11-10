# commhub-server 0.9.0-preview.248

Since `.247`: `/health` now answers **"how many tasks died without ever being picked up, and by which
node"** — the reading that was missing when a fleet node kept expiring everything sent to it.

## Why

One node had four tasks queued, and they expired one after another (60 min each, never consumed).
The Hub *did* notify the sender each time ("task expired"), but nothing anywhere said
**"this node has now expired N tasks without taking any"** — so the dispatching side had to remember
it by hand.

## What is added

`GET /health` (authenticated projection) → `counters.task_expiries_never_consumed`:

```json
{ "since": "2026-10-31T18:30:00.000Z", "total": 9, "by_node": { "TM官网运维": 9 } }
```

Three constraints, same as `task_rejections`:

1. **Bucketed by node**, not one total — the question is *which* node.
2. **Window is explicit** (`since` = process start). A counter that resets on restart is
   indistinguishable from one that never fired, unless the window is read with it.
3. **Finite key set** — node aliases come from the node table, not from request content.

### The one distinction that matters

Only tasks that expire with **no `consumed_at`** are counted. A task with `consumed_at < expires_at`
was picked up and simply never reported back — `server.ts`'s own #500 comment says so. Counting those
too would turn this number into "how many tasks expired", which is a different and far less useful
reading.

## Verification

`expiry-counters.test.ts` (5 pass) — positive control and negative case both present:

- an **unconsumed** task expires ⇒ that node's counter +1 (must-fire);
- a **consumed** task expires ⇒ the counter **does not move** (the negative case; without it the
  counter would silently become "expired count");
- two nodes, one each ⇒ `{a: 1, b: 1}`, total 2;
- same node N times ⇒ accumulates (the shape of "this node never takes work");
- buckets sorted by name, empty buckets absent, so two snapshots can be diffed directly.

`health-redaction.test.ts` (91 pass) — the `/health` shape is otherwise unchanged.

## Behaviour

- Additive field only; nothing is renamed or removed.
- The counter starts at zero on every process start — historical expiries are **not** backfilled.
  That is the honest state of a windowed counter, not a defect.

## Install

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.248
```

## Upgrade

```bash
# hub started by `anet hub start`
anet hub stop && anet hub start --server-version 0.9.0-preview.248
# hub run by pm2 (production profile)
HUB_RUNTIME_DIR=~/.commhub/runtime-0-9-0-preview-248 pm2 restart <name> --update-env
```

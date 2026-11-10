# commhub-server 0.9.0-preview.251

Since `.250`: the "never picked up" gate now **expires**. Counting alone made a recovered node
permanently unacceptable.

## Why

`.250` refused dispatch to a target with ≥3 never-consumed expiries — with no decay. A node that
expired three tasks, then recovered, stayed blocked until the hub process restarted. That is not a
safety feature; it is a permanent blacklist that the operator cannot see the reason for.

The trigger for noticing was a reading from another machine (TM 中转运维): even the *suppressed
count* of journald is itself evicted by the ring buffer — the oldest `Suppressed` line sat 3.5
minutes after the buffer's own start, so the "total" was only "the part not yet evicted".
**Any cumulative counter is only quotable inside its window.**

## What changed

- Each bucket now carries `last_at` — when that node last expired a task without anyone taking it.
- `/health.counters.task_expiries_never_consumed` gains `last_at` alongside `by_node`:

  ```json
  { "since": "...", "total": 9, "by_node": { "ghost": 9 }, "last_at": { "ghost": "2026-10-31T19:20:00Z" } }
  ```

- The gate refuses only while the pattern is **fresh**: if the most recent expiry is older than
  `NEVER_CONSUME_STALE_MS` (2 h), dispatch is allowed again. The count stays in the readout —
  **the reading does not decay; the verdict does.**

## Verification

`expiry-counters.test.ts` (13 pass):

- last expiry 1 minute ago ⇒ still refused;
- **last expiry older than the TTL ⇒ allowed** (the node may have recovered);
- `last_at` is present in the readout (a count alone cannot say "how long since the last one");
- the five older gate cases were re-pinned with a **fake clock** — without it they silently became
  "stale ⇒ allowed", which is exactly how they failed on the first run.

`node-health-dispatch-http` and `task-expiry-notice` stay green.

## Install

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.251
```

## Upgrade

```bash
# hub started by `anet hub start`
anet hub stop && anet hub start --server-version 0.9.0-preview.251
# hub run by pm2 (production profile)
HUB_RUNTIME_DIR=~/.commhub/runtime-0-9-0-preview-251 pm2 restart <name> --update-env
```

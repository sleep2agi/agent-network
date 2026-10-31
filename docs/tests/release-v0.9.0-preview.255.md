# commhub-server 0.9.0-preview.255

Since `.254`: the rejection counter's **total** is now readable without a token, next to the expiry
counter shipped in `.254`.

## Why

`/health.counters.task_rejections` (with `by_reason`) is in the authenticated projection only. The
same reasoning as `.254` applies: a number that only a token holder can read cannot be cited by
whoever is writing the criterion — including the person who wrote it.

## What is added (anonymous `/health`)

| key | meaning |
|---|---|
| `task_rejections_total` | how many requests were rejected, process-lifetime, window = `counters_since` |

`by_reason` stays in the authenticated projection: counts are scale, reason keys are detail. Same
split as `task_expiries_never_consumed_total` vs `by_node`.

## Install

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.255
```

## Upgrade

```bash
anet hub stop && anet hub start --server-version 0.9.0-preview.255
# or, pm2-profile:
HUB_RUNTIME_DIR=~/.commhub/runtime-0-9-0-preview-255 pm2 restart <name> --update-env
```

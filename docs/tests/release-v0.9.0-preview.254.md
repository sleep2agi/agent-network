# commhub-server 0.9.0-preview.254

Since `.253`: the dispatch-side hard gate's counter becomes readable **without a token** — as an
aggregate only.

## Why

`#3271` shipped a per-node counter (`counters.task_expiries_never_consumed`) whose stated purpose was
operational: "did the gate ever fire?". But `counters` is not in the anonymous projection, so anyone
without a token — including the person who wrote the criterion — could not read it. A must-fire
check only a token holder can see is not a check.

## What is added (anonymous `/health`, two scalar keys)

| key | meaning |
|---|---|
| `task_expiries_never_consumed_total` | how many tasks expired without ever being consumed |
| `counters_since` | the window start (counters reset on restart, so a total alone cannot tell "just restarted" from "never happened") |

`by_node` / `last_at` stay in the authenticated projection: node names are topology, counts are not.
This is the same split the Hub already makes for `sessions_count`.

## What it does not do

It does not name the offending nodes anonymously. To answer "which node", use an authenticated read.

## Install

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.254
```

## Upgrade

```bash
# hub started by `anet hub start`
anet hub stop && anet hub start --server-version 0.9.0-preview.254
# hub run by pm2 (production profile)
HUB_RUNTIME_DIR=~/.commhub/runtime-0-9-0-preview-254 pm2 restart <name> --update-env
```

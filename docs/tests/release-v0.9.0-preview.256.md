# commhub-server 0.9.0-preview.256

Since `.255`: the dispatch-side never-consume gate now survives a restart.

## The bug, measured in production

`.254` was deployed at 22:39. At 22:45 a task to a node that had already expired **ten** tasks
without ever consuming one was accepted (`ok: true`, `queue_ahead: 0`). The gate read only the
in-process counter, and the counter is emptied by every restart.

> The lifetime of the evidence was shorter than the lifetime of the failure: failures are measured
> in weeks, counters in "this process", and deploys are far more frequent than recoveries.

## Fix

Evidence is now the **union of two sources**:

- the in-process counter (freshest events, this process only);
- `tasks` rows with `status='expired' AND consumed_at IS NULL` within a 7-day lookback — written at
  the moment the expiry happened, so a restart cannot erase them.

The count is `max(...)`, not a sum: one expiry leaves a trace in both places and summing would
double it. The staleness window uses the **newer** of the two `last_at` values, so a node that
genuinely recovered is not blocked forever.

## Verification

`expiry-counters.test.ts` — 16 pass, including the case that caught this:
memory empty + three rows ⇒ must refuse; memory 2 + rows 3 ⇒ refuses as 3; rows older than the
stale window ⇒ allowed.

## Install

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.256
```

## Upgrade

```bash
HUB_RUNTIME_DIR=~/.commhub/runtime-0-9-0-preview-256 pm2 restart <name> --update-env
```

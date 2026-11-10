# commhub-server 0.9.0-preview.257

Since `.256`: the never-consume gate now measures the right thing, and its staleness window no
longer decides by wall-clock.

## The measurement that changed the criterion

Production, right after `.256` went live, the same dispatch was still accepted. The database said:

```
TM官网运维   replied 252   ← it does work
             expired  37   consumed_at NULL for all of them
whole DB     consumed_at non-null 83,332   ← the column is used normally elsewhere
last reply  2026-10-31 00:38 (≈22h ago)
```

`consumed_at IS NULL` is **not** "never took a task": this node answered 252 of them and simply
never writes that column. The counter was named after a behaviour and implemented after a field.

## New criterion

Count tasks that expired **without a reply after the target's last successful reply**. A target
that has replied since is alive — it just missed those. Database evidence carries its own boundary,
so the fixed 2-hour staleness window no longer applies to it; that window remains only for the
in-memory counter, which has no reply time to compare against.

## Verification

`expiry-counters` 17 pass · `expiry-evidence-db` 6 pass (SQL boundary itself: expiries before the
reply do not count, expiries after do, "expired but answered" does not, never-replied ⇒
`last_reply_at: null`, out-of-window ignored, other aliases isolated).

## Install

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.257
```

## Upgrade

```bash
HUB_RUNTIME_DIR=~/.commhub/runtime-0-9-0-preview-257 pm2 restart <name> --update-env
```

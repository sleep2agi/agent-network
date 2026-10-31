# commhub-server 0.9.0-preview.252

Since `.251`: the Hub accepts, stores and projects a node's **build commit** — so "which bytes is
this node running" becomes answerable, not just "which version label".

## Why

`version` is a label. Two installs with the same label can be different bytes; the fleet-upgrade work
(`#3178`) has to answer "which one is this box running" *before and after* every upgrade, and until
now the only available answer was the label.

## What is added

Three layers, all required — a missing one is indistinguishable from a node-side bug:

| Layer | Where |
|---|---|
| schema | `report_status.build_commit` — `^[0-9a-f]{7,40}$`, optional |
| storage | `sessions.build_commit` (idempotent `ALTER TABLE`, own `UPDATE` so the pinned INSERT bytes stay untouched) |
| projection | `GET /api/nodes` → `build_commit` + `build_note` |

`build_note` exists because **`null` has two causes**: an old node that never reports the field, and
a node that reported but has no build-info file. Collapsing them sends the reader after the wrong
thing.

## What it does not do

It does not *produce* the value — that is the node's job (`agent-node@2.5.0-preview.170` reads a
`build-info.json` written at package time). An old Hub silently drops the unknown key, so shipping
the sender first is safe; this release is the receiving half.

## Verification

`build-commit-report-http.test.ts` (3 pass), in this order on the same node row:

1. not reported ⇒ `build_commit: null` **and** `build_note` says so;
2. reported ⇒ the projection carries the 40-hex value, and it is **not** the version label;
3. a malformed value is **rejected by the schema** — a bad value must not look like "not sent".

## Install

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.252
```

## Upgrade

```bash
# hub started by `anet hub start`
anet hub stop && anet hub start --server-version 0.9.0-preview.252
# hub run by pm2 (production profile)
HUB_RUNTIME_DIR=~/.commhub/runtime-0-9-0-preview-252 pm2 restart <name> --update-env
```

# CommHub v0.9.0-preview.240

Built from main at `df9f72491`.

## What changed

**`assignee` is reconciled on write, and reference ids are rendered as names.**

Requirement cards carry two overlapping notions of "who": `owner` / `agent_owner` (validated refs:
a user must be in the network, an agent must be a node of the network) and `assignee` (free text with
its own older write path). Measured on the ANet project: 25 of 1105 cards had an `assignee` that
contradicted their refs.

- On write, when a caller sets `owner` / `agent_owner` **and does not pass `assignee`**, the display
  field is backfilled from the resolved ref in the same statement — so drift stops accumulating.
  An explicitly passed `assignee` still wins, because it may name someone outside the system.
- On read, refs are stored as `{kind, id}`; the id is resolved back to `nodes.alias` /
  `users.username` for display. Previously a stale text value could be replaced by a raw id like
  `n_ab12`, which reads like data instead of reading like stale data.

When both exist, the validated ref wins on read. That is deliberate: the ref was checked at write
time, the free text was not. It is documented in the test so it is not "fixed" back later.

Migration: none. No route, table or key changed.

This note is not proof of publication. Publish only by running `release.yml` from the full main SHA
that contains these changes: package `@sleep2agi/commhub-server`, version `0.9.0-preview.240`,
channel preview.

## Install

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.240
```

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.240
```

## Rolling back

`0.9.0-preview.239` shows the stale free-text `assignee` and does not backfill it on write.

Do not overwrite published packages.

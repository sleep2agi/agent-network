# CommHub v0.9.0-preview.244

Built from main at `0efe7b05`.

## What changed

**The `never_switched` hint now carries an action.**

`GET /api/nodes/:id/provider-selection` used to answer, for a node that had never been switched:
"显示的是它本地的默认配置（不是 Hub 的读数）". That describes the state and stops there — a reader
knows what is true and still has to invent the next step.

It now also says what to do: `POST` the same route with `{revision, selection}`, then `GET` again and
read `state` back to confirm `applied`. A test pins the requirement itself (the hint must contain a
first step), not just the phrase about local defaults — the old assertion was satisfied by simply
restating the current state.

No other hint changed; all five hint strings in the hub were checked for an actionable token.

Migration: none. Response shape unchanged (same key, longer text).

This note is not proof of publication. Publish only by running `release.yml` from the full main SHA
that contains these changes: package `@sleep2agi/commhub-server`, version `0.9.0-preview.244`,
channel preview.

## Install

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.244
```

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.244
```

## Rolling back

`0.9.0-preview.243` shows the previous, descriptive-only hint. Nothing else differs.

Do not overwrite published packages.

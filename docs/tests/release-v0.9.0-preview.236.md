# CommHub v0.9.0-preview.236

Built from main at `d1c281835`.

## What changed

**`GET /api/providers` now reports three states instead of two.**

| state | when |
|---|---|
| `unconfigured` | no provider rows for the network |
| `all_disabled` | rows exist, **every one has `enabled: false`** |
| `configured` | at least one enabled provider |

Before this release the endpoint only ever produced the first and the third: a network whose providers
were all switched off still read `configured`, so a client (and a human reading the JSON) saw
"configured" where the truth was "nothing is selectable".

The same response now carries explicit counts so clients do not have to re-derive them:

```
counts.providers / providers_enabled / providers_disabled /
models_enabled / providers_without_models / providers_in_cli_registry
```

`all_disabled` comes with its own `hint`: it is *not* "not configured yet"; the action is to enable one
provider (or delete them after confirming they are unused).

No route, table or write-path changed. The read shape only gains fields.

Migration: none.

This note is not proof of publication. Publish only by running `release.yml` from the full main SHA
that contains these changes: package `@sleep2agi/commhub-server`, version `0.9.0-preview.236`,
channel preview.

## Install

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.236
```

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.236
```

Clients that only understand `configured | unconfigured` keep working: they will treat `all_disabled`
as "not configured", which is inaccurate but safe (no models offered either way). Clients that want
the distinction must handle the third value.

## Rolling back

`0.9.0-preview.235` reads the same rows; only the reported `state`/`counts` differ. Rolling back makes
"all providers disabled" read as `configured` again.

Do not overwrite published packages.

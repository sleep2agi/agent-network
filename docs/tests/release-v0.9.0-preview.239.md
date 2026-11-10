# CommHub v0.9.0-preview.239

Built from main at `3373613b6`. This release bundles four changes that all answer the same question:
*which of two conflicting claims should a reader believe?*

## What changed

**1. `assignee` follows the reference that was validated on write.**

A requirement card's `assignee` is free text with its own (older) write path, so it can sit at a stale
value while `owner` / `agent_owner` changed. Measured on the ANet project (archived=0, 1105 cards):
25 cards disagreed, 22 of them had an `assignee` with no owner at all.

Reads now prefer the validated reference: `agent_owner.alias` → `owner.username` → free text.
Free text is kept when there is no reference, because it may name someone outside the system.

**2. Difference-shaped `/health` fields name their endpoints.**

`HealthFieldMeta` gains `derived_from`; `epoch_delta_ms` names `kernel_started_at` + `startedAt`,
`clk_tck_delta` names its two inputs. A test asserts both endpoints exist in the same payload — a
mistyped endpoint is a test failure, not a silently weaker claim. `uptime` deliberately declares no
endpoints: it is a monotonic reading, not `now − startedAt`.

**3. Readings declare their evidence domain.**

`scope_block` gains `evidence_domain ∈ {source, system, wire, artifact}` and `cross_domain`.
The keyset gate's JSON now reports `evidence_domain: "source"`, and the automatic consumer treats it
as a required key with a closed set.

**4. Time fields are convicted by difference, not by name.**

In a declared 1200 ms window: `uptime` must advance, `startedAt` must be byte-identical, `served_at`
must advance by at least the window. Mistaking one for the other is now a test failure.

Migration: none. No route, table or response key changed; only the value of `assignee` and the
metadata tables.

This note is not proof of publication. Publish only by running `release.yml` from the full main SHA
that contains these changes: package `@sleep2agi/commhub-server`, version `0.9.0-preview.239`,
channel preview.

## Install

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.239
```

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.239
```

## Rolling back

`0.9.0-preview.238` differs in that a stale `assignee` wins over `owner` / `agent_owner`, and the
health metadata lacks `derived_from` / evidence domains.

Do not overwrite published packages.

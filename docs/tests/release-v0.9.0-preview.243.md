# CommHub v0.9.0-preview.243

Built from main at `30c5e96f`.

## What changed

**Deleting a node now clears the requirements that referenced it.**

Measured on the production database (read-only): 31 dangling `owner` / `agent_owner` /
`participant` references across 3256 open cards. Grouping by referenced object reduces that to
**3 node ids**; two of those ids still had token rows in `api_tokens` while their `nodes` row was
gone — i.e. this was a hole in the *delete* path, not bad data entry.

- New `clearNodeFromRequirements(nodeId)`: cards whose `agent_owner` points at the node are cleared,
  the node is removed from `participants`, and the cards themselves are kept (they were correct).
- Both delete paths call it: the MCP `delete_node` completion branch and `DELETE /api/nodes/:id`.

**Read-side derivation was withdrawn** (worth recording): `assignee` used to be derived from
`owner` / `agent_owner` on read, which contradicted two existing contracts — "an explicit assignee is
not overwritten" and "an explicit clear stays empty". A read path cannot distinguish *never set* from
*explicitly cleared*, so any derivation guesses one of them wrong. Reads now echo the stored value;
the reference-to-name mapping is used only when backfilling on write.

Migration: none. Existing dangling rows are untouched by this release (the new path only stops
further growth); cleaning the 31 stale references is tracked separately.

This note is not proof of publication. Publish only by running `release.yml` from the full main SHA
that contains these changes: package `@sleep2agi/commhub-server`, version `0.9.0-preview.243`,
channel preview.

## Install

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.243
```

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.243
```

## Rolling back

`0.9.0-preview.242` leaves `requirements` references behind when a node is deleted, and derives
`assignee` on read (overwriting explicit values in the two cases above).

Do not overwrite published packages.

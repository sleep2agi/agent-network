# CommHub v0.9.0-preview.79

This release carries the Hub change merged since `0.9.0-preview.78` (cut from 6d216491). Production is on `0.9.0-preview.78`.

- #2199 (07c426d11ab7d53c93475e57e4d5d8807df0f96d) **`GET /api/stats/routes?minutes=N&by=caller` breaks each route down by caller class.**
  - A caller class is the token kind (`node`, `user`, `master`, `token`, `anon`) plus a coarse User-Agent family taken from an allow-list of product names, with the version cut to digits and one prerelease tag. Browsers become `browser`, an empty User-Agent becomes `none`, and anything else becomes `other`.
  - The token kind is read through `requestToken()`, the same reader auth uses (header first, then `?token=`). The master token is recognised by an equality check only.
  - Tokens, user and node ids, usernames, IP addresses and raw User-Agent strings are never stored.
  - At most 20 classes are kept per route, per minute bucket and again after merging buckets; the rest are counted under `(other)`.
  - Without `by=caller` the response is byte-identical to `.78`. Admin / master only, as before.
  - Purpose: production serves about 2.8 full `GET /api/status` reads per second (about 260 KB/s), and most connections arrive through the tunnel, so every caller looks like `127.0.0.1`. Upgrading 25 agent nodes to agent-node 2.5.0-preview.93 barely changed that rate, so the remaining callers need to be identified before the next fix.
  - Known gap: agent-node, `anet` and the dashboard send no User-Agent of their own (the runtime default is `node`), so `anet` and the dashboard both show as `user node`. Telling them apart needs a client-side User-Agent; that is a follow-up.

No other server change is in this release. #2198 only bumps agent-node and agent-network.

Checked in Docker with `tests/hub-release-compat`, candidate 07c426d11ab7d53c93475e57e4d5d8807df0f96d (clean tree), baseline `0.9.0-preview.78` from npm, apps 0.2.162–0.2.170 (`APP_TAGS` set explicitly):
- A1 and A2: steps=62, unexpected=0, check_failures=0 each.
- B, upgrade → rollback → re-upgrade on one database with the byte check: upgrade_check_failures=0.

#2199's own tests cover byte identity without `by`, class counts summing to the route totals, no tokens / ids / usernames / IPs / raw User-Agent in the output, the class cap, and 403 for member and node tokens. Mutations (raw UA stored, cap removed, breakdown always on, reader skipping `?token=`) each turn a test red.

This note is not proof of publication. Publish only by running release.yml from the full main SHA that contains these changes:
package `@sleep2agi/commhub-server`, version `0.9.0-preview.79`, channel preview.

## Install

In an isolated environment you are allowed to install into (the Hub needs Bun), install the exact version:

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.79
```

Startup, secrets and the data directory follow the repository deploy docs. The install command does not by itself switch any production process.

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.79
```

No new migrations. No table or column changes; route timing and caller classes live in memory and are cleared on restart.

## Rolling back

`0.9.0-preview.78` starts on a database that `.79` has run on, since `.79` changes no schema. After a rollback, `by=caller` is ignored and the response has no `callers` field.

Do not overwrite published packages. The package contains no existing data, users, network members or secrets.

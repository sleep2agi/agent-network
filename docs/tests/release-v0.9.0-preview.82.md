# CommHub v0.9.0-preview.82

This release carries the Hub change merged since `0.9.0-preview.81` (cut from 33f5e04e). Production is on `0.9.0-preview.81`.

- #2220 (f88ebcaf3861361aec3b2c2be84baf81beeb16ed) **Old agent-node alias lookups get a small status body.**
  - agent-node before 2.5.0-preview.93 resolves its own alias by calling `GET /api/status?network_id=…` with a node token and `Accept: application/json`, then reads only `sessions[].alias` / `node_id`, with a 2.5 s abort. The full body is ~94 KB gzip on a 306-session network; over a slow link many of these reads are aborted after the Hub has already sent the body, wasting the shared tunnel.
  - When all of these hold — node token (`ntok_`), `Accept` exactly `application/json`, and no query parameter besides `network_id` — the Hub now returns the light projection plus `node_id` and sets `X-Status-Projection: alias-resolver`. On production rows the body goes from 93,691 B to 30,010 B gzip (−67%).
  - `?full=1` always returns the full body. User tokens, the anet CLI (no `Accept`), `*/*` or multi-value `Accept`, and any `light` / `node_id` query keep their existing, byte-identical responses. Every agent-node build from .32 to .93, the CLI release sources, claude-code `node-server.js` and dashboard 0.6.0 were checked for their `/api/status` request shape; only the pre-.93 alias resolver matches.
  - No schema change.

No other server change is in this release.

Checked in Docker with `tests/hub-release-compat`, candidate f88ebcaf3861361aec3b2c2be84baf81beeb16ed (clean tree), baseline `0.9.0-preview.81` from npm, apps 0.2.166 / 0.2.178 / 0.2.183, `SCHED_BASELINE=counted CHECK_BYTES=1 EXPECT_BACKFILL=0`:
- A1 and A2: steps=62, unexpected=0, check_failures=0 each.
- B, upgrade → rollback → re-upgrade on one database with the byte check: upgrade_check_failures=0.

#2220's own test (`server/src/status-alias-resolver-http.test.ts`, 7 tests) runs the old resolver's exact fetch code and checks it still resolves alias↔node_id (including after a rename), and that every other request shape gets a byte-identical full body; 2 of 7 fail against the pre-change server. Server aggregate on the branch: 160 files, 1834 pass, 0 fail.

This note is not proof of publication. Publish only by running release.yml from the full main SHA that contains these changes:
package `@sleep2agi/commhub-server`, version `0.9.0-preview.82`, channel preview.

## Install

In an isolated environment you are allowed to install into (the Hub needs Bun), install the exact version:

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.82
```

Startup, secrets and the data directory follow the repository deploy docs. The install command does not by itself switch any production process.

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.82
```

No new migrations and no new tables.

## Rolling back

`0.9.0-preview.81` starts on a database that `.82` has run on, since `.82` changes no schema. After a rollback, old agent-node alias lookups get the full status body again.

Do not overwrite published packages. The package contains no existing data, users, network members or secrets.

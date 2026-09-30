# CommHub v0.9.0-preview.78

This release carries the Hub changes merged since `0.9.0-preview.77` (cut from 6227537c). Production is on `0.9.0-preview.77`.

- #2194 (fb84827dc72661f26449b7644acd9a652cd39980) **`GET /api/status?node_id=<id>` returns one node's rows.**
  - The filter is applied after the caller's network scope, so it never widens what the caller can read. An unknown id returns 200 with an empty list; a blank value is ignored.
  - It combines with `light=1`, in which case the light row also carries `node_id`. Without the parameter, full and light responses are byte-identical to `.77`.
  - `/health` advertises it as `capabilities: ["status_node_id"]`.
  - Purpose: each agent node read the whole network's `/api/status` every 30 s only to find its own row (about 3 req/s and 272 KB/s gzip on production). agent-node #2196 uses the filter when this capability is present; it ships in the next agent-node release.
- #2195 (e00122e7caa0b95ba1c29dc1f22a138c7bcc53d8) **Route timing labels `POST /mcp` by method and tool, and covers the requested window.**
  - The route key is `POST /mcp <method>`, or `POST /mcp tools/call <tool>`. Only `method` and `params.name` are read, only after auth and only for bodies of at most 1 MiB; tool arguments are never read, logged or stored.
  - The 4096-sample ring is replaced by per-minute per-route buckets kept for 24 h, so `GET /api/stats/routes?minutes=N` covers N minutes. The response shape is unchanged.

No other server change is in this release. #2196 changes only `agent-node/`, and #2193 only updates the download page.

Checked in Docker with `tests/hub-release-compat`, candidate 7fee51d1ed1fd59dcc6dd6b93657dfba083e3eae (clean tree), baseline `0.9.0-preview.77` from npm, apps 0.2.162–0.2.170 (`APP_TAGS` set explicitly):
- A1 and A2: steps=62, unexpected=0, check_failures=0 each.
- B, upgrade → rollback → re-upgrade on one database with the byte check: upgrade_check_failures=0.
- #2194's own HTTP tests cover scope (admin, member, node token, cross-network), byte identity without the parameter, and the `/health` flag, with mutations that turn them red. #2195's tests cover the per-minute window and the label guards.

This note is not proof of publication. Publish only by running release.yml from the full main SHA that contains these changes:
package `@sleep2agi/commhub-server`, version `0.9.0-preview.78`, channel preview.

## Install

In an isolated environment you are allowed to install into (the Hub needs Bun), install the exact version:

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.78
```

Startup, secrets and the data directory follow the repository deploy docs. The install command does not by itself switch any production process.

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.78
```

No new migrations. No table or column changes; route timing lives in memory.

## Rolling back

`0.9.0-preview.77` starts on a database that `.78` has run on, since `.78` changes no schema. This was checked in Docker: .77 → .78 → .77 → .78 on one database. After a rollback, `/health` no longer advertises `status_node_id`, and agent nodes that use it fall back to the full status read.

Do not overwrite published packages. The package contains no existing data, users, network members or secrets.

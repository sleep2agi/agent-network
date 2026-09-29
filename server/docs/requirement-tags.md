# Task tags

Requirements POST/PATCH accept `tags: string[]`. Maximum 10 entries, each 1–20
Unicode code points after trimming. Empty labels and control characters are
rejected with HTTP 400 `invalid_tags`; exact duplicates are collapsed. Labels
are case-sensitive. PATCH without `tags` preserves stored labels; `[]` clears.
GET returns `tags` (empty for older rows). The capabilities list contains `tags`.
The existing requirements MCP create/update/upsert tools accept the same field.

`GET /api/requirements/tags?network_id=<id>` returns
`{ok:true,networkId,tags:[...]}`: sorted unique labels from all tasks in that
network, including archived tasks. It uses the existing REST network scope and
requires a selected network, like the people endpoint. No global label table
or cross-network lookup is introduced. Node tokens stay in their bound network;
read-only members cannot modify tags.

Storage is an additive `requirements.tags_json` column, default `[]`, installed
by the normal db.ts startup migration. No ports, secrets, services or deployment
steps change. Existing Hub startup/upgrade/rollback procedures apply. Tag data
is database state and must be recovered from the same encrypted DB backup as
requirements; Git does not contain user tags. Older releases ignore the added
column; preserve the database when rolling back.

Isolated verification (no production database or port):

```sh
sg docker -c 'docker build -f server/tests/tags/Dockerfile -t anet-requirement-tags:test .'
sg docker -c 'docker run --rm anet-requirement-tags:test'
```

The HTTP suite creates a temporary DB inside the container and binds port 0.

# CommHub Server — sub-projects (project hierarchy), v0.9.0-preview.155

Ships `main` after `.154`. One additive column and the API to use it.

```
@sleep2agi/commhub-server@0.9.0-preview.155
```

## What changed

- **Projects can nest.** `requirement_projects` gains a nullable `parent_id`
  (`NULL` = top level), added with an idempotent `ALTER TABLE … ADD COLUMN` so an
  existing database upgrades in place and no row needs back-filling.

- **API**
  | Call | Change |
  |---|---|
  | `POST /api/requirements/projects` | optional `parent_id` |
  | `PATCH /api/requirements/projects/:id` | optional `parent_id` (`null` = move back to the top) |
  | `GET /api/requirements/projects` | each row carries `parentId` |
  | MCP `projects_create` / `projects_update` | same field |

- **Four rules, all refused explicitly rather than silently adjusted**
  1. **At most 3 levels** (a top-level project counts as level 1) → `400 project_parent_too_deep`;
  2. **No cycles** — under itself, or under one of its own descendants → `400 project_parent_cycle`;
  3. **The parent must be a live project in the same network** → `404 project_parent_not_found`
     (or `400 project_parent_archived` when it is archived);
  4. **A project with children cannot be deleted** → `409 project_has_children`. Sub-projects are
     never silently orphaned or re-parented; move or delete them first.

- **Errors are written for a person, not for a stack trace.** The six new codes carry a
  message and a hint that name `proj_…` ids and say what to do next.

## Compatibility

- **Additive.** Existing projects read `parentId: null`; nothing changes for a client that
  ignores the field.
- The MCP tool-list byte budget is unchanged in total: the new field's description was paid
  for by compacting three over-long project descriptions (the budget itself was not raised).

## What this release does NOT do

- No UI: the desktop/web client still renders a flat list until it uses `parentId`. The client
  repo already has the plumbing (`hubExposesProjectParent`), so it starts showing parent
  selection as soon as it talks to this Hub.
- Task→project references are unchanged: a task still points at exactly one project; nesting
  does not make a task inherit its parent project's tasks.

## Install

```bash
set -e
HUB_DIR="$HOME/.commhub/runtime-v155-preview155"
test ! -e "$HUB_DIR"
install -d -m 700 "$HUB_DIR"
umask 077
npm install --prefix "$HUB_DIR" --ignore-scripts --no-audit --no-fund \
  @sleep2agi/commhub-server@0.9.0-preview.155
```

## Upgrade

```bash
# 1) what is running now
curl -s localhost:9200/health | grep -o '"version":"[^"]*"'
# 2) build the new runtime dir (explicit version, never a bare tag)
DIR="$HOME/.commhub/runtime-v155-preview155"
install -d -m 700 "$DIR" && umask 077
printf '{"name":"commhub-runtime","private":true,"version":"1.0.0","dependencies":{"@sleep2agi/commhub-server":"0.9.0-preview.155"}}' > "$DIR/package.json"
(cd "$DIR" && bun install --production)
# 3) point HUB_RUNTIME_DIR at $DIR, then reload
pm2 reload commhub-hub --update-env
# 4) read the version back
curl -s localhost:9200/health | grep -o '"version":"0.9.0-preview.155"'
```

## Rollback

Point `HUB_RUNTIME_DIR` back at `runtime-v154-preview154` and reload. `.154` does not read
`parent_id`; the column stays but is ignored, so no data rollback is needed. Projects keep
their rows — a rolled-back Hub simply shows them as flat again.

## Verification

- `server/src/requirements-projects-parent-http.test.ts` — 6 pass: create a child and read the
  hierarchy back · move under another project and back to the top · the 3-level cap ·
  self-cycle and descendant-cycle · missing / archived / cross-network parent ·
  delete refused while children exist (allowed after they are gone).
- `server/src/mcp-projects-events-http.test.ts`, `requirements-status-participants-http.test.ts`,
  `tool-audience-http.test.ts` — the MCP surface, the "node tokens can only read" promise and
  the tool-list byte ceilings all still hold (86,264 / 86,500 bytes).
- Published after: `scripts/verify-hub-release.sh 0.9.0-preview.155` must PASS.

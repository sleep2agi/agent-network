# CommHub Server — agent departments over MCP, v0.9.0-preview.146

Ships `main` after #2913. The org tree is now something an **Agent** can read and
write through one MCP tool, instead of only a human clicking through the client.

```
@sleep2agi/commhub-server@0.9.0-preview.146
```

## What changed

- **New MCP tool `departments`** (#2913 / #1894) — one tool, five actions:
  - `list` — the department tree, each row carrying its agent count and children;
  - `create` / `update` / `delete` — name, parent, head, sort;
  - `assign_agent` — move one Agent into a department (`department_id: null` removes it).
- **Writes are owner/admin only.** A plain member of the network gets `forbidden`;
  every write is audited. Agents cannot grant themselves a department.
- **Deleting a department that still has Agents is refused** (`deleteDepartment`
  now counts Agents instead of silently orphaning them).
- Departments stay **network-wide**, not per person: this is the same tree the
  client's 「组织架构」 page renders.

Also in this release: the two `main` commits since `.145` that keep the release
gates honest (#2915 — release notes shape + getting-started version stamp).

## Install

```bash
set -e
HUB_DIR="$HOME/.commhub/runtime-v146-preview146"
test ! -e "$HUB_DIR"
install -d -m 700 "$HUB_DIR"
umask 077
npm install --prefix "$HUB_DIR" --ignore-scripts --no-audit --no-fund \
  @sleep2agi/commhub-server@0.9.0-preview.146
```

Run with the same env as the previous instance (at minimum `PORT` and `COMMHUB_DB`).
The database file is shared. This release adds no table.

## Upgrade / rollback

Prod runs the pinned runtime directory through `deploy/hub/hub-daemon.sh`, so an
upgrade means **a new `RUNTIME_DIR`**, not a `bunx` refetch:

```bash
# 1) what is running now
curl -s localhost:9200/health | grep -o '"version":"[^"]*"'
# 2) build the new runtime dir (explicit version, never a bare tag)
DIR="$HOME/.commhub/runtime-v146-preview146"
install -d -m 700 "$DIR" && umask 077
printf '{"name":"commhub-runtime","private":true,"version":"1.0.0","dependencies":{"@sleep2agi/commhub-server":"0.9.0-preview.146"}}' > "$DIR/package.json"
(cd "$DIR" && bun install --production)
# 3) point RUNTIME_DIR at $DIR in ~/.local/bin/hub-daemon.sh, then reload pm2
pm2 reload commhub-hub
# 4) read the version back
curl -s localhost:9200/health | grep -o '"version":"[^"]*"'
```

Rollback: point `RUNTIME_DIR` back at the previous directory and reload — this
release adds no table, so there is no data migration to undo.

⚠️ `anet hub start` fetches a **pinned** server version (`PINNED_SERVER_VERSION`),
so it does not track this release; use the runtime-directory path above for prod.

# CommHub Server — agent departments are explicit, v0.9.0-preview.144

One behaviour change, on the Hub side of the 「Agent 组织架构和人类组织架构是两个独立的」fix (#1974 / PR #2872).

The people directory now says at the top level that this hub supports **explicit** agent departments:

```
agent_department_supported: true
```

With that flag, the client reads "this agent row carries no `department_id`" as **"no explicit placement"** instead of "fall back to the owner's department" — the human department tree stops deciding where agents sit. The row shape does not change (an agent row carries `department_id` only when it is explicitly set), so older clients keep their behaviour byte for byte.

Why it matters, measured on the production network before this change: 339 nodes, **0** explicitly assigned to a department, and exactly **1** agent showing up inside a department — and only because its owner was in that department. The whole agent structure was one inferred agent, inferred from the human side.

Also in this release:

- `restart_node` keeps refusing an active node with in-flight work (unchanged, from .142);
- the exact-pair gate now also runs on `main` pushes (#2873), so a `PAIRED_*` drift shows up as **one** red job that names the constant, instead of surfacing through 15 unrelated red jobs.

## Install

```bash
set -e
HUB_DIR="$HOME/.commhub/runtime-v144-preview144"
test ! -e "$HUB_DIR"
install -d -m 700 "$HUB_DIR"
umask 077
npm install --prefix "$HUB_DIR" --ignore-scripts --no-audit --no-fund \
  @sleep2agi/commhub-server@0.9.0-preview.144
```

Run with the same env as the previous instance (at minimum `PORT` and `COMMHUB_DB`). The database file is shared. This release adds no table.

## Upgrade / rollback

```bash
# stop the old instance, then start the new one against the SAME database
PORT=9200 COMMHUB_DB="$HOME/.commhub/commhub.db" \
  bun "$HUB_DIR/node_modules/@sleep2agi/commhub-server/bin/commhub.ts"
```

- Rollback is the previous runtime directory (`runtime-v143-preview143`). No schema change to undo.
- The client half of this fix (agent-network-app#1001) reads the flag; without it the client keeps the old inference, so the two halves can ship in either order.

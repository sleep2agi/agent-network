# CommHub Server — agent ↔ department assignment, v0.9.0-preview.140

One behaviour change: **an Agent (node) can now belong to a department explicitly**.

Before this, the only rule was derived — `GET /api/networks/:net/departments/:dept/nodes` returns
Agents **owned by people** in that department's subtree. An Agent with no owner, or whose owner is
not in the tree, could only be counted as 「未归属」. On the network admin screenshotted on 2026-10-19
that meant every department showed **0 个 Agent** and **328 个 Agent 未归属** — correct arithmetic,
useless answer.

- `nodes.department_id` (nullable, appended migration).
- `PUT /api/networks/:net/nodes/:nodeId/department` `{department_id: string | null}`
  - owner / admin, or a department leader inside their own subtree (audited `via=leader`);
  - `400 department_not_found` for an unknown department **or one from another network**;
  - `404 node_not_found` for a node outside this network;
  - `403` for a plain member;
  - `null` / `""` clears it and returns the Agent to the owner-derived rule;
  - audits `agent_department_set`.
- `GET /api/requirements/people/directory` reports an Agent's `department_id` **only when it is set**
  (the key is omitted otherwise), so the old owner-derived shape is byte-identical for older clients.

Not changed: `/departments/:dept/nodes` still answers 「whose Agents can this department use」 —
a different question from 「which department is this Agent in」.

## Install

```bash
set -e
HUB_DIR="$HOME/.commhub/runtime-140"
test ! -e "$HUB_DIR"
install -d -m 700 "$HUB_DIR"
umask 077
npm install --prefix "$HUB_DIR" --ignore-scripts --no-audit --no-fund \
  @sleep2agi/commhub-server@0.9.0-preview.140
```

Run with the same env as the previous instance (at minimum `PORT` and `COMMHUB_DB`); the database file is
shared, and the new column is added in place on first start.

## Upgrade

```bash
# stop the old instance, then start the new one against the SAME database
PORT=9200 COMMHUB_DB="$HOME/.commhub/commhub.db" \
  bun "$HUB_DIR/node_modules/@sleep2agi/commhub-server/bin/commhub.ts"
```

- The migration is `ALTER TABLE nodes ADD COLUMN department_id TEXT` inside a `try/catch` — re-running
  it is a no-op, and old rows simply have `NULL` (＝「仍按负责人的部门推断」).
- No client change is required to keep working: the directory gains an optional key, nothing is removed.
- The app-side wiring (真实调用替代演示) shipped in **client 0.2.269**; a 0.2.269 client talking to an
  older Hub gets the old 「这个接口不存在」 behaviour, so upgrade the Hub before expecting the org
  screen to save.

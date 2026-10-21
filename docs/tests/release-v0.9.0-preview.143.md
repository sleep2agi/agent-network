# CommHub Server — cross-network alias delivery, v0.9.0-preview.143

One behaviour change: **a send to an agent that lives in another of the caller's own networks now goes through** instead of answering `404 alias_not_found`.

## The incident (admin 2026-10-21)

The client shows the agent list cross-network — `GET /api/status?light=1` carries no `network_id`, so the Hub returns every network the caller belongs to. The send, however, names a single network: the one chosen at login. For a user who is *owner* of their own personal network and *admin* of the team network, both report `agent_access: 'all'`, so the pick lands on the personal network, and every message to a team-network agent is refused:

```
[15:55:54] tang → /api/task → tang02: REJECTED 404 alias_not_found (net=net_ac567b4ab74e)
[15:56:03] tang → /api/task → tang03_公司电脑_兼容旧版VSC: REJECTED 404 alias_not_found (net=net_ac567b4ab74e)
[16:12:22] tang → /api/task → tang04_课程助手: REJECTED 404 alias_not_found (net=net_ac567b4ab74e)
```

The client showed 「没有找到这个 Agent（网络可能已变更）」 and 「未送达 · 点击重试」.

## What changed

When the alias is **not** in the requested network but is in **exactly one** other network the caller belongs to — and the caller may write and message there — the send is delivered to that network. `actual_to.network_id` reports where it landed, and the task row carries that network.

Three red lines, each with a test:

- only networks the caller joined (no cross-tenant access, no alias probing);
- a name that exists in two of the caller's networks is **not** guessed — still `404 alias_not_found`;
- no write right, or no message right (a restricted member without the agent grant) — still `404` / `403`.

Everything else is unchanged: the requested network still wins whenever it has the alias, node tokens keep their own scope, and the rejection log keeps one line per refused send.

## Install

```bash
set -e
HUB_DIR="$HOME/.commhub/runtime-v143-preview143"
test ! -e "$HUB_DIR"
install -d -m 700 "$HUB_DIR"
umask 077
npm install --prefix "$HUB_DIR" --ignore-scripts --no-audit --no-fund \
  @sleep2agi/commhub-server@0.9.0-preview.143
```

Run with the same env as the previous instance (at minimum `PORT` and `COMMHUB_DB`). The database file is shared. This release adds no table.

## Upgrade

```bash
# stop the old instance, then start the new one against the SAME database
PORT=9200 COMMHUB_DB="$HOME/.commhub/commhub.db" \
  bun "$HUB_DIR/node_modules/@sleep2agi/commhub-server/bin/commhub.ts"
```

- Rollback is the previous runtime directory (`runtime-v142-preview142`). No schema change to undo.
- Clients do not need an update for this to take effect. The client-side change (send to the network the alias actually lives in) is a separate, complementary fix.

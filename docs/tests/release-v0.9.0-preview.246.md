# commhub-server 0.9.0-preview.246

Since `.245`: the **other half** of the same leak — the card payload, not just the event feed.
`.245` was published but never deployed; `.246` is the first release carrying both halves.

| Commit | PR | What |
|---|---|---|
| 85efbf50 | — | 事件列表：`assignee` 按隐藏节点别名抹除 |
| de8f111b | — | **卡片投影**同样抹除（`/api/requirements` 读面） |
| 29ee4377 | — | package-lock 版本对齐（构建一致性） |

## Security

**Who is affected.** Any network with agent-restricted members (members whose Agent visibility is
scoped) — *any* member reading task cards, not only the ones reading the event feed.

**What leaked.** `assignee` is a derived display field stored as a plain alias string. Masking
covered `owner` / `agent_owner` / `participants` (they carry `{kind, id}` refs), but not
`assignee`, so a card whose `agent_owner` was a node the member cannot see still displayed
**that node's name** in the "执行人" column. The node **id** never leaked; the **name** did.

Two read surfaces, one root cause:
- `GET /api/requirements/events` — event payloads (fixed in `.245`)
- `GET /api/requirements` — the card payload itself (fixed in `.246`, and the more commonly read one)

**Fix.** A single `hiddenNodeAliases(ctx, networkId)` (per-request cached, empty for unrestricted
callers) is now shared by both surfaces, so the next derived display field only has to be wired in
one place. Direction is deliberately conservative: on an alias/name collision we hide rather than show.

**Proof it can go red.**
- Event feed: deleting the masking turns `requirement-events-http` from `12/0` into `11/1`.
- Card payload: deleting the one line in `toPublicFor` turns the new case from pass into
  `12 pass / 1 fail` (`.not.toContain("ev-node")`).

## Behaviour

- No API shape change. `assignee` stays a string or null.
- Unrestricted members see exactly what they saw before (a test asserts admin still reads `"ev-node"`).
- Cards the member cannot see at all are unaffected (that rule is older and unchanged).

## Install

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.246
```

## Upgrade

```bash
# hub started by `anet hub start`
anet hub stop && anet hub start --server-version 0.9.0-preview.246
# hub run by pm2 (production profile)
HUB_RUNTIME_DIR=~/.commhub/runtime-0-9-0-preview-246 pm2 restart <name> --update-env
```

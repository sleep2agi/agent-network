# commhub-server 0.9.0-preview.245

Since `.244`: **one security fix** — a restricted member could read the *alias* of an Agent they
are not allowed to see, through the requirement event feed.

| Commit | PR | What |
|---|---|---|
| 85efbf50 | — | `assignee` 事件按「隐藏节点的别名集合」一并抹除 |
| 29ee4377 | — | package-lock 版本对齐（.219 → .244，构建一致性） |

## Security

**Who is affected.** Any network where an agent-restricted member (a member whose Agent visibility
is scoped) can call `GET /api/requirements/events`.

**What leaked.** `assignee` is a *derived display field* stored as a plain alias string, written
back whenever `agent_owner` is set. The event feed masked `owner` / `agent_owner` / `participants`
(because those carry `{kind, id}` refs it can match) but not `assignee`, so setting `agent_owner`
to a node the member cannot see produced:

```json
{ "field": "assignee", "old": null, "new": "<that node's alias>" }
```

The node **id** never leaked; the **name** did.

**Fix.** For restricted callers the feed now masks `assignee` using the set of hidden nodes'
aliases; an event whose masked `old` equals its masked `new` is dropped entirely (the same rule
already applied to the ref-shaped fields). The direction is deliberately conservative: when an
alias collides with a person's name we hide rather than show.

**Proof it can go red.** Deleting the fix turns `requirement-events-http` from `12 pass / 0 fail`
to `11 pass / 1 fail`, failing exactly on `.not.toContain("ev-node")`.

## Behaviour

- No API shape change. Event payloads keep the same keys.
- Members without agent restrictions see the event feed exactly as before.
- `package-lock.json` version now matches `package.json` (a `package-version-consistency` test
  caught them drifting; that test is part of the server unit suite).

## Install

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.245
```

## Upgrade

```bash
# hub started by `anet hub start`
anet hub stop && anet hub start --server-version 0.9.0-preview.245
# hub run by pm2 (production profile)
HUB_RUNTIME_DIR=~/.commhub/runtime-0-9-0-preview-245 pm2 restart <name> --update-env
```

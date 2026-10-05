# agent-network 2.3.0-preview.139

Pairing release: `PAIRED_AGENT_NETWORK_VERSION` → `2.3.0-preview.139`, `PAIRED_AGENT_NODE_VERSION` → `2.5.0-preview.106` (see [`release-v2.5.0-preview.106.md`](./release-v2.5.0-preview.106.md)).

Since `.138` (release merge `69d11be0`, #2376), `agent-network/` has one change:

| Commit | PR | What |
|---|---|---|
| 4d90d6b6 | #2377 | #533: tmux listings survive non-UTF-8 locales — CJK session names found |

## Behaviour

- Under `LANG=C` / POSIX / unset locale, tmux 3.3a replaces the tab separator **and every byte of a CJK session name** with `_`, so `anet attach 通信牛` (and the pane lookup, pane pids, codex restart session id, batch list/stop, codex menu, lifecycle facts, node-server) could not find CJK-named sessions. Every parsed tmux call now goes through `src/tmux-format.ts`: `-u` forces UTF-8 output regardless of locale (no locale install needed), plus a `|ANETSEP|` field separator and a row-arity check; legacy tab rows are still read. Names are still compared exactly in code, never with `-t =name`.

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.139 @sleep2agi/agent-node@2.5.0-preview.106
```

## Upgrade

```bash
anet upgrade --channel preview
# or explicitly:
npm i -g @sleep2agi/agent-network@2.3.0-preview.139 @sleep2agi/agent-node@2.5.0-preview.106
```

Upgrade both packages together (`agent-network@2.3.0-preview.139 ↔ agent-node@2.5.0-preview.106`).

## Evidence

- #2377: unit 42 pass (incl. a source check that fails if a parsed tmux listing bypasses the helper); new Docker suite `tests/test533-tmux-format-locale` 6/6 (private socket, `LANG=C`, CJK session, real `anet attach` in a pty) — red with `-u` removed; tsc rc=0.

## promote 时的 must_contain

`"version": "2.3.0-preview.139"`

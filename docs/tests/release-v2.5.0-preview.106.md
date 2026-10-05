# agent-node 2.5.0-preview.106

Since `.105` (release merge `69d11be0`, #2376), `agent-node/` has one change:

| Commit | PR | What |
|---|---|---|
| dd1ca676 | #2378 | #556: tmux listings survive non-UTF-8 locales — CJK co-presence sessions found |

## Behaviour

- Measured on tmux 3.3a: under `LANG=C` / POSIX / unset locale, tmux replaces the tab separator **and every byte of a CJK session name** with `_` (`$0\t通信牛` → `$0_______`). agent-node's codex health probe (`probeTmuxTui` / `parseTmuxPanes`), the app-server relaunch (`listTmuxPanes` / `tmuxSessionId`) and the opencode attach-TUI pane lookup now go through `src/tmux-format.ts`: every parsed tmux call gets `-u` (UTF-8 output regardless of locale, no locale install needed) and a `|ANETSEP|` field separator, with a row-arity check; legacy tab rows are still read.
- The helper is a byte-identical copy of anet's `src/tmux-format.ts` (#2377); a parity test keeps them identical.
- No config changes. No dependency changes.

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.106
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.139 @sleep2agi/agent-node@2.5.0-preview.106
```

Nodes must be restarted on the new build for the change to take effect.
- 🔴 **Upgrade both packages together** (`agent-network@2.3.0-preview.139 ↔ agent-node@2.5.0-preview.106`): anet validates the exact paired agent-node version for codex co-presence and `opencode-cli`.
- Publish order: agent-node `.106` first, then agent-network `.139`, both from the same merge commit.

## Evidence

- #2378: test725 (full agent-node unit, Docker) 2319 pass / 0 fail; new Docker suite `tests/test556-node-tmux-format-locale` 5/5 (real tmux 3.3a, private socket, `LANG=C`, CJK session) — red with `-u` removed; source check + parity test witnessed red; typecheck 81 = baseline.

## promote 时的 must_contain

`"version": "2.5.0-preview.106"`

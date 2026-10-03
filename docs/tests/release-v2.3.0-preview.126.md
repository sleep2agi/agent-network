# agent-network 2.3.0-preview.126

Built from main `0de11258`. `2.3.0-preview.125` (#2301) was published by CI but was not yet visible on the registry when this was cut, so `.126` also carries everything listed for `.125`.

## Behaviour

- `anet upgrade` stays on the npm channel you are already on (#510 / #2302). `latest` is itself a promoted `-preview.N` build, so the old rule "a prerelease means preview" moved every latest user onto preview. The channel is now decided by comparing the installed version with the live `latest` / `preview` dist-tags; `--channel latest|preview` switches explicitly; if the channel can't be determined it refuses instead of guessing. Before installing it prints the current version, the channel with the reason, and the exact version of each package, then installs exactly those versions.
- `anet hub start` launches the channel's current `@sleep2agi/commhub-server` (#511 / #2305) instead of the hand-maintained `PINNED_SERVER_VERSION` (stuck at `0.9.0-preview.47`). `--version <exact|latest|preview>` and `--channel latest|preview` override; the pin stays as a floor. If the registry is down it uses the newest cached version at or above the floor (warned); a cache holding only older versions is never launched silently. On start it prints `Hub version: …@<v> [source: registry|cache|explicit|pinned minimum]`.
- Carried from `.125`: every tmux call goes through one helper that passes an explicit `-S <socket>` and drops an inherited `TMUX`/`TMUX_PANE` when `ANET_TMUX_SOCKET` or `TMUX_TMPDIR` is set, and refuses `kill-server` (#505 / #2297); the codex co-presence TUI no longer passes the permission override on `codex resume --remote` (codex 0.155.1 rejects it) (#505 / #2298).
- Pairing pins: `PAIRED_AGENT_NETWORK_VERSION` → `2.3.0-preview.126`, `PAIRED_AGENT_NODE_VERSION` → `2.5.0-preview.97` (see `release-v2.5.0-preview.97.md`).

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.126 @sleep2agi/agent-node@2.5.0-preview.97
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.126 @sleep2agi/agent-node@2.5.0-preview.97
```

Upgrade both packages together: anet validates the exact paired agent-node version for codex co-presence and `opencode-cli`.

## Evidence

- #2302: 11 unit tests (`upgrade-channel.test.ts`); restoring the old rule turns 4 red. test745 agent-network unit 1426/0; `tsc --noEmit` rc=0.
- #2305: unit tests for registry / stale cache / explicit version / registry down, see the PR.
- #2297 / #2298: see `release-v2.3.0-preview.125.md`.

## promote 时的 must_contain

`"version": "2.3.0-preview.126"`

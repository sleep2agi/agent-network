# agent-network 2.3.0-preview.136

Pairing release: `PAIRED_AGENT_NETWORK_VERSION` → `2.3.0-preview.136`, `PAIRED_AGENT_NODE_VERSION` → `2.5.0-preview.103` (see [`release-v2.5.0-preview.103.md`](./release-v2.5.0-preview.103.md)), so codex co-presence and `opencode-cli` resolve agent-node `.103`, which fails opencode tasks on provider errors (#2356).

Since `.135` (release merge `b9dbd483`, #2355), `agent-network/` has four changes:

| Commit | PR | What |
|---|---|---|
| 838dc115 | #2354 | #535: codex co-presence reliable first start, readable bridge failures, `needs-login` state |
| 127cc992 | #2356 | #540: clear free-tier vs safe-preset warning at `anet node create` |
| 6a169402 | #2352 | #528: `anet node codex adopt` turns an existing codex conversation into a node |
| b8fb39c1 | #2358 | #549: never downgrade an existing newer `.anet/node-server.js` on start |

## Behaviour

- **Codex co-presence first start** (#535 / #2354):
  - The paired agent-node is resolved (and on a fresh machine downloaded) **before** any tmux session, with its own `⓪ agent-node` progress line. The bridge reuses that validated entrypoint instead of a second npx, so a slow first fetch no longer exceeds the 25 s bridge wait.
  - The bridge's output is also kept in `<node dir>/codex-bridge.log` (0600, truncated per start, ~2 MB cap). A failed start prints its last 20 lines and the path, and no `tmux attach` to a session that is gone. The "unsafe ownership or mode" message names the directory, the reason and the fix.
  - A node whose CODEX_HOME has no usable login gets `needs-login` with the exact `CODEX_HOME=… codex login --device-auth`, exit 3, and nothing is started. Keyring credential stores and an env API key are "unknown" and do not block.
  - `verify` / `canary` / `restart` / `resume` on a single node with no `--probe-from` peer: `identity_attested` is `n/a` (not FAIL). The FAIL `blocking:` list names only checks that actually failed.
- **opencode free tier** (#540 / #2356): `anet node create` no longer says keyless/free models start without a credential. When an `opencode/*-free` model meets the default safe preset, it warns and prints the exact commands for `flags.opencodeUnsafeTools=true` or a keyed provider. The default preset is unchanged.
- **New `anet node codex adopt <new-name> --thread <id|unique prefix>`** (#528 / #2352): makes a node from a conversation in a raw CODEX_HOME (default `~/.codex`). Exactly that one rollout is copied into the new node's own CODEX_HOME with a new thread id and the recorded cwd rewritten; new node_id, Hub registration, port and tmux names; receipt verb `adopt`.
  - Without `--thread`, a TTY lists the conversations to pick from; a non-TTY prints the list and exits 2. Zero matches, an ambiguous prefix or one id in several rollout files are refused.
  - The source home is read-only. `auth.json` is not copied unless `--allow-shared-codex-login` (behind the #514 gate); adopt prints the node's own login command. Also reachable as `a` in the `anet node codex` menu.
- **`.anet/node-server.js` is no longer downgraded** (#549 / #2358): the bundle's first line carries `// anet-node-server-version: <semver>`. When the existing file is strictly newer, `anet node start` / `anet resume` keep it and print one warning naming the newer version and the upgrade command. Equal, older or unmarked files are overwritten as before. This only protects nodes started by `.136` or later.

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.136 @sleep2agi/agent-node@2.5.0-preview.103
```

## Upgrade

```bash
anet upgrade --channel preview
# or explicitly:
npm i -g @sleep2agi/agent-network@2.3.0-preview.136 @sleep2agi/agent-node@2.5.0-preview.103
```

Upgrade both packages together (`agent-network@2.3.0-preview.136 ↔ agent-node@2.5.0-preview.103`): anet validates the exact paired agent-node version for codex co-presence and `opencode-cli`.

## Evidence

- #2354: new Docker suite `tests/test-codex-copresence-first-start` (real throwaway Hub, private tmux socket, fake 30 s npx, fake codex), four witnessed reds; unit tests for the login gate, bridge log, unsafe-directory messages and receipt/restart verdicts.
- #2356: `src/opencode-free-tier.test.ts` runs the printed `node -e` command against a temp config; witnessed red against the old `cli.ts`. test745 1698 pass / 0 fail.
- #2352: new Docker suite `tests/test528-codex-adopt` (5/5 witnessed reds), `src/codex-adopt.test.ts`; test745 1676 pass / 0 fail, 169/169 files.
- #2358: `src/node-server-version.test.ts` 15 tests; witnessed reds (decision forced to always write: 2 fail; pre-fix `bin/cli.ts`: 2 fail). test745 and qa-claude-code-node-id pass.

## promote 时的 must_contain

`"version": "2.3.0-preview.136"`

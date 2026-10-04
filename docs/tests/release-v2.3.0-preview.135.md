# agent-network 2.3.0-preview.135

Pairing release: `PAIRED_AGENT_NETWORK_VERSION` → `2.3.0-preview.135`, `PAIRED_AGENT_NODE_VERSION` → `2.5.0-preview.102` (see [`release-v2.5.0-preview.102.md`](./release-v2.5.0-preview.102.md)), so codex co-presence and `opencode-cli` resolve agent-node `.102`, which carries the codex-sdk sandbox/approval security fix (#2351).

Since `.134` (release merge `a79393ba`, #2347), `agent-network/` has one change:

| Commit | PR | What |
|---|---|---|
| 2d16aee9 | #2349 | #529: codex login next step at create/clone and `anet node codex login-status` |

## Behaviour

- **`anet node create` / `anet node clone` print the codex login next step** (#529 / #2349). For a codex node (`codex-sdk`, `codex-app-server` or `codexCopresence`) that will have no usable login, the command ends with the exact `CODEX_HOME=<dir> codex login` for this node's CODEX_HOME (prefixed by `mkdir -p -m 700 <dir>` when the directory does not exist yet), the `--device-auth` variant for headless/SSH machines, and `anet node start <alias>`.
  - The command is printed only. Nothing runs and no `auth.json` is copied; the #514 rules are unchanged.
  - Nothing is printed when the node's CODEX_HOME already holds a login, or for a co-presence node whose first start may borrow the host `~/.codex` login under the #514 gate.
- **New `anet node codex login-status [--json]`**: one row per codex node in `./.anet/nodes` with alias, runtime, CODEX_HOME, logged in, account and shared-with.
  - Account is the `id_token` e-mail decoded locally (no network), else `acct:<fingerprint>`.
  - "Shared with" means the same refresh-token chain (the case that logs nodes out), not merely the same account; same-account nodes with their own logins are listed under `same_account_as` in `--json`.
  - No token value is ever printed.
- Docs (zh + en): `guide/codex-copresence.md` explains why every codex node has its own CODEX_HOME; `guide/copy-node.md` gains "each codex node logs in on its own".

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.135 @sleep2agi/agent-node@2.5.0-preview.102
```

## Upgrade

```bash
anet upgrade --channel preview
# or explicitly:
npm i -g @sleep2agi/agent-network@2.3.0-preview.135 @sleep2agi/agent-node@2.5.0-preview.102
```

Upgrade both packages together (`agent-network@2.3.0-preview.135 ↔ agent-node@2.5.0-preview.102`): anet validates the exact paired agent-node version for codex co-presence and `opencode-cli`.

## Evidence

- #2349: `src/codex-node-login.test.ts` 11 pass, with witnessed reds M1 (token leak into the e-mail field) 3 fail, M2 (shared-chain match disabled) 3 fail, M3 (next step never printed) 3 fail. test745 (Docker) 1675 pass / 0 fail, executed_files=169 = discovered_files=169. test509-node-clone PASS, test522-node-delete-locate-stop PASS.

## promote 时的 must_contain

`"version": "2.3.0-preview.135"`

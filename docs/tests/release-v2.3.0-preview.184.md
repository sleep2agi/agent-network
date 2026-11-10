# agent-network 2.3.0-preview.184

Since `.183`, `agent-network/` has one change:

| Commit | PR | What |
|---|---|---|
| 8e1e7ca0 | #2831 | #1509: `anet daemon secret list/set/unset` over the existing scoped lane |

## Behaviour

- **Daemon-scoped env secrets get a CLI.** The scoped lane (`scoped-secrets.json`, 0600, revision CAS, per-node binding) already existed and was only reachable as private JSON on stdin. It now has the same shape as `anet node secret`:

  ```bash
  anet daemon secret list  <daemon> [--node <alias>] [--json]
  anet daemon secret set   <daemon> <KEY> --from-env <VAR> (--node <alias> | --all)
  anet daemon secret unset <daemon> <KEY> (--node <alias> | --all)
  ```

- **Values never reach argv.** They come from `--from-env` or stdin; passing a value as a positional is a usage error. Receipts and `list` show key names and their source (`daemon` / `node`) only.
- **An unbounded write is refused.** `set`/`unset` without `--node` or `--all` exits 2 — a default reaches every child, so it has to be said out loud. `--all` together with `--node` is refused too.
- The existing JSON-stdin entry point is unchanged (the Hub still uses it); `anet daemon --help` now lists `secret`.
- No config changes. No dependency changes.

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.184
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.184 @sleep2agi/agent-node@2.5.0-preview.148
```

Nodes and daemons must be restarted on the new build for the change to take effect.
- 🔴 **Upgrade both packages together** (`agent-network@2.3.0-preview.184 ↔ agent-node@2.5.0-preview.148`): anet validates the exact paired agent-node version for codex co-presence and `opencode-cli`.

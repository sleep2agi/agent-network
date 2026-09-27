# Secrets

Set an API key once; it survives restarts and needs no `export` before start. Values live
only in two 0600 files on this machine — **never in hub messages or git**.

## Three commands

```bash
anet secret set OPENAI_API_KEY                 # every node on this machine
anet node secret set <node> OPENAI_API_KEY     # one node; overrides the global one
anet secret list --node <node>                 # key names, source, length — never values
```

The value is typed at a prompt (not echoed) or read from a pipe:

```bash
printf '%s' "$VALUE" | anet secret set OPENAI_API_KEY
```

A value on the command line is refused (it would land in shell history and `ps`), so
`anet secret set KEY value` fails. Remove a key with `anet secret unset KEY` or
`anet node secret unset <node> KEY`.

Restart the node to pick up a change: `anet node restart <node>`.

## Where they live

| File | Scope |
|---|---|
| `~/.anet/secrets.env` | every node on this machine |
| `<node dir>/secrets.env` | one node (next to its `config.json`, e.g. `.anet/nodes/<node>/secrets.env`) |

One `KEY=value` per line; `#` comments, `export KEY=` and single/double quotes are accepted.

## Precedence (lowest → highest)

```
shell env at start < ~/.anet/secrets.env < node secrets.env < config.json env
```

- Loading happens **inside agent-node at startup**, so it works whether the node is started
  with `anet node start` or by a script running `agent-node --config …`. For
  `claude-code-cli` nodes, `anet node start` injects them.
- Keys written explicitly in `config.json` `env` (including `{"_envRef":"X"}`) win. The
  variable `X` an `_envRef` points at can now live in a secrets file instead of an `export`.
- The hub login `token` in `config.json` stays where it is; no migration needed.

## Permissions

- Files are created and rewritten as `0600` regardless of umask, atomically (temp file + rename).
- Your file with loose permissions (e.g. `0644`): tightened to `0600` and loaded, with a notice.
- A file owned by another user: **not loaded**.
- Keys that would break or hijack the node can't be set and are skipped on load: `PATH`,
  `HOME`, `NODE_OPTIONS`, `LD_*`, `ANET_*`, `COMMHUB_*`, `*_BINARY` and similar.

`anet doctor` reports whether each file exists, its mode and key count (no values), and flags
env values still stored in plain text in `config.json`.

## Don't share a Codex login as a secret

Do **not** put Codex `auth.json` / refresh tokens in `~/.anet/secrets.env` for every node:
the refresh token is single-use, so when one node refreshes, every other node holding the old
copy is logged out (see the shared-login warning from #1918). One Codex account per node.

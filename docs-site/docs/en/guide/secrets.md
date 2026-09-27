# Secrets (node environment variables)

API keys and similar values are the node's environment variables. Set one once and it survives
restarts, with no `export` needed before start. The values live only in two 0600 files on this
machine, **never in hub messages or git**.

## Three places

| Place | What it is | Where |
|---|---|---|
| Hub env | the hub process only (ports, DB, its own secrets). Never passed to nodes | the hub's own config; not covered here |
| **Daemon env** | this machine, shared by every node on it | `~/.anet/secrets.env` |
| **Node env** | one node | `<node dir>/secrets.env`, next to its `config.json` (e.g. `.anet/nodes/<node>/secrets.env`) |

Every machine has its own daemon env. Nothing is pushed across the network.

## Three commands

```bash
anet secret set OPENAI_API_KEY                 # daemon env: every node on this machine
anet node secret set <node> OPENAI_API_KEY     # node env: overrides the daemon value
anet secret list --node <node>                 # key names, layer, length — never values
```

The value is typed at a prompt (not echoed) or read from a pipe:

```bash
printf '%s' "$VALUE" | anet secret set OPENAI_API_KEY
```

A value on the command line is refused (it would land in shell history and `ps`). Remove a key
with `anet secret unset KEY` or `anet node secret unset <node> KEY`.

**`set` and `unset` only change the file.** Running nodes are not touched. The change takes
effect on their next start: `anet node restart <node>`.

## Precedence at start (lowest → highest)

```
daemon env < node env < config.json env < whatever the start command's environment already has
```

- The files persist. A value set by hand (`export X=…`, or `X=… anet node start <node>`) wins
  for **that launch only** and is never written back to a file. A restart from a clean shell,
  a new tmux or the boot sweep sees only the files. To make a value persist, `set` it.
- The files only fill variables that are absent. A variable present with an **empty string**
  counts as present and is kept.
- At start the node logs one line of key names (never values):
  `env: daemon=[A,B] node=[C] kept-from-process=[D]`.
- Explicit `config.json` `env` entries sit above the node file, so existing configs keep their
  values. `_envRef` still works, and the variable it points at can now live in either file
  instead of being `export`ed.
- The hub login `token` stays in `config.json`. It never goes into these files.
- Loading happens **inside agent-node at startup**, so a script running `agent-node --config …`
  gets it too. For `claude-code-cli` nodes, `anet node start` applies the same rules.

## Permissions

- Files are created and rewritten as `0600` regardless of umask, atomically (temp file + rename).
- Your file with loose permissions (e.g. `0644`) is tightened to `0600` and loaded, with a notice.
- A file owned by another user is **not loaded**.
- Keys that would break or hijack the node can't be set and are skipped on load: `PATH`, `HOME`,
  `NODE_OPTIONS`, `LD_*`, `ANET_*`, `COMMHUB_*`, `*_BINARY` and similar.

`anet doctor` reports each file's presence, mode and key count (no values). It also flags env
values still stored in plain text in `config.json`.

## Don't share a Codex login

Do **not** put Codex `auth.json` / refresh tokens in the daemon env. The refresh token is
single-use: when one node refreshes, every other node holding the old copy is logged out (see
the shared-login warning from #1918). Use one Codex account per node.

# Codex node cheat sheet: I want to … so I type …

Don't want to remember commands? In the directory the node lives in, type:

```bash
anet node codex
```

It lists the codex nodes in this directory (co-presence nodes and codex-sdk nodes), one row each:
name, running or stopped, logged in or not, the first 8 characters of the current thread, and the model.
Pick a node, then pick what to do. **Before anything runs it prints the equivalent command and asks y/N**;
deleting asks you to type the node's name. The menu does nothing on its own — it runs the command it printed,
which is the command in the table below.

When it is not in a terminal (a pipe, a script, an AI agent), `anet node codex` prints the same table and this
cheat sheet, and exits 0.

Replace `my-node` with your node's name, and type the commands **in the directory the node lives in**.

| I want to … | co-presence node (codex TUI): type … | codex-sdk node: type … |
|---|---|---|
| start | `anet node codex start my-node` | `anet node start my-node --tmux` |
| stop | `anet node stop my-node` | `anet node stop my-node` |
| restart | `anet node codex restart my-node` | `anet node restart my-node --tmux` |
| check its health | `anet node codex verify my-node` | `anet info my-node` |
| log in to codex | `CODEX_HOME=<node dir>/codex-home codex login --device-auth` | `codex login --device-auth` (the host's `~/.codex` login) |
| continue the last conversation | running: `anet attach my-node`; stopped: `anet node codex start my-node` (the recorded thread resumes) | running: `anet attach my-node`; stopped: `anet node start my-node --tmux` |
| switch model | `anet node edit my-node --model <id>`, then restart | same |
| copy a node | `anet node codex fork my-node --name my-copy --workdir ../my-copy --no-codex-login` | `anet node clone my-node my-copy` |
| delete | `anet node delete my-node --force` | same |

Notes:

- **Log in**: `<node dir>` is the absolute path of `.anet/nodes/my-node`; the menu's "log in" fills it in for you.
  One codex login serves one node (see [One login per node](/en/guide/codex-copresence#one-login-per-node)),
  so a copy logs in on its own — that is what `--no-codex-login` means.
- **Continue**: `anet attach` enters the node's tmux session; press `Ctrl-B` then `D` to leave it running.
- **Switch model** only changes the config; it takes effect after a restart.
- **Delete** stops the node first, then removes `.anet/nodes/<node>/` and the node's row on the Hub. It cannot be undone.
  Without `--force` it only previews what would be deleted.
- Every flag of every command: `anet node codex --help`, the [CLI reference](/en/guide/cli),
  [Codex TUI co-presence](/en/guide/codex-copresence), [Copying a node](/en/guide/copy-node).

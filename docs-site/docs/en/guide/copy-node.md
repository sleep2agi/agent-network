# Copying a node (clone / fork) and cleaning up

When you want "another node just like this one", there are two commands. Both give the new node a
**new Hub identity**; they differ in whether the conversation history comes along.

| You want | Use | Runtimes |
|---|---|---|
| The same settings, starting from an empty conversation | `anet node clone <source> <new-name>` | Every runtime except opencode-cli |
| The same settings **plus the codex conversation history** | `anet node codex fork <source> --name <new-name> --workdir <dir>` | Codex co-presence nodes only (`codex-app-server`) |
| The node on another machine | `anet login` there, then a fresh `anet node create` | Any |

::: tip Does your anet have these commands?
If `anet node clone --help` prints a usage, your anet has clone.
If `anet node delete --help` lists `--hub-only`, `node delete` also removes the node's row on the Hub.
If not, upgrade first: `anet upgrade --channel preview`.
:::

::: danger Never `cp -r` a node directory
`.anet/nodes/<name>/config.json` holds the node's `node_id` and `ntok_`. A copied directory is the
**same Hub identity** as the source: both processes subscribe to one inbox, so every task runs twice
and gets two replies.
:::

## clone: same settings, new identity

Run it **in the source node's project directory** (anet only looks for nodes in `.anet/nodes/` under the current directory):

```bash
anet node clone my-node my-node-copy
# same thing
anet node create my-node-copy --from my-node
```

| Option | Meaning |
|---|---|
| `--workdir <dir>` | Put the clone in another project directory (created if missing; the path must be ASCII — the node name may be Chinese, the directory may not). Without it the clone shares the source's directory, rules file and skills |
| `--model <id>` | Use a different model; otherwise the source's model is kept |
| `--start` | Start the clone right away; if secret env values still have to be filled in, it does not start and tells you which |

clone registers the new node with the Hub first (the same endpoint `anet node create` uses) and only then writes to disk,
so you must be logged in (`anet login`). It prints a ledger of what was `copied` / `regenerated` / `skipped`, for example:

```text
[anet] Cloned "my-node" → "my-node-copy"
[anet]   node_id: n_xxxxxxxx → n_yyyyyyyy   (distinct Hub identity)
...
Start: anet node start 'my-node-copy'
```

The `anet node create` options `--runtime`, `--tools`, `--env`, `--channel`, `--copresence`, `--resume`, `--session` and `--batch`
cannot be used with clone (exit code 2): those come from the source.

Refused (exit code 1): the new name already exists or equals the source's name, the target lies inside the source node's own
directory, `--workdir` contains non-ASCII characters, the source is an opencode-cli node (create one instead with
`anet node create <new-name> --runtime opencode-cli`), or the source is a host daemon (`role=host_supervisor`).

## fork: a codex node, history included

```bash
anet node codex fork my-node --name my-node-copy --workdir ~/my-node-copy --no-codex-login
CODEX_HOME=~/my-node-copy/.anet/nodes/my-node-copy/codex-home codex login --device-auth
cd ~/my-node-copy && anet node codex start my-node-copy --probe-from my-node
```

- `--name` and `--workdir` are required; a missing `--workdir` is created.
- The source must be `codex-app-server` and pass four preflight checks (identity, `CODEX_HOME`, thread, rollout), otherwise the fork is refused (exit code 2). The source is only read, never changed.
- The source rollout is copied and rewritten to a new thread id; the `[projects."<source workspace>"]` table in the copied `config.toml` is rewritten to the new directory.
- `--model <id>` overrides the model; `--inherit-full-access` keeps full access only if the source already had it.
- Run later `anet node codex start/restart` commands from the `--workdir` directory.

Details (every check in the receipt) are in the "fork" section of [Codex TUI Co-presence](/en/guide/codex-copresence).

## What is copied, what is new

| Item | `clone` | `codex fork` |
|---|---|---|
| `node_id` | new | new |
| Node token (`ntok_`) | new, issued by the Hub | new, issued by the Hub |
| Alias | the new name you give | `--name` |
| Model | copied; `--model` overrides | copied; `--model` overrides |
| Runtime, tools, permission flags, system prompt, non-secret env | copied | not copied: the new node is created with codex co-presence defaults |
| Secret env values | **not copied**: key names are kept as an envRef named for the new node; set the value before starting | not copied |
| `CODEX_HOME` | new directory `<node dir>/codex-home`; only `config.toml`, `AGENTS.md`, `version.json`, `skills/` are copied | new directory; `config.toml`, `version.json`, `AGENTS.md` are copied |
| Codex login (`auth.json`) | **not copied** | **refused** by default (next section) |
| Conversation thread / history | not copied — starts empty | **copied**, under a new thread id |
| App-server port | assigned at first start | a free port is picked at fork time and written to the config; first start prefers it |
| tmux session names | derived from the new name (codex co-presence: `<name>`, `<name>-appsrv`, `<name>-桥`) | same |
| Logs, pid, inbox, goals, channel bot credentials | not copied | not copied |

## Why one codex login cannot be shared by two nodes

A ChatGPT login's refresh token is **single-use**: every refresh issues a new one and voids the old one.
Put the same `auth.json` into two nodes' `CODEX_HOME` and whichever refreshes first wins; the other later fails with
`401 token_revoked` (`Your access token could not be refreshed …`). So anet stops it before the copy:

- **clone** never copies `auth.json`. On the clone's first `anet node start`, if its `codex-home` has no login yet, anet stages
  this host's `~/.codex` login — but **refuses to start** (exit code 1) when another node on this host already uses that login.
- **fork** refuses by default to copy the source's ChatGPT login (the source is using it): exit code 1, before anything is
  registered with the Hub, so nothing is left behind. `--no-codex-login` copies no login; log in before the first start.
- The fix: log each node in on its own (device auth works over SSH):

  ```bash
  CODEX_HOME=<new node dir>/codex-home codex login --device-auth
  ```

  or install a registered account: `anet node codex account install <new-name> --source codex-login:<profile-id>`.
- `--allow-shared-codex-login` (accepted by `node start` and `codex fork`) forces the share. It is **unsafe**: the nodes will log each other out.

"Same login" is decided by a short fingerprint of the refresh token; anet never reads another node's `auth.json`.
See [one login per node](/en/guide/codex-copresence#one-login-per-node).

## Each codex node logs in on its own

Every codex node has its own `CODEX_HOME`: refresh tokens are single-use (a shared login logs the other node out), sessions are stored per home, and stop/delete find processes by `CODEX_HOME`. So a copied codex node logs in once on its own:

- When `anet node clone` makes a codex node whose first start will not have a usable login, the command ends with the exact command that logs it in (`CODEX_HOME=<new node dir>/codex-home codex login`, or `--device-auth` without a browser), followed by `anet node start`. Printed only, never run; no `auth.json` is copied.
- `anet node codex fork --no-codex-login` prints the same command in its result.
- `anet node codex login-status [--json]` lists every codex node in this directory: `CODEX_HOME`, logged in or not, account (e-mail or fingerprint), and which other nodes share the same login. No token is printed.

See [why every codex node has its own CODEX_HOME](/en/guide/codex-copresence#why-own-codex-home).

## Deleting the copy

```bash
anet node delete my-node-copy            # preview only: lists the directory and node_id, changes nothing
anet node delete my-node-copy --force    # actually delete
```

- **No need to stop it first**: `--force` first runs exactly the stop `anet node stop` does, co-presence (codex / grok / opencode)
  tmux sessions included. A codex co-presence node is identified by its own identity (co-presence marker + `CODEX_HOME`); a node
  without a marker only by the **exact** session names `<name>`, `<name>-appsrv` and `<name>-桥`, never a prefix, so a different
  session with a similar name is left alone. If the stop cannot be proven (say a process refuses to exit),
  delete exits with an error and **deletes nothing**.
- **No need to remember where a `--workdir` copy went**: clone and codex fork note where the copy went in the source directory's
  `.anet/child-workdirs.json`. Run from the source directory, anet finds it but **does not delete it for you**; it prints the exact
  command to run and exits `1`:

  ```text
  [anet] "my-node-copy" is not in this directory; it lives in /home/me/my-node-copy/.anet/nodes/my-node-copy (node_id n_yyyyyyyy).
  [anet] Nothing was stopped or deleted. Run it from there:
    cd '/home/me/my-node-copy' && anet node delete 'my-node-copy' --force
  ```

- If several nodes match the name (say `my-node-copy` exists in two directories), anet **refuses**, and lists a
  `cd … && anet node delete <node_id>` for each one so you pick by node_id.

`--force` removes the local `.anet/nodes/my-node-copy/` (including its `codex-home`), then removes the node's row on the Hub,
matched by the `node_id` in the local config, so it does not keep showing as "offline" in the app / dashboard:

```text
[anet] Deleted "my-node-copy"
[anet] Removed "my-node-copy" (node_id n_yyyyyyyy) from the Hub
```

- The Hub row is matched **by `node_id` only**, never by name: a node elsewhere with the same name is left alone and anet prints `Left untouched: …`.
- If the Hub is unreachable or refuses, the local files are still deleted, anet prints a warning with a ready-to-run retry command, and the exit code is 1:

  ```bash
  anet node delete <node_id> --hub-only
  anet node delete <node_id> --hub-only --hub <url>   # when the node used a Hub other than your current login's
  ```

- Once the node directory is gone, the codex login it used no longer counts as "in use" and can be given to another node.
- `node delete` does not revoke the issued `ntok_`; if you need that, run `anet token revoke <token-id>`.

## See also

- [CLI reference](/en/guide/cli)
- [Agent Node](/en/guide/agent-node)
- [Codex TUI Co-presence](/en/guide/codex-copresence)

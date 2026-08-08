# `agent-network/scripts/` — opencode node pm2 recipe (#521 + #523)

The startup recipe for an opencode agent-node under pm2 supervision. Source of truth for what runs; the actual runtime copy lives elsewhere (see §Install).

## Files

- **`opencode-node-start.sh`** — the launch recipe. Runs preflight checks then `exec`s into agent-node in the foreground so pm2 tracks it.
- **`pm2-opencode.config.cjs`** — the pm2 ecosystem config. Points at the installed copy of the script, not this repo.
- **`normalize-codex-copresence-node.sh`** — single-node, fail-closed fleet normalizer. It is plan-only by default and requires exact PID birth times plus exact tmux sessions for apply.
- **`codex-copresence-fleet-config.mjs`** — validates and atomically pins a per-node `goalsPath`; it never migrates a missing legacy shared store.

## Codex co-presence fleet normalization

Never batch this operation. First run `--mode plan`, record every matching
process as `PID:STARTTIME` (field 22 in `/proc/PID/stat`), and name every exact
tmux session that apply may stop. Apply refuses process drift, unaccounted
alias/app-server processes, duplicate node IDs or goal stores, non-private
config modes, symlinks, implicit models, and paths outside the selected root.

The normalizer deliberately does not run production slash UAT itself. After a
successful apply, an authenticated external harness must prove socket
single-owner plus `/goal`, `/loop` notice, and `/aloop` create/cancel. A failed
apply restores the config but leaves the runtime stopped: automatic
resurrection could recreate the dual-owner condition this tool removes.

## Why two files (and two locations)

`opencode-node-start.sh` here is **the source of truth**. Reviews land against this copy. But **pm2 references** `/home/vansin/.local/bin/opencode-node-start.sh`, **not this file**.

The reason ([issue #526 same class](../../docs/tests/p-526-rename-ghost-harness/README.md), same lesson): any pm2/systemd/cron path that points inside a git worktree becomes a booby trap. When the branch merges, the worktree is cleaned; the reference goes dead; the daemon fails silently on next restart (`pm2 list` still shows the app). We put the *runtime* copy at `~/.local/bin/` alongside the other host daemons (`dash-start.sh`, `hub-daemon.sh`, `pm2-fleet-boot.sh`) so this class of failure is out of scope.

## Install / upgrade

```bash
# From this directory (or the repo root — path is absolute below)
cp -v agent-network/scripts/opencode-node-start.sh /home/vansin/.local/bin/opencode-node-start.sh
chmod +x /home/vansin/.local/bin/opencode-node-start.sh
```

🔴 **`cp`, not `ln`.** A symlink target that disappears is even less visible than an absolute path pointing at nothing.

**When you edit the source of truth in this directory, you must `cp` it again.** The pm2 config file `pm2-opencode.config.cjs` does not need to change on script upgrades — its `script:` field is a stable absolute path.

## Start / stop

Both invocations from anywhere on the host:

```bash
# Start (or resurrect after crash)
pm2 start /path/to/agent-network/scripts/pm2-opencode.config.cjs

# Or reference by name after it's known
pm2 restart opencode-node-测试1号
pm2 stop opencode-node-测试1号
pm2 delete opencode-node-测试1号
```

After a first-time start, run `pm2 save` **only after** a PONG confirms the node actually receives tasks (not just "process is up"). See §Test flow.

## Test flow (adapted from #526)

1. **Config parse** (zero side-effect): `node -e "console.log(JSON.stringify(require('./agent-network/scripts/pm2-opencode.config.cjs'), null, 2))"`
2. **Preflight only** (zero side-effect, per §preflight): `bash agent-network/scripts/opencode-node-start.sh --alias opencode测试1号 --preflight-only`
3. **Cold start**: `pm2 start …/pm2-opencode.config.cjs`
4. **Route check**: from another session, send `PONG` via commhub → node replies within ~10s
5. **Auto-restart check**: `kill -9 <pid>` → pm2 restarts within `restart_delay` (5s) → new pid, `restart_time` incremented, `status=online`
6. **Env-defense check** (this recipe's key invariant): `tr '\0' '\n' </proc/<new-pid>/environ | grep -c '^COMMHUB_'` → **must be 0**
7. **PONG again** to prove the restarted process routes correctly
8. **Only after everything above green**: `pm2 save`

## Preflight — what the script asserts

Each item fails-closed with its own ✗ line so a red preflight names the exact prerequisite. Discovered empirically 2026-07-30:

| # | Assertion | Why |
|---|---|---|
| 1 | `NODE_HOME` exists + has `node_modules` | Base install layout |
| 2 | opencode binary in `$SUPPORT_MODULES` | Runtime dependency |
| 2b | 🔴 `opencode-ai` **not** in `$NODE_HOME/node_modules` | agent-node supply-chain guard refuses "overlaps forbidden root" |
| 3 | Node config JSON exists + alias matches | Sanity |
| 3b | 🔴 Node workDir `owner=uid, mode=0700` | OpenCode state module supply-chain guard |
| 3c | 🔴 `config.json` `owner=uid, mode=0600` | Paired guard |
| 4 | `agent-node` binary executable | Sanity |
| 5 | `node` on PATH | Sanity |
| 6 | Env pollution report (`COMMHUB_ALIAS` / `COMMHUB_TOKEN`) | Informational — unset happens below anyway |

`mkdir -p` and `cat >file` use default umask (usually 755/644) and both fail 3b + 3c. `anet node create` gets this right; hand-creating a node misses. Only path to catch this before spawn is preflight.

## Env defense — two layers

agent-node reads `COMMHUB_NODE_ID` / `COMMHUB_ALIAS` / etc. from the environment **before** it reads its own `config.json` (see `agent-network/bin/cli.ts:600`). A polluted shell can override a node's identity that way — [issue #532](https://github.com/sleep2agi/agent-network/issues/532) captures the underlying agent-node bug (canonical-alias reverse lookup by node_id doesn't filter offline sessions).

This recipe defends at two layers:

1. **Ecosystem `env: { COMMHUB_*: '' }`** — explicit override of anything pm2's daemon inherited from its own bootstrap shell. `env: {}` is *not* enough — that means "no override", not "clear". pm2 daemon's env transparently reaches every managed app when the ecosystem is empty.
2. **Script `for/unset $(env | grep ^COMMHUB_)`** — pattern-clears every `COMMHUB_*` inside the script, catching any variable the ecosystem override didn't name.

**Both layers required.** Enumeration always misses something eventually; only clearing by pattern covers future additions.

## Related

- [#521](https://github.com/sleep2agi/agent-network/issues/521) — startup recipe scripted (this PR)
- [#523](https://github.com/sleep2agi/agent-network/issues/523) — pm2 supervision + auto-restart (this PR)
- [#532](https://github.com/sleep2agi/agent-network/issues/532) — agent-node canonical-alias bug found while doing this (通信龙 立项)
- [#526](https://github.com/sleep2agi/agent-network/issues/526) — same "daemon paths in worktrees" lesson from the rename-ghost gate

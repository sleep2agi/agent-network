# Selected task-activity CLI/runtime pair

This is an inactive, private software installation for CLI 173 and Node 139.
The activity-lease implementation is already on main at
`47816a61095f196cf726f194f482739bc09f6a82`; CLI 173's formal source is
`064ed34c9eba20f852a32dbe42b98389c3c2ce63` (documentation correction, same
runtime pair). Hub 135 or later is required; the selected Hub now runs 136.
Package integrity is pinned in `package-lock.json` and checked by `verify.mjs`.
This retained 173/139 profile is separate from the V1 login-persistence
[174/140 public pair](../../../docs/tests/release-v2.3.0-preview.174.md).
Do not substitute runtime140 into this profile or interpret its installation
probe as verification of OpenCode login persistence.
Both official npm tarballs are available. The CLI's earlier formal job timed
out waiting for npm visibility; later byte verification does not rewrite that
job's failure. See [publication facts](../../../docs/tests/report-test717-hub136-publication.txt).

## Prepare software without activating a node

Use Node >=22.13 and the same OS user as the selected node. From a clean Git
checkout, fetch main and verify the profile commit and both package source
commits are still ancestors of main before copying these inputs. No global npm
installation or mutable `@preview` selection is involved.

```bash
set -e
git fetch origin main
git merge-base --is-ancestor HEAD origin/main
git merge-base --is-ancestor 47816a61095f196cf726f194f482739bc09f6a82 origin/main
git merge-base --is-ancestor 064ed34c9eba20f852a32dbe42b98389c3c2ce63 origin/main
PAIR_DIR="$HOME/.anet-bin/task-activity173-139"
test ! -e "$PAIR_DIR"  # choose a new directory; preserve existing installations
install -d -m 700 "$PAIR_DIR"
cp deploy/node/task-activity173-139/{package.json,package-lock.json,verify.mjs} "$PAIR_DIR/"
(umask 077; cd "$PAIR_DIR"; npm ci --ignore-scripts --no-audit --no-fund)
node "$PAIR_DIR/verify.mjs" "$PAIR_DIR"
```

`npm ci` verifies the locked package integrity. The probe resolves the actual
paired entrypoints and checks their version/capability without connecting to
Hub or launching a vendor session. Preparation does not prove live adoption.
If installation fails, retain the old software and do not activate the partial
directory. A new directory can be prepared after the failed attempt is reviewed.

## Activate one ordinary Codex app-server node in an idle window

The node's current turn must have ended normally. Confirm no queued/delivered/
running work is about to be consumed, and coordinate with its existing owner so
another turn cannot start during the maintenance window. Preserve the original
working directory, canonical node ID, alias, provider/model, node-specific
CODEX_HOME, login files and persisted original thread. Record the old CLI and
runtime paths first. Keep the existing private config/state backups under the
same restricted ownership; do not copy their contents into this software tree
or Git. If the persisted thread differs from the original active thread, stop
here and investigate that difference rather than creating or forking a thread.

Run from the original workspace, using the normal selected-node lifecycle:

```bash
set -e
cd "$ORIGINAL_WORKDIR"
node "$OLD_CLI_ENTRY" node stop "$NODE_ALIAS"
# Require a successful stop and confirm the old selected supervisor/child exited.
ANET_AGENT_NODE_BIN="$PAIR_DIR/node_modules/@sleep2agi/agent-node/dist/cli.js" \
  node "$PAIR_DIR/node_modules/@sleep2agi/agent-network/dist/bin/anet.cjs" \
  node start "$NODE_ALIAS"
```

The normal start uses the existing config and original thread; omit new-session,
force, init, login, adopt and fork flags. Record the actual parent/child
entrypoint/version and resumed thread, not just installed package versions.
`restart_node` / `restart_only` reuses the old W1 supervisor's selected command
and is not evidence of a 139 upgrade. This procedure covers an ordinary local
Codex app-server node. External app-server/co-presence and daemon-managed nodes
must use their existing owner's lifecycle; do not apply this procedure to them
by guessing process or tmux names.

For a node already recorded with `codexLaunchLayout=external-appserver`, the
existing controller has `node restart <alias> --bridge-only`; run that controller
from this paired CLI with `ANET_AGENT_NODE_BIN` set after the same idle-window
checks. It resolves the new bridge before replacing it and verifies the resumed
thread while retaining the app-server/TUI. Do not add `--external-appserver` just
to force this path: that flag writes launch-layout metadata.

The selected legacy node examined on 2026-10-13 is a different case: its original
thread matches `codexThreadId`, it has a shared app-server URL and co-presence
enabled, but has no recorded external-appserver layout or generation marker.
Its old supervisor uses CLI 153/Node 121. A generic `node stop` can include legacy
co-presence sessions; a Hub restart reuses the old supervisor. Neither establishes
a verified bridge-only upgrade for this layout. Keep this installation inactive
until its existing lifecycle owner confirms a handoff that retains that server,
TUI and original thread. This profile does not change that layout automatically.

## Live acceptance and rollback

After same-identity heartbeat and SSE return, use a normally assigned real task.
Read back its exact node/network/thread/turn binding and immutable consumed time.
Two genuine runtime-activity samples separated by the 30-second report gate
must advance `last_activity_at`; node heartbeat, ACK, queue time and repeated
consume do not qualify. Confirm the normal original-task reply, and that a
terminal task receives no further lease. The idle and absolute total caps remain
in force. Do not mark the parent activity-lease requirement complete from this
installation probe or a synthetic task alone.

If startup or original-thread resume fails, preserve the error and both software
directories. Stop only the selected new generation after it is idle, confirm it
exited, then start from the same workspace using the retained old CLI entry and
old runtime entry in `ANET_AGENT_NODE_BIN`. No credential/config/model/provider
change or active-data rollback is part of software rollback.

There is no new service, listener, proxy, port or fleet boot override here. The
existing selected-node supervisor stays the lifecycle authority; a one-node
upgrade does not pin the machine-wide boot sweep. Git restores this software
and procedure. Credentials, original sessions and runtime history require the
existing controlled node-state backup; their complete disaster recovery remains
NOT_COVERED by this profile. Do not claim clone alone restores them.

# Agent Node 2.5.0-preview.141 — authenticated human queue window

## Install

After the exact-main release gate succeeds, install this exact private pair
with Node >=22.13:

```bash
set -e
PAIR_DIR="$HOME/.anet-bin/human-queue175-141"
test ! -e "$PAIR_DIR"
install -d -m 700 "$PAIR_DIR"
umask 077
npm install --prefix "$PAIR_DIR" --ignore-scripts --no-audit --no-fund \
  @sleep2agi/agent-network@2.3.0-preview.175 \
  @sleep2agi/agent-node@2.5.0-preview.141
```

## Upgrade

Keep the original node identity, working directory, model/provider, login and
shared-thread layout. Use the original lifecycle owner at a normal idle
maintenance window to adopt the exact pair, then verify actual entrypoints
and an ordinary authenticated Dashboard task. Keep the previous private pair
for software rollback; this change does not restart or migrate any node.
For shared app-server/co-presence nodes, do not assume a generic restart
adopts the new pair or replace the shared thread to test this feature.

## Queue policy and limits

For Codex app-server only, authenticated Dashboard chat requests default to
a finite four-hour FIFO admission deadline. Hub-stamped user origin, the
Dashboard source and a valid Dashboard request ID are required by the existing
inbox classifier. Node/scheduler/legacy or unknown requests retain 30 minutes.
Generic steering permission alone does not extend the queue deadline.

An explicit runtime `queueTimeoutMs` or a valid whole-millisecond
`ANET_QUEUE_TIMEOUT_MS` keeps precedence. Missing/blank/invalid environment
values use the corresponding audience default. Execution, startup and resume
deadlines stay separate; waiting in FIFO is not evidence of consumption or
activity. Hub expiry, cancellation, permission changes and missing rows can
end the wait earlier. This does not guarantee any request remains pending
for four hours, change queue order, inject into an active CommHub turn, or
add queue-position UI.

No credentials, database schema, ports, providers or supervisor configuration
change. Existing operations/deployment and state backup procedures remain
authoritative. Software rollback uses the previous immutable private pair;
login/history recovery still needs its private state backups and cannot be
reconstructed from a Git clone. Public availability, actual adopted runtime
and original-user feedback are separate acceptance gates.

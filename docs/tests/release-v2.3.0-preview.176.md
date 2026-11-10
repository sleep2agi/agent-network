# Agent Network 2.3.0-preview.176 — paired human waiting-queue priority

## Install

All four exact-main gates passed. Node142 and CLI176 are now verified on npm after delayed registry visibility. The official immutable GitHub CLI176 download remains byte-identical to its npm tarball. Use Node >=22.13 and a new private prefix:

```bash
set -e
PAIR_DIR="$HOME/.anet-bin/human-priority176-142"
test ! -e "$PAIR_DIR"
install -d -m 700 "$PAIR_DIR"
umask 077
npm install --prefix "$PAIR_DIR" --ignore-scripts --no-audit --no-fund \
  https://github.com/sleep2agi/agent-network/releases/download/cli-v2.3.0-preview.176/sleep2agi-agent-network-2.3.0-preview.176.tgz \
  @sleep2agi/agent-node@2.5.0-preview.142
```

Verify the downloaded CLI tarball SHA256 `07042f6723a461e033c755b3cdac16c701793b15ec97dcec453d615f4e894a2c` against the official release before adoption. The GitHub asset is the same main83cd gated archive; this download does not republish npm or move its dist-tags. See `report-test1141-human-priority-public.txt` for the retained first installation failure, successful retry and later npm verification timeout.

## Upgrade

Use the original lifecycle owner in a normal idle window to adopt the exact CLI176/Node142 pair. Preserve identity, thread, cwd, model/provider, login and shared-server layout. Verify actual package entrypoints and an ordinary authenticated Dashboard task; public package availability alone does not prove adoption. Retain the prior private pair for software rollback. No global install, restart, config migration, credential copy or private-state recovery is performed by this release. Existing operations/deployment and encrypted-state-backup runbooks remain authoritative for startup, topology, secure secret sources and recovery; a Git clone cannot recover private login/history or production data. A generic shared-node restart can keep the old entrypoint and is not evidence of adoption.

## Waiting priority and limits

Hub-authenticated Dashboard messages lead machine tasks still waiting in both the bounded inbox dispatcher and Codex bridge. Each class remains FIFO. An explicit authenticated-audience marker is required: aliases, scheduler/node/legacy origin and generic steering permission do not promote a task. Cancellation, authoritative queued-row checks and exact task/turn reply attribution remain in force. A deferred drain retains its original place within its class.

Running handlers/turns, startup RPCs and a row already claimed for its Hub check are not preempted. Saturated dispatch waits for a slot; continuous human arrivals can postpone machine tasks, whose original deadlines still apply. The existing authenticated external human-TUI steering path remains; active-owned-CommHub-turn injection and queue-position UI are outside this slice. Runtime defaults stay 4h for authenticated Dashboard requests and 30m otherwise; explicit options/env and Hub expiry/cancel/permissions may terminate earlier. No immediate-response or original-device acceptance guarantee is made.

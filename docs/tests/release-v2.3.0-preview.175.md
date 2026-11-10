# Agent Network 2.3.0-preview.175 — paired human queue runtime

## Install

After the exact-main release gate succeeds, use Node >=22.13 and a new private
prefix:

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

Adopt the exact CLI175/Node141 pair through the original lifecycle owner in
a normal idle maintenance window. Preserve the original thread, working
directory, identity, model/provider and login; retain the prior private pair
for software rollback and verify actual entrypoints after adoption.
No global installation or node restart is performed by this release.

The paired Codex runtime defaults authenticated Dashboard human requests to
a bounded four-hour queue admission window; other sources remain 30 minutes.
Explicit queue options/environment values still win, and the Hub's own
expiry/cancel/permission checks can terminate earlier. Queue order, active
CommHub-turn steering and queue-position UI are outside this slice.
See [runtime policy and recovery boundaries](release-v2.5.0-preview.141.md).
The unchanged co-presence state backup/deployment procedures remain in their
existing runbooks. A Git clone does not contain private login or history.
Public package verification and real original-node adoption are separate.

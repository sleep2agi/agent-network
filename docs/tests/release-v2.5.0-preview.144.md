# Windows co-presence health correction — Node2.5.0-preview.144

Published software alpha: CLI2.3.0-preview.178 / Node2.5.0-preview.144 / existing Hub0.9.0-preview.139. Both exact-main four-gated archives are verified on official GitHub; Both complete npm archives now match gated main and official GitHub; the initial CLI registry-timeout FAIL is retained. Stable/latest unchanged. Source/native fake-Codex CI and full public hashes: report-test1168-windows-health.txt and report-test1168-public.txt. Original-device adoption remains unverified.

## Install

Use the verified official CLI archive and npm @sleep2agi/agent-node@2.5.0-preview.144 in a new private prefix, with Node>=22.13 and Bun1.3.14 for the Hub:

```bash
set -e
ANET_PAIR_DIR="$HOME/.anet-bin/windows-health178-144-139"
test ! -e "$ANET_PAIR_DIR"
install -d -m 700 "$ANET_PAIR_DIR"
umask 077
npm install --prefix "$ANET_PAIR_DIR" --ignore-scripts --no-audit --no-fund \
  https://github.com/sleep2agi/agent-network/releases/download/cli-v2.3.0-preview.178/sleep2agi-agent-network-2.3.0-preview.178.tgz \
  @sleep2agi/agent-node@2.5.0-preview.144 \
  @sleep2agi/commhub-server@0.9.0-preview.139
```

## Upgrade

Use `anet upgrade` only through the original lifecycle owner's normal maintenance procedure, preserving original node/thread/cwd/model/provider/login and shared app-server layout. A package publication does not upgrade or restart a running node. Verify the actual Node144 entrypoint and exact CLI178 pair before a real Dashboard task.

Windows uses native processes; it no longer reports a failed tmux session. Ongoing native TUI health remains unknown, not fabricated healthy. Startup retains exact PID/birth/socket attribution. Real app-server and revoked/expired login degradation still reaches the unchanged Hub guard. Same-turn steering/receipt/native fake-Codex CI does not replace original-device/real-model acceptance.

Startup, ports/proxy and secure environment sources remain in deploy/hub/README.md and deploy/fleet/README.md. Rebuild exact main and frozen locks through the formal release workflow. Roll back using the prior immutable CLI177/Node143 pair and compatible V2 receipt state; the old false-tmux gap returns. Git restores software/schema only: original login, tasks and pending receipts require their existing authorized private backup sources. Hub vault recovery remains NOT COVERED. No live deployment, credential copy or production restore drill is part of this release.

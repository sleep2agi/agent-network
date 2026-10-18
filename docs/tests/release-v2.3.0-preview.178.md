# Windows co-presence health correction — CLI2.3.0-preview.178

Published software alpha: paired Node2.5.0-preview.144, existing Hub0.9.0-preview.139. Both exact-main four-gated archives are verified on official GitHub; Both complete npm archives now match gated main and official GitHub; the initial CLI registry-timeout FAIL is retained. Stable/latest unchanged. Full behavior/recovery limits and hashes: release-v2.5.0-preview.144.md, report-test1168-windows-health.txt and report-test1168-public.txt. Original-device adoption remains unverified.

## Install

Use the verified official archive for @sleep2agi/agent-network@2.3.0-preview.178 and verified npm Node144, in a fresh private prefix, with Node>=22.13 and Bun1.3.14 for Hub:

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

The original lifecycle owner adopts the pair through the normal `anet upgrade`/maintenance procedure. Preserve node/thread/cwd/model/login; verify actual paired entrypoints and a real Dashboard task. Publication does not restart or adopt a live node. Windows ongoing native TUI health remains unknown; app-server and expired/revoked login degradation remain enforced. Original-device and real-model acceptance are separate.

Existing deploy/hub and deploy/fleet runbooks cover launch/ports/proxy/secure environment sources. Roll back to immutable CLI177/Node143 with compatible V2 private receipts; the false-tmux issue returns. Git/frozen locks restore software only; private task/identity/login/receipt data require their existing authorized backup sources. Hub vault recovery remains NOT COVERED. No live deployment or credential copy occurs.

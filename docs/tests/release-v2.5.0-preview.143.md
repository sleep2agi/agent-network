# Agent Node — owned follow-up controller and deep human inlet v2.5.0-preview.143

Released software pair: CLI 2.3.0-preview.177, Node 2.5.0-preview.143, Hub 0.9.0-preview.139. Hub139/Node143 npm full archives and the official CLI177 GitHub archive match the four-gated main builds. CLI npm propagation was pending at the first checkpoint and has since been verified: its complete bytes match the official archive and gated tarball. Native adoption remains unverified. See `report-test1163-public.txt` for exact SHA/bytes and retained pipeline failures.

## Install

Use the verified npm Node/Hub and identical official CLI archive. use Node >=22.13 and Bun 1.3.14 for the Hub. Install into a new private prefix rather than replacing a running node:

```bash
set -e
ANET_PAIR_DIR="$HOME/.anet-bin/owned-inbox177-143-139"
test ! -e "$ANET_PAIR_DIR"
install -d -m 700 "$ANET_PAIR_DIR"
umask 077
npm install --prefix "$ANET_PAIR_DIR" --ignore-scripts --no-audit --no-fund \
  https://github.com/sleep2agi/agent-network/releases/download/cli-v2.3.0-preview.177/sleep2agi-agent-network-2.3.0-preview.177.tgz \
  @sleep2agi/agent-node@2.5.0-preview.143 \
  @sleep2agi/commhub-server@0.9.0-preview.139
```

The releases must be built and published from their exact merged main commit, with all four formal gates passing. Confirm npm package names, versions and archive hashes against the formal artifacts before adoption. Stable/latest is unchanged.

## Upgrade

The original Hub/node lifecycle owner adopts this exact pair in a normal maintenance window. Preserve node identity, original thread, cwd, model/provider, login and shared-server layout. Publication does not restart or upgrade a running node. Verify the actual package entrypoints and the versioned `human_inbox` response, then a real authenticated Dashboard task beyond a blocked first page. An older Hub remains usable but produces an explicit partial-capability warning.

The controller durably identifies one accepted input and one independent answer turn. Unknown delivery, cancellation and capacity failures do not replay the action. A reply-only prompt is not a claim of native tool isolation or original-device acceptance. Keep private receipts and outbound delivery state through the existing authorized backup process. Do not downgrade pending V2/answer-intent receipts to V1 readers; a rollback needs compatible private state and the prior immutable software pair.

Startup, proxy/ports and secure environment sources remain in `deploy/hub/README.md` and `deploy/fleet/README.md`. Software/locks are in Git; production inbox/tasks, identities, login and receipts require private backups. The existing Hub vault recovery record source remains NOT COVERED; this release does not claim a full production-data restore drill.

## Behavior and validation

Authenticated human rows are found with 256-row metadata keyset pages, without a fixed depth cutoff. Body return stays bounded (Node 20), and active claims/overall 20 handlers remain intact. Both SQLite and PostgreSQL real-Hub/production-CLI cases passed 20/21/1000 backlog, source-forgery, network/recipient, FIFO and dedup checks. No-human scans are linear in scoped pending metadata; this is not a constant-cost materialized index. See `report-test1163-human-inbox.txt` for tests and retained failures.

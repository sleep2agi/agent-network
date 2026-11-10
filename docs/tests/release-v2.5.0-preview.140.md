# Agent Node 2.5.0-preview.140 — V1 co-presence login persistence

## Install

The exact-main Node140 package is public and byte/SRI verified. CLI174's same
gated tarball has an official fixed download; its original npm registry-wait
timed out and the formal failure is retained. Install this exact pair in a new
private directory with Node >=22.13:

Late CLI174 npm byte/SRI verification passed at 15:47:34+08; its original
formal timeout failure remains recorded. Both CLI distributions contain the
same gated artifact, and the fixed-download command below stays valid.

```bash
set -e
PAIR_DIR="$HOME/.anet-bin/opencode1120-174-140"
test ! -e "$PAIR_DIR"
install -d -m 700 "$PAIR_DIR"
umask 077
npm install --prefix "$PAIR_DIR" --ignore-scripts --no-audit --no-fund \
  @sleep2agi/agent-node@2.5.0-preview.140 \
  'https://github.com/sleep2agi/agent-network/releases/download/cli-v2.3.0-preview.174/sleep2agi-agent-network-2.3.0-preview.174.tgz'
```

## Upgrade

Preserve the original node identity, model/provider, pinned OpenCode binary,
working directory, private login file and current state backup. Wait for a
normal idle maintenance window, then use the original lifecycle owner and the
exact paired private CLI/runtime. Check actual adopted entrypoints and the
original user's login after normal restart. Keep the old private pair for
software rollback. Do not mix CLI173 with runtime140 or overwrite a global
installation. History and crash-recovery acceptance remain separate.

## Changes and limits

Paired CLI: `@sleep2agi/agent-network@2.3.0-preview.174`.

V1 OpenCode co-presence now stages node-local API/OAuth/wellknown auth data in
the fresh launch directory and atomically saves changed login, refresh and
logout data after owned processes exit, before cleaning that directory.
Version probes and headless ACP keep their existing credential boundaries.
Concurrent node-auth edits and unsafe credential paths are refused without
overwriting them. No credential values are included in persistence errors.

This covers normal stop/restart, not SIGKILL/crash recovery or deleted auth.
Session-history recovery and actual original-node login/restart feedback remain
separate acceptance gates. Use the [co-presence runbook](../runbooks/opencode-tui-copresence.md)
for private state backup, software rollback and pending live verification.

Source/gates/public-byte details are recorded in
[publication facts](report-test1120-publication.txt). Original-user feedback
remains pending. No stable tag change is requested.

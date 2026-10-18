# Agent Network CLI 2.3.0-preview.174 — paired login-persistence runtime

## Install

The fixed artifact is `@sleep2agi/agent-network@2.3.0-preview.174`.

The original main-built tarball passed all four gates and is available through
the [official fixed download](https://github.com/sleep2agi/agent-network/releases/download/cli-v2.3.0-preview.174/sleep2agi-agent-network-2.3.0-preview.174.tgz).
npm publish succeeded; its registry verification timed out and the original
formal run remains FAILURE. Use a new
private directory with this same gated tarball, the public Node140, and Node >=22.13:

Late npm full-byte/SRI verification also passed at 15:47:34+08. npm174 and the
fixed download are the same original artifact; the failed formal verdict stays
in history. The available fixed-download command below is retained unchanged.

```bash
set -e
PAIR_DIR="$HOME/.anet-bin/opencode1120-174-140"
test ! -e "$PAIR_DIR"
install -d -m 700 "$PAIR_DIR"
umask 077
npm install --prefix "$PAIR_DIR" --ignore-scripts --no-audit --no-fund \
  'https://github.com/sleep2agi/agent-network/releases/download/cli-v2.3.0-preview.174/sleep2agi-agent-network-2.3.0-preview.174.tgz' \
  @sleep2agi/agent-node@2.5.0-preview.140
```

## Upgrade

Preparing this software does not restart a node. Retain the original node
identity, login, model/provider, OpenCode pin and workdir, and use its existing
lifecycle owner during a normal idle window. Verify actual paired adoption and
original-user login after normal restart. Keep the old software for rollback;
do not use init/new-session/fork or a mutable dist-tag to replace existing state.

## Changes and limits

Pairs the CLI with `@sleep2agi/agent-node@2.5.0-preview.140` for V1 OpenCode
co-presence auth persistence. See the [runtime change](release-v2.5.0-preview.140.md)
and [runbook](../runbooks/opencode-tui-copresence.md).

The initialization/password implementation is unchanged. The formal package
must pass the usual main-source, install, getting-started and default-bootstrap
gates before public distribution. This candidate does not certify original-node
login/restart or history recovery, and does not change stable dist-tags.

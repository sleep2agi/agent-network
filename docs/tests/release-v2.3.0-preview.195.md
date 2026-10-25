# agent-network (CLI) — paired with agent-node .158, v2.3.0-preview.195

Ships `main` after `.194`. Pair bump plus the mirrored helper; **no CLI behaviour change**.

```
@sleep2agi/agent-network@2.3.0-preview.195
```

## What changed

- **Pair bump:** `PAIRED_AGENT_NODE_VERSION` → `2.5.0-preview.158`
  (`PAIRED_AGENT_NETWORK_VERSION` is this build, `2.3.0-preview.195`).
- The CLI carries the same `windows-rename-retry.ts` helper byte-for-byte as `agent-node`
  (`opencode-create-security-parity.test.ts` compares the two packages' files verbatim). No new CLI
  code path is added by this release: the helper was already there in `.194`, and the state writers
  that use the extended set live in `agent-node`.

## Compatibility

- No CLI flag, output or on-disk format changed.
- `.195` works with older nodes; the pair constant only expresses which node version this CLI was cut
  against.

## Install

```bash
set -e
CLI_DIR="$HOME/.anet/cli-runtime-195"
test ! -e "$CLI_DIR"
install -d -m 700 "$CLI_DIR"
umask 077
npm install --prefix "$CLI_DIR" --ignore-scripts --no-audit --no-fund \
  @sleep2agi/agent-network@2.3.0-preview.195
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.195
anet --version
# paired node runtime: @sleep2agi/agent-node@2.5.0-preview.158
```

## Rollback

`npm i -g @sleep2agi/agent-network@2.3.0-preview.194` and restart long-running processes. The pair
constant rolls back with the package.

## Verification

- `agent-network/src/opencode-agent-node-pair.test.ts` — 6 pass (pair constants agree with
  `package.json` and the spec string).
- `agent-network/src/opencode-create-security-parity.test.ts` — 4 pass (byte-identical copies).
- `scripts/check-doc-version-claims.py --package agent-network --version 2.3.0-preview.195` — every
  stamped claim points at this version (also run for `agent-node@2.5.0-preview.158`).

# agent-network (CLI) — paired with agent-node .157, v2.3.0-preview.194

Ships `main` after `.193`. Mirror of the node-side Windows fix plus the pair bump.

```
@sleep2agi/agent-network@2.3.0-preview.194
```

## What changed

- **Windows rename retry, CLI copy.** `src/windows-rename-retry.ts` is a **byte-identical** copy
  of `agent-node/src/shared/windows-rename-retry.ts`, and `src/opencode-preset.ts` /
  `src/opencode-runtime-binding.ts` now call it. `opencode-create-security-parity.test.ts`
  compares the two packages' files verbatim — it caught the first draft, which patched only the
  runtime copy, and that gate is the reason both copies move together.
- **Policy, identical on both sides:** retry only on win32, only for `EPERM` / `EBUSY` /
  `EACCES`, backoff **10 / 25 / 50 / 100 / 200 ms** (5 attempts); anything else is thrown at
  once; exhausting the backoff still throws; **POSIX never retries**.
- **Pair bump:** `PAIRED_AGENT_NODE_VERSION` → `2.5.0-preview.157`
  (`PAIRED_AGENT_NETWORK_VERSION` is this build, `2.3.0-preview.194`).

## Compatibility

- No CLI flag, output or on-disk format changed.
- A CLI at `.194` works with older nodes; the pairing constant expresses which node version this
  CLI was cut against, and `anet` still refuses a mismatched pair where it always did.

## Install

```bash
set -e
CLI_DIR="$HOME/.anet/cli-runtime-194"
test ! -e "$CLI_DIR"
install -d -m 700 "$CLI_DIR"
umask 077
npm install --prefix "$CLI_DIR" --ignore-scripts --no-audit --no-fund \
  @sleep2agi/agent-network@2.3.0-preview.194
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.194
anet --version
# paired node runtime: @sleep2agi/agent-node@2.5.0-preview.157
```

## Rollback

`npm i -g @sleep2agi/agent-network@2.3.0-preview.193` and restart any long-running process. The
pairing constant rolls back with the package; nothing on disk needs converting.

## Verification

- `agent-network/src/opencode-create-security-parity.test.ts` — 4 pass (byte-identical copies).
- `agent-network/src/opencode-preset.test.ts` — 18 pass · `opencode-runtime-binding.test.ts` —
  18 pass, both run on this branch.
- `agent-network/src/opencode-agent-node-pair.test.ts` — 6 pass (pair constants and the spec
  string agree).
- `scripts/check-doc-version-claims.py --package agent-network --version 2.3.0-preview.194` —
  every stamped claim points at this version (also run for `agent-node@2.5.0-preview.157`).

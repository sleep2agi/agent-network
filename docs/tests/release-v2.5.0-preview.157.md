# agent-node — Windows rename retry for config writes, v2.5.0-preview.157

Ships `main` after `.156`. **One robustness fix, Windows-only in effect.**

```
@sleep2agi/agent-node@2.5.0-preview.157
```

## What changed

On Windows, `rename()` over a file another handle has open fails with `EPERM` (POSIX
succeeds). Every private-state and config writer here is "write a temp file, then rename", so the
same write is atomic on Linux and intermittently red on Windows:

```
[anet] ❌ Windows Codex co-presence failed: EPERM: operation not permitted,
  rename '...\.windows-copresence.json.<rand>.tmp' -> '...\windows-copresence.json'
```

Two additions, both **bounded** and both refusing to hide a real conflict:

- `shared/windows-rename-retry.ts` — `renameOverExistingSync(temp, path)`:
  - retries only on **win32** and only for `EPERM` / `EBUSY` / `EACCES`, with a backoff of
    **10 / 25 / 50 / 100 / 200 ms** (5 attempts, ≈385 ms total);
  - any other error is thrown on the first attempt;
  - exhausting the backoff still throws — nothing is swallowed;
  - **POSIX never retries**: there the rename is supposed to succeed, and a retry would only
    delay a real bug rather than fix it.
- Applied to the config writes that **another process reads while we write them**:
  `runtime/opencode-copresence/shared-v2-mcp.ts` (OpenCode config — the TUI reads it
  continuously), `shared/opencode-preset.ts` (`auth.json`),
  `shared/opencode-runtime-binding.ts` (binding file).

Deliberately **not** applied to writes whose target does not exist yet (staged → final,
quarantine) or to writers that already fall back in a `catch`: retrying those only turns "it really
conflicts" into "it conflicts 385 ms later".

## Compatibility

- Node behaviour is unchanged on Linux and macOS.
- On Windows the only difference is that a transiently-held target now succeeds instead of
  failing.
- `agent-network` keeps a byte-identical copy of the helper and of the two config writers
  (`opencode-create-security-parity.test.ts` compares the files verbatim, and that gate is why
  the CLI copy was patched in the same change).

## Install

```bash
set -e
NODE_DIR="$HOME/.anet/node-runtime-v157"
test ! -e "$NODE_DIR"
install -d -m 700 "$NODE_DIR"
umask 077
npm install --prefix "$NODE_DIR" --ignore-scripts --no-audit --no-fund \
  @sleep2agi/agent-node@2.5.0-preview.157
```

## Upgrade

```bash
# pin explicitly; never install a bare tag on a machine someone is using
npm i -g @sleep2agi/agent-node@2.5.0-preview.157
anet --version
# paired CLI for this node version: @sleep2agi/agent-network@2.3.0-preview.194
```

Existing nodes need a **restart** to pick the fix up (the runtime process loads the code at start).

## Rollback

`npm i -g @sleep2agi/agent-node@2.5.0-preview.156` and restart. No on-disk format changed: the
retry is a call-site change only, so nothing written by `.157` needs converting.

## Verification

- `agent-node/src/shared/windows-rename-retry.test.ts` — 4 pass: the exact backoff sequence
  `[10,25,50]` after three `EPERM`s · stops after 5 attempts and rethrows · **linux does not
  retry at all** · a non-transient error (`ENOENT`) is thrown with zero backoff.
- Affected suites, run locally: `shared-v2-mcp` (2), `v2-session` (23), `node-name-652` (30),
  `opencode-create-profile` (12), `opencode-preset` (18), `opencode-runtime-binding` (18) — all green.
- `agent-network/src/opencode-create-security-parity.test.ts` — 4 pass (the two packages' copies
  are byte-identical again).
- Real-device evidence: `Windows Codex co-presence native smoke` went **green** on the PR that
  introduced the private-state retry (the same suite that had failed with `EPERM`).

# agent-node — rename retry for the remaining state writes, v2.5.0-preview.158

Ships `main` after `.157`. **Windows-only in effect, one behaviour change: more state files survive a
briefly-held target.**

```
@sleep2agi/agent-node@2.5.0-preview.158
```

## What changed

`.157` added `renamePrivateStateSync()` and applied it to the config writes another process reads
(`shared-v2-mcp`, `opencode-preset`, `opencode-runtime-binding`). This release extends the same
call to the **remaining state files that are overwritten and may be read by someone else while
being rewritten**:

| File | Why it qualifies |
|---|---|
| `runtime/opencode-copresence/runtime.ts` (2 sites) | rendered OpenCode config — the TUI keeps reading it; and a `0o700` launcher script other processes invoke |
| `runtime/opencode-acp/profile-state.ts` | OpenCode state file, read by the runtime |
| `runtime/opencode-acp/child-env.ts` | saved credentials, read by opencode |
| `runtime/opencode-copresence/v1-checkpoint.ts` | recovery point that is overwritten (the `exclusive` branch still uses `linkSync`, unchanged) |
| `runtime/opencode-copresence/v1-borrowed-tui.ts` | `state: "running"` record, read from outside |

**Policy is unchanged and identical on both sides of the pair:** retry only on win32, only for
`EPERM` / `EBUSY` / `EACCES`, backoff **10 / 25 / 50 / 100 / 200 ms** (5 attempts); any other error
is thrown at once; exhausting the backoff still throws; **POSIX never retries**.

## What is deliberately NOT covered

- **Creation-semantics writes** (`linkSync` in the `exclusive` checkpoint branch, staged → final,
  quarantine): the target is not supposed to exist, so a collision must fail, not wait.
- **Writers that already fall back in a `catch`**: retrying there only turns "it really conflicts"
  into "it conflicts 385 ms later".
- **`codex-auth-fingerprint.ts`**: it must stay **byte-identical** across `agent-node` and
  `agent-network` *and* import node builtins only (both are enforced by gates). Importing the shared
  helper breaks both; that attempt was made and reverted. The constraint is now written next to the
  gate that enforces it (`agent-network/src/codex-auth-fingerprint-parity.test.ts`).

## Compatibility

- No CLI flag, config key or on-disk format changed.
- On POSIX nothing changes at all. On Windows the only difference is that a transiently-held target
  now succeeds instead of throwing `EPERM`.

## Install

```bash
set -e
NODE_DIR="$HOME/.anet/node-runtime-v158"
test ! -e "$NODE_DIR"
install -d -m 700 "$NODE_DIR"
umask 077
npm install --prefix "$NODE_DIR" --ignore-scripts --no-audit --no-fund \
  @sleep2agi/agent-node@2.5.0-preview.158
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.158
anet --version
# paired CLI for this node version: @sleep2agi/agent-network@2.3.0-preview.195
```

Existing nodes need a **restart** (the runtime loads the code at start).

## Rollback

`npm i -g @sleep2agi/agent-node@2.5.0-preview.157` and restart. Nothing on disk needs converting: the
change is call-site only.

## Verification

- `agent-node/src/shared/windows-rename-retry.test.ts` — 4 pass (exact backoff sequence after three
  `EPERM`s; stops after 5 attempts; **linux does not retry at all**; a non-transient error is thrown
  with zero backoff).
- Suites touching the changed files, run on this branch: `codex-auth-fingerprint` (20),
  `runtime-readiness` (32), `codex-login-health` (8), `v1-checkpoint` (6), `v2-readiness` (33),
  `opencode-v1-spawn-snapshot` (2), `shared-v2-mcp` (2), `v2-session` (23), `node-name-652` (30),
  `opencode-create-profile` (12), `opencode-preset` (18), `opencode-runtime-binding` (18) — all green.
- Real-device evidence for the sibling fix: `Windows Codex co-presence native smoke` went green on
  the PR that introduced `renamePrivateStateSync` (the same suite that had failed with `EPERM`), and
  the retry body is present in the shipped `dist/cli.js` of `.157` (backoff array + win32/EPERM
  gate), which is how the artifact — not the source — was checked.

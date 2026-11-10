# agent-node — every transient state rename retries on Windows, v2.5.0-preview.161

Ships `main` after `.160`. Windows-only in effect; no behaviour change on POSIX.

```
@sleep2agi/agent-node@2.5.0-preview.161
```

## What changed

`.158` introduced `shared/windows-rename-retry.ts` and applied it to five state writes. This release
finishes the sweep started in `#2224`:

- **19 more sites** that write `tmp` → final file now go through `renameOverExistingSync()`
  (win32 only, `EPERM` / `EBUSY` / `EACCES` only, backoff **10 / 25 / 50 / 100 / 200 ms**, max
  5 attempts; every other error is thrown immediately, and an exhausted backoff still throws);
- the sites include `cli.ts` config copy, `config-apply`, `commhub-poll-compensator`,
  `fetch-attachment`, `codex-app-server/receipt-ledger`, `goals/store`, `reply-reliability`, the
  side-thread ledgers/receipts/lease/outbox, `opencode-v2-catalog-endpoint`, launcher/binding
  health records and adopt-start markers.

### What deliberately still uses a bare `renameSync`

A new test — `src/shared/windows-rename-coverage.test.ts` — scans `agent-node/src` and fails if a
bare `renameSync(` appears outside a **whitelist with a written reason**. The whitelist names:

| file | why it must not retry |
|---|---|
| `runtime/opencode-copresence/v1-scoped-mcp.ts` | restore/rollback path; retrying would turn one failure into a slower wrong decision |
| `runtime/opencode-acp/child-env.ts` | directory quarantine / restore, not a file held open |
| `runtime/opencode-copresence/attach-tui.ts` | record → prev rotation with an `rm` fallback |
| `runtime/codex-app-server/start-resource-gate.ts` | stale-lock → grave cleanup; failure = “not cleaned”, caller continues |
| `runtime/grok-build-cli-home.ts` | quarantine move (directory) |
| `runtime/stop-daemon.ts` | injected `renameDir` dependency |
| `codex-auth-fingerprint.ts` | `#3017`: byte-identical with the agent-network copy, node builtins only |
| `shared/opencode-borrowed-launch-health.ts` | `#1226`: `cmp`-identical with the agent-network copy; the helper's relative path differs between the two packages |

Adding a new bare call now requires adding a reason to that table — otherwise the suite is red.

## Install

```bash
set -e
npm install -g @sleep2agi/agent-node@2.5.0-preview.161
agent-node --version   # 2.5.0-preview.161
```

## Upgrade

```bash
agent-node --version                       # 2.5.0-preview.160 or older
npm i -g @sleep2agi/agent-node@2.5.0-preview.161
agent-node --version                       # 2.5.0-preview.161
anet node list                             # restart running nodes so they exec the new binary
```

## Verification

- `windows-rename-coverage.test.ts` 2 pass (scan + whitelist liveness)
- `windows-rename-retry.test.ts` 4 pass (same numbers as the agent-network twin)
- `config-apply.test.ts` 113 pass · `bun run build` OK · typecheck ratchet **81 = baseline**

## Not in this release

No permission change, no Hub change, no `latest` dist-tag move, no `/api/status` change. POSIX
behaviour is byte-for-byte the same (the helper performs exactly one rename there).

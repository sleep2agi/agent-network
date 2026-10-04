# agent-node 2.5.0-preview.102

Since `.101` (release merge `a79393ba`, #2347), `agent-node/` has one change:

| Commit | PR | What |
|---|---|---|
| d75bf56d | #2351 | #534: codex-sdk retry path honours the node's sandbox/approval settings |

## Behaviour

- **Security:** the codex-sdk retry path no longer hard-codes full access; a rebuilt thread now uses the node's configured `sandboxMode` / `approvalPolicy` / `skipGitRepoCheck` instead of `danger-full-access` + `never` (#534 / #2351).
- Before, a turn that failed with a non-timeout, non-quota error was retried on a thread built with `sandboxMode: "danger-full-access"`, `approvalPolicy: "never"` and `skipGitRepoCheck: true`, whatever the node's `config.json` `flags` said. A node configured `read-only`, `workspace-write` or `on-request` ran that retry turn with full access, and nothing in the log said so.
- All codex-sdk thread options (goal wake, first turn, retry) now come from one builder, `buildCodexSdkThreadOptions` in `src/codex-sdk-thread-options.ts`.
- **Nodes with no flags configured behave exactly as before**: the defaults are unchanged (`skipGitRepoCheck=true`, `approvalPolicy=never`, `sandboxMode=danger-full-access`, `modelReasoningEffort=low`).
- Not covered: the opt-in `ANET_CODEX_STDIO_DIRECT=1` path still hard-codes its own options (follow-up). The codex-app-server paths already passed the configured flags through.
- No config changes. No dependency changes.

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.102
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.135 @sleep2agi/agent-node@2.5.0-preview.102
```

Nodes must be restarted on the new build for the change to take effect.
- 🔴 **Upgrade both packages together** (`agent-network@2.3.0-preview.135 ↔ agent-node@2.5.0-preview.102`): anet validates the exact paired agent-node version for codex co-presence and `opencode-cli`.
- Publish order: agent-node `.102` first, then agent-network `.135`, both from the same merge commit.

## Evidence

- #2351: `src/codex-sdk-thread-options.test.ts` 7 tests; witnessed red with the old hard-coded retry literal restored in `cli.ts` (2 fail) and with the rebuild helper hard-coded (2 fail).
- test697 L7h (real agent-node, real Hub, fake codex SDK, node configured `read-only` / `on-request` / `skipGitRepoCheck=false`, first turn forced to fail): every `startThread` and the retry `run` carry the configured flags. RESULT: PASS, all 28 mutations red, including the new `sdk-retry-flags-hardcoded-regressed` and `wake-flags-ignored-regressed`.
- test725 (Docker): 2253 pass / 0 fail. `check-mutation-pins` GREEN.

## promote 时的 must_contain

`"version": "2.5.0-preview.102"`

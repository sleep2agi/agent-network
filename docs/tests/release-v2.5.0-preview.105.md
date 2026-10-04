# agent-node 2.5.0-preview.105

Since `.104` (release merge `b58e3c20`, #2370), `agent-node/` has three changes, all on the `ANET_CODEX_STDIO_DIRECT=1` codex lane:

| Commit | PR | What |
|---|---|---|
| d31a0440 | #2372 | #538: `thread/start` honours the node's sandbox / approval flags |
| 155d091f | #2373 | #553: resumes the recorded codex thread via `thread/resume` |
| 77495abc | #2374 | #554: turns get the codex deadline and fail on codex errors |

## Behaviour

- **Sandbox / approval** (#538 / #2372): measured on the real `codex app-server` 0.133.0 and 0.155.1, `thread/start` reads `sandbox` and silently ignores the `sandboxPolicy` key this lane used to send — so the node's settings never reached codex (the thread came back read-only, approval always `on-request`). The node's `sandboxMode` / `approvalPolicy` are now sent as `sandbox` / `approvalPolicy`. A node with no flags keeps exactly what it got before (no sandbox override, `on-request`); it is not widened to the normal lane's full-access default.
- **Resume** (#553 / #2373): `threadId` on `thread/start` is ignored by both versions, so this lane always started a fresh thread. A recorded thread is now resumed with `thread/resume` (with the node's sandbox/approval). If it cannot be resumed (`no rollout found`), the task fails with one line — pick another with `anet resume <alias> --pick`, or remove `session` to start fresh on purpose — and no fresh thread is started in its place. The thread id is recorded after a turn completes (codex writes the rollout only then).
- **Deadline + errors** (#554 / #2374): the turn uses the existing codex timeout (`CODEX_TIMEOUT_MS` / `--codex-timeout-ms` / `flags.timeout` / `flags.codexTimeoutMs`; default 300 s, 0 = off). At the deadline the node sends `turn/interrupt` and fails the task; if codex refuses the interrupt the app-server is restarted so the next task resumes the recorded thread. A non-retrying codex `error`, or a turn completed `failed` / `interrupted`, fails the task with codex's message instead of replying 「（无回复）」. An app-server exit mid-turn fails the task immediately. An empty successful turn still replies 「（无回复）」.
- No config changes. No dependency changes.

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.105
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.138 @sleep2agi/agent-node@2.5.0-preview.105
```

Nodes must be restarted on the new build for the change to take effect.
- 🔴 **Upgrade both packages together** (`agent-network@2.3.0-preview.138 ↔ agent-node@2.5.0-preview.105`): anet validates the exact paired agent-node version for codex co-presence and `opencode-cli`.
- Publish order: agent-node `.105` first, then agent-network `.138`, both from the same merge commit.

## Evidence

- #2372: unit 14 pass (witnessed reds 12/2 and 10/4); test697 30/30 mutations red incl. new L7i.
- #2373: unit 24 pass (3 witnessed-red groups); agent-node `bun test src/` 2295 pass; test697 33/33 incl. L7j on the real bundled app-server 0.133.0.
- #2374: unit 39 pass (6 mutations red); agent-node `bun test src/` 2310 pass; test697 37/37 incl. L7k (model unreachable → failed) and L7l (3 s timeout → one `turn/interrupt` per turn); test520 13/13.

## promote 时的 must_contain

`"version": "2.5.0-preview.105"`

# agent-node 2.5.0-preview.104

Since `.103` (release merge `d519a76f`, #2366), `agent-node/` has two changes:

| Commit | PR | What |
|---|---|---|
| f580d693 | #2365 | #541: accept the vetted OpenCode V1 pin 1.18.34 (and 1.18.1 during the transition) |
| f7b54f6f | #2368 | #542: opencode backend interface + supported-versions table (no behaviour change) |

## Behaviour

- **OpenCode V1 1.18.34 accepted** (#541 / #2365): the opencode-acp and copresence runtimes accept `opencode-ai@1.18.34` and `1.18.1`, the same list as anet (parity test). Other versions are refused as before.
- **Backend interface** (#542 / #2368): the V1 code moved behind `OpencodeBackend`; asking for V2 throws instead of reusing V1 argv/env. Spawned argv, cwd, child env and the TUI attach launcher are byte-identical to `.103` (golden snapshot recorded on the old code passes unmodified).
- No config changes. No dependency changes.

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.104
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.137 @sleep2agi/agent-node@2.5.0-preview.104
```

Nodes must be restarted on the new build for the change to take effect.
- 🔴 **Upgrade both packages together** (`agent-network@2.3.0-preview.137 ↔ agent-node@2.5.0-preview.104`): anet validates the exact paired agent-node version for codex co-presence and `opencode-cli`.
- Publish order: agent-node `.104` first, then agent-network `.137`, both from the same merge commit.

## Evidence

- #2365: agent-node opencode tests 157 pass (6 new transition tests); typecheck 81 = baseline.
- #2368: agent-node opencode tests 173 pass / 0 fail across 16 files; golden spawn snapshot unmodified; typecheck 81 = baseline.

## promote 时的 must_contain

`"version": "2.5.0-preview.104"`

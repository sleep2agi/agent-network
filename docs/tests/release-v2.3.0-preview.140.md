# agent-network 2.3.0-preview.140

Pairing release: `PAIRED_AGENT_NETWORK_VERSION` → `2.3.0-preview.140`, `PAIRED_AGENT_NODE_VERSION` → `2.5.0-preview.107` (see [`release-v2.5.0-preview.107.md`](./release-v2.5.0-preview.107.md)).

Since `.139` (release merge `c9d04c7e`, #2379), `agent-network/` has one change:

| Commit | PR | What |
|---|---|---|
| ecd33977 | #2380 | #543: OpenCode V2 (`@opencode/cli`) co-presence preview, gated behind `flags.opencodeUnsafeTools` |

## Behaviour

- `anet` can create and start an opencode co-presence node on the OpenCode V2 CLI (`@opencode/cli` 2.x) when `flags.opencodeUnsafeTools=true`; the V2 binary is resolved from the package and its version checked. Without the flag nothing changes and V1 (`opencode-ai`) remains the default.
- The paired agent-node `.107` also pins the Claude SDK (0.3.289) and fixes systemPrompt-after-restart for claude-agent-sdk nodes.

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.140 @sleep2agi/agent-node@2.5.0-preview.107
```

## Upgrade

```bash
anet upgrade --channel preview
# or explicitly:
npm i -g @sleep2agi/agent-network@2.3.0-preview.140 @sleep2agi/agent-node@2.5.0-preview.107
```

Upgrade both packages together (`agent-network@2.3.0-preview.140 ↔ agent-node@2.5.0-preview.107`).

## Evidence

- #2380: unit tests for the V2 binary resolution / generation create / CLI args; Docker suite `tests/test543-opencode-v2-copresence` RESULT PASS on CI (real 2.0.22 binary, loopback stub model); 129/129 checks.

## promote 时的 must_contain

`"version": "2.3.0-preview.140"`

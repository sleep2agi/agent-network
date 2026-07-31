# Grok Co-presence TUI (not released)

::: danger Not currently available
`grok-build-cli` and `anet grok attach` are **not included in npm `latest` or `preview`**. Do not follow older instructions that run `anet node create ... --runtime grok-build-cli`; current published packages do not contain this path.
:::

The repository has a candidate implementation for sharing one Grok TUI between a human and network tasks, but it is still being requalified and is not a released feature. Follow [Issue #537](https://github.com/sleep2agi/agent-network/issues/537) and [Draft PR #538](https://github.com/sleep2agi/agent-network/pull/538) for status and test evidence.

## What works today

- `grok-build-acp`: the current stable Grok runtime. It runs network tasks through `grok agent stdio` and **cannot attach to the same TUI**.
- `grok`: you can use the Grok CLI directly in a terminal, but that does not turn the TUI into an Agent Network co-presence node.

```bash
grok login
anet node create grok-agent --runtime grok-build-acp
anet node start grok-agent
```

Installation and attach steps will return to this page only after the feature ships in a published package. See [version channels](./versioning.md).

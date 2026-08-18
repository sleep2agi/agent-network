# Grok Co-presence TUI (not released)

::: danger Not currently available
Do not follow older instructions for the `grok-build-cli` runtime path — do not run `anet node create ... --runtime grok-build-cli`.

🔴 **Correction (measured 2026-08-18)**: this page used to say `anet grok attach` is "not included in npm `latest` or `preview`". The second half does not hold. Running the real published binaries:

```
latest  2.2.21              anet grok attach → Unknown: grok
preview 2.3.0-preview.39    anet grok attach → Usage: anet grok attach <node>
```

⇒ **The command does exist on `preview`** — it is only missing from `latest`.
**But "the command exists" is not "this co-presence path works"** — only command registration was verified, not end-to-end usability.
The rest of this page still holds: it is being requalified, do not treat it as released.
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

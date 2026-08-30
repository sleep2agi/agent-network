# Grok Co-presence TUI

::: tip Status update (verified in production, 2026-08-29)
The danger block below captures the 2026-08-18 qualification state and is **outdated**: the `grok-build-cli` co-presence path now works end to end — on a Mac mini with npm-installed `anet 2.3.0-preview.43` + the global `agent-node` (grok `1.0.5 (5115b46bc909)`, on the verified list), creating the node, entering the shared TUI via `anet grok attach`, and receiving an answer to an injected network task in 19 seconds. For current usage see [Grok Co-presence TUI (grok-build-cli)](/en/guide/grok-tui). The historical warnings are preserved below for the record.
:::

::: warning Known defect: `blocked` in the roster currently cannot tell real from false (measured 2026-08-30, [#1606](https://github.com/sleep2agi/agent-network/issues/1606))
**With grok 1.0.5 this cell is permanently `blocked`, even while the node is working normally.**

1.0.5 is a **leaderless** build — by design it never creates `leader.sock` (`autoLeader: false` in the capability
table, on both macOS and Linux), while the liveness check requires it unconditionally. `usable` is therefore
structurally false, and the `idle` the heartbeat reports is rewritten to `blocked` every 3 minutes.

Measured: a node marked `blocked` still injected a network task, returned an answer, and replied to the sender.

**Do not rebuild the node when you see `blocked`.** Until this is fixed, judge these nodes by their logs, not by
that cell — `injected network task` / `processTask returned` in the log means the runtime is fine.
:::

::: danger Old state as of 2026-08-18 (archived)
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

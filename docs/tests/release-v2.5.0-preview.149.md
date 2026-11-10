# agent-node 2.5.0-preview.149

Since `.148`, `agent-node/` has one change:

| Commit | PR | What |
|---|---|---|
| 10f8695e | #2835 | #1650: a failed codex co-presence create also reaps its generation |

## Behaviour

- **Codex co-presence honours the same teardown contract as OpenCode V2.** When the post-spawn check fails, the codex branch used to ack `runtime_capability_check_failed` and return while the tmux sessions it spawned kept running. It now runs the shared reaper (launcher handle → `anet node stop` → per-generation pid+start-time fallback), gated by `copresenceTeardownFor`: the gate only opens when the config is ours and `copresence-identity.json` is on disk, so a same-name session owned by someone else is never claimed and `anet node stop` is never called without that marker.
- The ack carries `cleanup=reaped|no_live_generation|handed_to_host|residue` exactly like the OpenCode branch; codex residue is reported as `residue_sessions=`.
- The `exit 0 + marker` success path is untouched: the reaper is not invoked at all.
- No config changes. No dependency changes.

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.149
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.185 @sleep2agi/agent-node@2.5.0-preview.149
```

Nodes and daemons must be restarted on the new build for the change to take effect.
- 🔴 **Upgrade both packages together** (`agent-network@2.3.0-preview.185 ↔ agent-node@2.5.0-preview.149`): anet validates the exact paired agent-node version for codex co-presence and `opencode-cli`.

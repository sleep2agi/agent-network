# agent-node 2.5.0-preview.148

Since `.147`, `agent-node/` has two changes:

| Commit | PR | What |
|---|---|---|
| 4fcfe4e1 | #2830 | #1611: resolve `opencode` by the requested generation, not the first PATH hit |
| a939ae40 | #2832 | #1625: reap the OpenCode V2 generation a failed create leaves behind |

## Behaviour

- **Two `opencode` installs on one machine no longer block each other.** When V1 (`opencode-ai@1.18.x`) and V2 (`@opencode/cli@2.0.22`) are both on the child PATH, the daemon used to stop at the first hit and reject an explicit create for the other generation (`opencode_generation_mismatch`). It now walks the PATH in order and takes the first candidate whose `--version` is accepted *for the requested generation*; the launch side resolves the binary by the same rule, so the check and the spawn cannot disagree. Omitting `opencodeGeneration` still means legacy V1.
- **A failed OpenCode V2 co-presence create no longer leaves a live orphan.** When the post-spawn check fails, create used to ack `runtime_capability_check_failed` and return while the bridge/serve/TUI generation kept running — Hub said "failed", the node was alive. It now tears the generation down (launcher handle → `anet node stop` → per-generation pid+start-time fallback), never touching a borrowed/shared host, and appends `cleanup=reaped|no_live_generation|handed_to_host|residue` to the ack so the outcome is auditable. A surviving residue is reported as `residue_pids=`.
- No config changes. No dependency changes.

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.148
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.184 @sleep2agi/agent-node@2.5.0-preview.148
```

Nodes and daemons must be restarted on the new build for the change to take effect.
- 🔴 **Upgrade both packages together** (`agent-network@2.3.0-preview.184 ↔ agent-node@2.5.0-preview.148`): anet validates the exact paired agent-node version for codex co-presence and `opencode-cli`.

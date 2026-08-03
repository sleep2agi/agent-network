# Server node management

Run one daemon on each Agent host. It manages only the node profiles below its project directory; CLI, Dashboard, and App share the same authorization and state.

> This feature currently requires the matching `preview` release set. Upgrade Hub, agent-node, CLI, and Dashboard together using the [version matrix](/en/guide/versioning).

## Start the host daemon

```bash
anet daemon up server-1
```

Run only one daemon per project directory. Do not share the directory or stop processes with `pkill`/`killall`.

## Manage nodes

```bash
anet daemon nodes server-1
anet daemon create server-1 worker-1 --runtime codex-sdk --model gpt-5.5
anet daemon node stop server-1 worker-1
anet daemon node edit server-1 worker-1 --model gpt-5.6
anet daemon node start server-1 worker-1
anet daemon node restart server-1 worker-1
```

Commands wait for final host confirmation. Editing is allowed only while the node is stopped.

In Dashboard or App, open **Nodes → Server nodes** and select a host.

## Boundaries

- Inventory contains no token, environment value, prompt, or absolute host path.
- Network, alias, and node ID must all match. Conflicts are quarantined.
- Symlinks, traversal, and untrusted launchers are rejected.
- Remote creation currently supports the verified headless runtimes: `claude-agent-sdk`, `codex-sdk`, and `grok-build-acp`. Existing TUI profiles can be discovered and controlled, but are not remotely created yet.

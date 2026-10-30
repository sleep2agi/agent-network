# agent-node 2.5.0-preview.168

Since `.167`, one fix. It is the reason a model change still restarted a node that was perfectly
able to switch in place.

| Commit | What |
|---|---|
| d3d5ba14 | the shared-OpenCode-Server wrapper never forwarded `selectedModel` / `setSelectedModel` |

## Behaviour

- **A shared OpenCode Server node can hot-switch its model again.** `openOpenCodeCopresenceRuntime`
  returns a wrapper object on the `sharedServer` path (an external, shared OpenCode server rather
  than a server this node spawned). That wrapper forwarded `url`, `sessionId`, `attachScriptPath`,
  `isRunning`, `backgroundControl`, `notify`, `submit` and `close` — but **not** `selectedModel` /
  `setSelectedModel`, which live on the inner session object.

  Everything downstream tests for that method before attempting a hot switch, so
  `typeof session.setSelectedModel === "function"` was permanently `false` on every shared-server
  node. The consequences were:
  - before `.167`: the node acked `rejected — "OpenCode V2 session is not running; model was not
    changed"`, and the message named the wrong cause (the session *was* running);
  - with `.167`: every model change **degraded to a restart** — correct, but needlessly expensive.

  Both methods are now forwarded when the inner session exposes them, so a shared-server node
  performs the switch in place. Nothing else changes: the same three conditions still gate the
  hot path (OpenCode runtime, generation `v2`, `copresence` mode), and a node without a live
  session still degrades to a restart exactly as `.167` established.

- No schema change, no config change, no new flag.

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.168
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.168
# restart each node process once so the new dispatch code is loaded
```

Nodes on `.167` keep working — they simply keep restarting on a model change until upgraded.

## Evidence

- Production, `.167`, node `通信欧2号` (shared OpenCode Server, session ready, tasks running
  normally): `00:17:07 v2 shared ready` → `00:18:37` a task replied through the same object →
  `00:19:12` a model patch logged `co-presence session is not running; degrading to restart`.
  One object, `submit` working, `setSelectedModel` absent.
- `agent-node` `tsc --noEmit` error count is unchanged (83, all pre-existing); the touched file
  reports no error.
- `bun test src/runtime/opencode-copresence/` — 24 files, 255 pass / 1 skip / 0 fail.
- **Test gap, stated honestly:** the shared-server tests exercise
  `openVettedOpenCodeCopresence` (the inner session), not this wrapper, which is why the missing
  forward was never caught. A wrapper-level assertion is still to be added.

## Verify after upgrade

On a shared-server node, change only the model:

```bash
# via MCP
update_node_config(node_id, base_revision, { model })
# then read back
GET /api/nodes  → node.model
```

Expected: `apply_mode: "hot"`, `ack status=applied` (not `restarting`), and the node process
**does not restart** — i.e. its `startedAt` is unchanged while `config_revision` increments.

## promote 时的 must_contain

`"version": "2.5.0-preview.168"`

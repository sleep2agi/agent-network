# agent-node 2.5.0-preview.167

Since `.166`, `agent-node/` has one behavioural change and one classification fix.

| Commit | What |
|---|---|
| 4806dbf2 | #3146: a model-only config patch degrades to restart when the co-presence session is gone |
| 623e27e7 | #3146: the local apply-mode classifier accepts the `opencode` runtime alias |

## Behaviour

- **A hot model switch always lands.** `commhub-server 0.9.0-preview.218` started answering
  `apply_mode: "hot"` for a model-only patch on an OpenCode V2 co-presence node, because the node
  had been able to swap the live TUI session model in place for months. The Hub cannot see whether
  that TUI session is still alive on the node, and driving it is the *only* way a hot switch works.
  Production hit exactly that gap: a node whose config says `opencodeMode: copresence` but whose
  session was not running answered `ack rejected — "OpenCode V2 session is not running; model was
  not changed"`, so the user's model change never happened while the console had already accepted
  it.

  When the session is not running the node now **degrades to a restart** instead of rejecting:
  the model change is guaranteed to take effect, at the cost of one process restart. A rejected
  ack looks like a delivered failure; a restart is a delivered change. Users asking for a model
  change want the result, not a particular apply mechanism.

  This is the opposite direction of the `#2050` gate ("a missing hot capability must not veto a
  Hub-requested restart"), so the two cannot fight: `#2050` prevents a hot downgrade that would
  lose a requested restart; this prevents a hot path that would lose a requested change.

- **The local classifier accepts both runtime spellings.** `computeApplyMode` in
  `agent-node/src/runtime/config-apply.ts` matched only `runtime === "opencode-cli"`, but
  agent-node's `RUNTIME_MAP` accepts the short alias `opencode` as well. A node configured with
  the alias therefore restarted on every model change while an identically-built twin hot-swapped —
  same build, same page, different behaviour. Both spellings are now accepted.

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.167
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.167
# restart each node process (the fix is in the config-apply path, read at boot)
```

Nodes already running `.166` keep working against a `.218` Hub — the Hub side of #3146 is what
stops sending `restart` for these patches. The degrade path here is what makes that safe for nodes
whose co-presence session has died, so upgrade in whatever order is convenient and restart the
node when you want the fallback active.

## Evidence

- Production reproduction, before the fix (`.218` Hub, `.166` node, node config
  `opencodeGeneration=v2` / `opencodeMode=copresence`, no live TUI session):
  `update_node_config` with only `model` returned `apply_mode: "hot"`; the node acked
  `rejected — "OpenCode V2 session is not running; model was not changed"`.
- `server/src/config-apply-validate.test.ts` — 11 cases covering the Hub half (hot path, all three
  runtime spellings, v1 / headless / unknown-generation / non-OpenCode fallbacks, mixed
  model+flag and model+channel patches, snapshot parse shapes). 80 pass / 0 fail.
- Related suites (`config-apply-sec1`, `node-id-alias`, `tools-list-json-schema`) 158 pass / 0 fail.
- Typecheck delta against the parent commit is zero (agent-node 83 → 83, all pre-existing).
- End-to-end after upgrade: repeat the same `update_node_config` on a node **without** a live
  session — expect `ack status=restarting` (not `rejected`), a new process, and
  `GET /api/nodes` showing the new `model`.

## promote 时的 must_contain

`"version": "2.5.0-preview.167"`

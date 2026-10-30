# commhub-server 0.9.0-preview.218

Since `.217`, the Hub classifies a model-only patch on an OpenCode V2 co-presence
node as `hot` instead of `restart`. The node could already do this; the Hub was
the one holding it back.

| Commit | What |
|---|---|
| 623e27e7 | #3146: `computeApplyMode` learns the target node's runtime identity |

## Behaviour

- **Changing the model on an OpenCode V2 co-presence node no longer restarts it.**
  `update_node_config` used to return `apply_mode: "restart"` for *any* patch that
  carried `model`. `agent-node` has switched the live TUI session model in place
  since OpenCode V2 co-presence shipped (`agent-node/src/runtime/config-apply.ts`,
  `processConfigUpdate`), and it deliberately does **not** restart on that path.
  The two sides disagreed, and the disagreement was visible to users: the client
  showed "restarting" and then waited for a restart that never came, so the
  config panel never converged.
- **The gate is exactly the node's own gate**: `runtime ∈ {opencode-sdk,
  opencode-cli, opencode}` **and** `opencodeGeneration === "v2"` **and**
  `opencodeMode === "copresence"` **and** the patch is model-only.
- **Everything else keeps `restart`.** v1 nodes, headless V2 nodes (no co-presence
  session to drive), non-OpenCode runtimes, and any patch that also carries flags
  or channels.
- **Callers that pass no runtime identity get the old answer.** `computeApplyMode`
  without `opts` still returns `restart` for a model change — the safe default for
  a node we know nothing about.
- **Runtime spelling is normalised, not guessed.** `nodes.runtime` stores the
  legacy `-sdk` bucket (`opencode-sdk`) for older CLI builds while the config value
  is `opencode-cli` or the short alias `opencode`; recognising only one spelling
  made the same node flip between hot and restart depending on which build
  reported last.
- **`agent-node` picks up the same normalisation** in its local classifier, which
  previously accepted only `opencode-cli` — a node configured with the short alias
  restarted on every model change while its twin hot-swapped.
- No schema change, no config change, no new flag.

## Install

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.218
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.218
anet hub restart
```

`anet` pins the Hub version it starts; restart the Hub on the new build for the
change to take effect. Nodes do not need to be upgraded for the Hub side of this
fix — a hub-only deploy already stops sending `restart` for these patches. The
`agent-node` alias fix ships with the next node release.

## Evidence

- `server/src/config-apply-validate.test.ts` — +11 cases covering the hot path,
  all three runtime spellings, v1 / headless / unknown-generation / non-OpenCode
  fallbacks, mixed model+flag and model+channel patches, and the four
  `readOpencodeSnapshotFlags` input shapes (text / object / junk / null).
- Local: `bun test src/config-apply-validate.test.ts` 80 pass / 0 fail;
  `bun test` over `config-apply-validate` + `config-apply-sec1` +
  `node-id-alias` + `tools-list-json-schema` = 158 pass / 0 fail.
- Typecheck delta against the parent commit is zero (server 218 → 218 errors,
  agent-node 83 → 83; all pre-existing).
- Production target for the end-to-end check: `TMHR欧` (`opencode-sdk`, v2,
  copresence) — a model-only patch should now return `apply_mode: "hot"`.

## promote 时的 must_contain

`"version": "0.9.0-preview.218"`

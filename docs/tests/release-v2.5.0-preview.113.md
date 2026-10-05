# agent-node 2.5.0-preview.113

Since `.112` (release merge `51d77771`, #2408), `agent-node/` has one change:

| Commit | PR | What |
|---|---|---|
| d3e73242 | #2410 | #584: a daemon `create_node` with `node_spec.flags.copresence: true` (runtime `codex-app-server` only) writes the child config's top-level `codexCopresence: true`, so the daemon's `anet node start` brings the node up in Codex co-presence (shared TUI) instead of headless |

## Behaviour

- Before: the app's 「Codex（TUI 共存）」 option produced a headless node. The daemon writes the child `config.json` itself (it never runs `anet node create`) and nothing set `codexCopresence`; `flags.copresence` was rejected with `flag_key_unknown` by both the Hub and the daemon.
- Now the daemon accepts `flags.copresence` (boolean). For `codex-app-server` it moves it out of `config.flags` into the top-level `codexCopresence: true` (`childConfigFieldsFromSpec`); the existing `anet node start` co-presence path then needs no change.
- Any other runtime gets `flag_not_applicable_to_runtime:copresence:<runtime>` instead of silently starting headless. A non-boolean value gets `flag_value_invalid`.
- Requests without the flag are unchanged: still headless (old app versions and other callers keep their meaning).
- **Daemons must be upgraded to this version and restarted to get it** (`anet daemon restart <name>`). A `.112` or older daemon rejects the flag with `flag_key_unknown:copresence`, so the caller sees an error, not a silent headless node.
- **Pairs with Hub ≥ `0.9.0-preview.106`** (`@sleep2agi/commhub-server`). A `.105` or older Hub rejects `flags.copresence` with `flag_key_unknown` before the request reaches the daemon.
- The target machine still needs tmux, codex and a codex login; otherwise the start fails the co-presence preflight (`runtime_capability_check_failed`).

## Known gap

- **Board #596:** a daemon `stop_node` / `delete_node` on a co-presence child does not close its tmux sessions (app-server / TUI / bridge). The pid the daemon records is the `anet node start` orchestrator, which exits once the tmux sessions are up; the daemon's stop signals that process group plus an agent-node sweep. Until #596 lands, stop such a node with `anet node stop <alias>` on its machine, which tears the sessions down.

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.113
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.146 @sleep2agi/agent-node@2.5.0-preview.113
```

Nodes and daemons must be restarted on the new build for the change to take effect.
- 🔴 **Upgrade both packages together** (`agent-network@2.3.0-preview.146 ↔ agent-node@2.5.0-preview.113`).
- Publish order: agent-node `.113` first, then agent-network `.146`, both from the same merge commit.

## Evidence

- #2410: new Docker suite `tests/qa-create-node-codex-copresence` (real Hub + `anet daemon up`; registered in qa.yml and `ci-docs-only.py`): PASS=13 FAIL=8 on the previous main e1e8ad2e → PASS=21 FAIL=0 with the fix. `agent-node/src/runtime/create-node-daemon.test.ts` +5 tests witnessed red on the previous main (`buildAnetArgsDaemon` threw `flag_key_unknown`); `create-node-daemon*` + `daemon-create-capability` 92 pass. PR head e4d3b504 had 133/133 checks green.

## promote 时的 must_contain

`"version": "2.5.0-preview.113"`

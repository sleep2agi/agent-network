# agent-node 2.5.0-preview.98

Since `.97`, `agent-node/` has two changes:

| Commit | PR | What |
|---|---|---|
| d8c56cf3 | #2313 | #517: opencode co-presence classifies its own turn deadline by the abort signal, not `Date.now()` |
| b073deb1 | #2309 | #517: test-only — the codex terminal-event watchdog tests run on fake timers (deflakes test584) |

## Behaviour

- opencode co-presence (`opencode-cli`): when a turn's POST hits the bridge's own deadline, the user now always gets the truthful "submitted / still running" (or "not submitted") reply. Before, Bun's `AbortSignal.timeout` could fire up to 1 ms before `Date.now()` reached the same deadline (measured 160/300 in `oven/bun:1.3.1`), so the check `Date.now() >= deadline` missed it and the raw `TimeoutError: The operation timed out` reached the user. `submit()` now holds the deadline signal itself and checks `turnSignal.aborted`.
- No other runtime behaviour change. No config changes. No dependency changes.

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.98
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.128 @sleep2agi/agent-node@2.5.0-preview.98
```

Nodes must be restarted on the new build for the change to take effect.
- 🔴 **Upgrade both packages together** (`agent-network@2.3.0-preview.128 ↔ agent-node@2.5.0-preview.98`): anet validates the exact paired agent-node version for codex co-presence and `opencode-cli`.

## Evidence

- #2313: new frozen-clock test (`setSystemTime`) fails 5/5 against the old `runtime.ts` with the same DOMException CI saw (run 37127942901); Docker suites test230, test228, test575, test520 (13/13 mutations red), test725 agent-node unit (2225 pass) all rc=0.
- #2309: CPU-restricted Docker stress, watchdog block 0/20 → 20/20; test584/587/588/659 and their mutation harnesses still red on mutation.

## promote 时的 must_contain

`"version": "2.5.0-preview.98"`

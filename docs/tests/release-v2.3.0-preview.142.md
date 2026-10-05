# agent-network 2.3.0-preview.142

Pairing release: `PAIRED_AGENT_NETWORK_VERSION` → `2.3.0-preview.142`, `PAIRED_AGENT_NODE_VERSION` → `2.5.0-preview.109` (see [`release-v2.5.0-preview.109.md`](./release-v2.5.0-preview.109.md)).

Since `.141` (release merge `1ff904b3`, #2387), `agent-network/` has one change:

| Commit | PR | What |
|---|---|---|
| 70091255 | #2389 | #561: `anet node` — interactive menu for every node runtime |

## Behaviour

- **`anet node` with no arguments, in a terminal**, lists every node in the current directory (`# NODE RUNTIME STATE MODEL LOGIN`; LOGIN only for codex nodes, co-presence grok/opencode shown as `(tui)`). Pick a node, then an action: start / restart (`--tmux`, or `--copresence` for co-presence nodes), stop, attach, log, change model, delete. Every action prints the exact `anet …` command and runs it only after `y`; delete requires typing the node name. Codex nodes hand off to the existing `anet node codex` actions (#532), unchanged.
- **Piped / not a terminal:** prints the table, a short cheat sheet (linking the codex cheat sheet) and the previous usage line, then exits 0. No tokens in any output.
- `anet node --help`, `anet node help` and `anet node codex` behave exactly as before.

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.142 @sleep2agi/agent-node@2.5.0-preview.109
```

## Upgrade

```bash
anet upgrade --channel preview
# or explicitly:
npm i -g @sleep2agi/agent-network@2.3.0-preview.142 @sleep2agi/agent-node@2.5.0-preview.109
```

Upgrade both packages together (`agent-network@2.3.0-preview.142 ↔ agent-node@2.5.0-preview.109`).

## Evidence

- #2389: Docker suite `tests/test561-node-menu` (real pty via `script`, private tmux socket inside the container) PASS 14/14, with 6 witnessed reds (hook removed, non-TTY branch removed, shared y/N removed, delete asking y/N instead of the name, codex hand-off removed, token leaking into the table); test532-codex-menu 10/10 after the refactor; `cli-exit-codes.test.ts` 43 pass; tsc 0; 129/129 checks.

## promote 时的 must_contain

`"version": "2.3.0-preview.142"`

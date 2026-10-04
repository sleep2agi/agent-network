# agent-network 2.3.0-preview.137

Pairing release: `PAIRED_AGENT_NETWORK_VERSION` → `2.3.0-preview.137`, `PAIRED_AGENT_NODE_VERSION` → `2.5.0-preview.104` (see [`release-v2.5.0-preview.104.md`](./release-v2.5.0-preview.104.md)), so codex co-presence and `opencode-cli` resolve agent-node `.104`, which accepts the new OpenCode V1 pin.

Since `.136` (release merge `d519a76f`, #2366), `agent-network/` has three changes:

| Commit | PR | What |
|---|---|---|
| f580d693 | #2365 | #541: vetted OpenCode V1 pin 1.18.1 → 1.18.34 with a transition window |
| f7b54f6f | #2368 | #542: opencode backend interface + supported-versions table + node `opencodeGeneration` (no behaviour change) |
| 5340830b | #2369 | #536: codex `anet resume` hardening + thread picker |

## Behaviour

- **OpenCode V1 pin 1.18.34** (#541 / #2365): `anet node start` accepts `opencode-ai@1.18.34` first, then `1.18.1`. With 1.18.1 it starts and prints one line: upgrade with `anet opencode upgrade-pin 1.18.34`. Any other version is still refused with the `npm install -g opencode-ai@1.18.34` hint. Upstream source diff 1.18.1→1.18.34 checked: env vars our safety layer sets, config paths, permission module, `serve`/`attach` flags and session routes unchanged.
- **Supported-versions table + generation** (#542 / #2368): one table (generation → package → accepted versions → status) drives both anet's pin check and agent-node's version gate (byte-identical copies, parity test). OpenCode nodes get `opencodeGeneration: "v1"` in config.json on create, and once on `anet node start` for an older machine-written config; a missing field still means v1. Spawned argv/env/launcher are byte-identical to `.136` (golden snapshot recorded on the old code).
- **codex resume** (#536 / #2369): `anet resume <alias>` on a codex node continues a thread that exists in that node's own CODEX_HOME, or stops with one actionable line (missing rollout, unknown/ambiguous `--thread`, no login with the exact `codex login --device-auth` command, node already running). It never silently starts a fresh thread. `--pick` lists the node's threads newest first (UTC time, short id, first user line); a non-TTY prints the list plus a copy-paste `anet resume <alias> --thread <id>` and exits 2. New codex menu item 7 "resume an earlier conversation" (model/copy/delete move to 8/9/10). Co-presence nodes go through `anet node codex resume`, which now restores the previous `codexThreadId` if it stops before touching anything.

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.137 @sleep2agi/agent-node@2.5.0-preview.104
```

## Upgrade

```bash
anet upgrade --channel preview
# or explicitly:
npm i -g @sleep2agi/agent-network@2.3.0-preview.137 @sleep2agi/agent-node@2.5.0-preview.104
```

Upgrade both packages together (`agent-network@2.3.0-preview.137 ↔ agent-node@2.5.0-preview.104`): anet validates the exact paired agent-node version for codex co-presence and `opencode-cli`.

## Evidence

- #2365: opencode unit tests 124 (anet) + 157 (agent-node) pass; Docker test1225, test610, test621, test228, test230, test725, test745 pass; ad-hoc start check on the built bundle for 1.18.1 (note), 1.18.34 (no note), both, 1.18.2 (refused).
- #2368: golden spawn snapshot recorded on unchanged main passes unmodified after the refactor; three deliberate breakages turn it red. agent-node 173 / anet 146 opencode tests pass; Docker test1225 passes incl. the generation checks.
- #2369: `src/codex-resume.test.ts` (20 tests); anet `bun test src/` 1783 pass / 0 fail; new Docker suite `tests/test536-codex-resume` 15 pass (4 witnessed reds); test532 10/10, test528 pass.

## promote 时的 must_contain

`"version": "2.3.0-preview.137"`

# agent-node — opt-in team-rules injection at startup, v2.5.0-preview.156

Ships `main` after `.155`. **One new capability, off by default**; the rest of the
changes in this version are test-only.

```
@sleep2agi/agent-node@2.5.0-preview.156
```

## What changed

### New (opt-in): the network's team rules land in a managed block

With `ANET_TEAM_RULES=1`, a node reads `GET /api/networks/<net>/rules` once on a
**full start** and maintains a managed block at the top of its rules file —
`CLAUDE.md` for claude nodes, `AGENTS.md` for every other runtime:

```markdown
<!-- ANET:TEAM-RULES v<revision> BEGIN — 由 CommHub 自动维护，块外内容不会被修改 -->
… Hub layer, with source and revision …
<!-- ANET:TEAM-RULES v<revision> END -->
```

Properties that are enforced by tests, not by intent:

- **Everything outside the block is left byte-for-byte alone.** The block is
  replaced whole; an editor's own text is never rewritten.
- **A half-written marker is refused** (one `BEGIN` without `END`, or mismatched
  versions) — the node reports the reason and does not touch the file.
- **The same revision does not change the file.** Re-starting a node with
  unchanged rules produces no diff and does not touch the mtime.
- **Hub unreachable / non-2xx keeps the file exactly as it is** and warns. It
  never deletes the block, because deleting it is silently withdrawing the rules.
- **Failure never blocks startup.** A node that cannot reach the Hub still runs.

### Why it is off by default

It edits a file in the user's working directory. That is a visible side effect and
it must not begin just because the code shipped. Nothing about the node's
behaviour changes unless `ANET_TEAM_RULES=1` is set.

### Test-only changes in this version

- `#2960` — the two native Windows capture tests now carry an explicit 60 s
  timeout; bun's 5 s default was smaller than their real cost.
- `#2967` — when the Windows TUI-health assertion fails, the probe result is
  printed (it used to be truncated out of the diff).
- `#2968` — the fixture's birth query is measured, retried once, and names why it
  failed instead of surfacing a bare `ETIMEDOUT`.

No runtime behaviour change from any of those three.

## What this release does NOT do

- **Only the Hub layer is injected.** Daemon-scoped rules, conflict arbitration
  between layers, a combined size cap, and "protected keys" are still open product
  decisions (RFC-043 §8) and are not implemented.
- No pushing at runtime: v1 reads once at startup. Changing rules on the Hub takes
  effect on the node's next **full** start.
- No UI, and no enforcement at task time.

## Verification

- `agent-node/src/runtime/managed-rules-block.test.ts` — 11 pass (block rendering,
  user content preserved byte-for-byte, refused half-markers, idempotent no-op).
- `agent-node/src/runtime/team-rules-inject.test.ts` — 9 pass (disabled means no
  request and no write; unreachable/500 leave the file alone; insert / idempotent /
  revision replace; empty rules create nothing; refused marker; runtime picks the
  right file; token without network scope is skipped).
- `agent-network/src/opencode-agent-node-pair.test.ts` — 6 pass (this release bumps
  `PAIRED_AGENT_NODE_VERSION` to `.156` in the **same** commit, as the pair gate
  requires).
- PRs: `#2969` (RFC), `#2970` (block logic), `#2972` (inject), `#2975` (wiring).

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.156
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.156
agent-node --version     # 2.5.0-preview.156
# restart the node so the new runtime is picked up
```

Turning the capability on, per node:

```bash
# 1) back up the rules file first — the block is added at the top of it
cp AGENTS.md AGENTS.md.bak-$(date +%Y%m%d-%H%M%S)   # or CLAUDE.md on claude nodes
# 2) start the node with the flag
ANET_TEAM_RULES=1 anet node start <alias>           # or your usual launcher with this env
# 3) the startup log shows one line: [team-rules] injected|unchanged|skipped (…)
```

Existing nodes keep running the old runtime until restarted. The CLI pairing
constant is bumped to `.156` in the **following** CLI release
(`agent-network@2.3.0-preview.193`), so this node version is published first and
the pair is closed right after — the same order as `.154`/`.191` and `.155`/`.192`.

## Rollback

`npm i -g @sleep2agi/agent-node@2.5.0-preview.155` and restart. No data or config
migration is involved. A managed block already written into a rules file stays
there (this release never deletes one); remove the marked section by hand if you
want it gone, or restore the backup taken above.

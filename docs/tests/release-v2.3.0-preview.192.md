# agent-network CLI — pair with agent-node .155, v2.3.0-preview.192

Ships `main` after `.191`. One behaviour-relevant change: the CLI's exact runtime
pair now points at **`@sleep2agi/agent-node@2.5.0-preview.155`**.

```
@sleep2agi/agent-network@2.3.0-preview.192
```

## What changed

- `PAIRED_AGENT_NODE_VERSION` → `2.5.0-preview.155` (plus the matching
  `agent-network/package.json` / `package-lock.json` bump from
  `scripts/sync-pinned-versions.sh`).
- `getting-started`（中英）的 `preview` 版本戳与正文同步到 `.192` / `.155`，否则
  release gate 4 会把这次发布拦下。
- Nothing else: `.191` already carried every other commit on `main`.

## Why this release matters

`agent-node@2.5.0-preview.155` fixes **#1676**: the host-shared OpenCode server
observation refused the whole result (`permission_denied`) whenever *any*
`/proc/<pid>/fd` was unreadable — which is every normal host (root daemons, and
same-uid daemons with `PR_SET_DUMPABLE=0`). Every daemon-created V2 node therefore
fell back to a private server without provider credentials, so the first turn
failed with no provider error (the tail of #1610).

With `.192` published, `anet node start` fetches `.155` instead of a runtime that
still has that bug. Nodes must be restarted for the new runtime to run.

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.192
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.192
anet --version    # 2.3.0-preview.192
# restart a node for the .155 runtime to take effect
```

`anet hub start` is unaffected: it resolves the `commhub-server` dist-tag
(`preview` → `0.9.0-preview.148`) and treats `PINNED_SERVER_VERSION` as a floor.

## Verification

- `scripts/sync-pinned-versions.sh @sleep2agi/agent-network 2.3.0-preview.192 --apply`
  produced exactly the version files; the node pin was then set to `.155` in the
  same commit.
- `python3 scripts/check-doc-version-claims.py --package agent-network --version 2.3.0-preview.192 --verify-latest-from-npm`
  passes locally (`latest` stamp intentionally stays at `2.3.0-preview.190` — that
  is what npm's `dist-tags.latest` actually points at).
- After publishing: `scripts/verify-published-pins.sh` must report **3/3**.

## Rollback

Reinstall `@sleep2agi/agent-network@2.3.0-preview.191` (pairs with node `.154`).
No data or config migration is involved.

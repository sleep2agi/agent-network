# agent-network CLI — pair with agent-node .154, v2.3.0-preview.191

Ships `main` after `.190`. One behaviour-relevant change: the CLI's exact runtime
pair now points at **`@sleep2agi/agent-node@2.5.0-preview.154`**.

```
@sleep2agi/agent-network@2.3.0-preview.191
```

## What changed

- `PAIRED_AGENT_NODE_VERSION` → `2.5.0-preview.154` (and the matching
  `agent-network/package.json` / `package-lock.json` bump from
  `scripts/sync-pinned-versions.sh`).
- Nothing else: `.190` already carried every other commit on `main`.

## Why this release is required

`agent-node@2.5.0-preview.154` shipped first, but users installing the published
CLI (`.190`) still asked for runtime `2.5.0-preview.153` — the "half pair" that
`#1811` is about. `scripts/verify-published-pins.sh` catches exactly this:

```
❌ PAIRED_AGENT_NODE_VERSION 期望 2.5.0-preview.154,产物里是: … "2.5.0-preview.153"
```

With `.191` published, `anet node start` fetches the runtime that actually has
OpenCode V2 background control (`state` / `background`), instead of a version
that answers `session_control_unavailable`.

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.191
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.191
anet --version    # 2.3.0-preview.191
```

`anet hub start` is unaffected: it resolves the `commhub-server` dist-tag
(`preview` → `0.9.0-preview.148`) and treats `PINNED_SERVER_VERSION` as a floor.

After upgrading the CLI, a node still has to be restarted for the `.154` runtime
to take effect; the CLI only decides which runtime an upgraded node fetches.

## Verification

- `scripts/sync-pinned-versions.sh @sleep2agi/agent-network 2.3.0-preview.191 --apply`
  produced exactly three files (pair constant + package.json + lock).
- After publishing: `scripts/verify-published-pins.sh` must report both pairs as
  found in the published artifact — the check that failed before this release.

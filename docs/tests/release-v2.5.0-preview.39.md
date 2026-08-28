# agent-node v2.5.0-preview.39 — exact BTW runtime boundary

**Channel:** `preview` only

**Date:** 2026-08-28

This runtime release reports the exact Codex app-server `thread_id` and
attributable `turn_id` when a Hub task is consumed. The evidence is sent once
with the consumed transition; the Hub independently revalidates ownership and
conflicts. Other runtimes and older Hubs retain their existing compatible path.

## Install

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.39
```

For the user-facing paired installation, install
`@sleep2agi/agent-network@2.3.0-preview.53`; it pins this exact runtime and the
already-published `commhub-server@0.9.0-preview.34`.

## Upgrade

Upgrade the CLI/runtime pair on a node, then stop and start that node so its
running agent-node process loads `.39`. Upgrade the Hub to `.34` first. Existing
and historical tasks without an exact boundary remain valid and are not guessed.

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.39
```

Preview only; do not move `latest` until the paired artifacts have passed a real
new-task BTW boundary check.


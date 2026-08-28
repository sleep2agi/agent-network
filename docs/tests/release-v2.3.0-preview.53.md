# agent-network v2.3.0-preview.53 — paired BTW boundary release

**Channel:** `preview` only

**Date:** 2026-08-28

This CLI release pairs `agent-node@2.5.0-preview.39` with
`commhub-server@0.9.0-preview.34`. New Codex app-server tasks can therefore
surface an exact `thread_id` / `turn_id` to the existing BTW drawer instead of
showing the compatibility message that no precise side-thread boundary exists.

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.53
```

The CLI resolves the exact paired node `.39`, and `anet hub start` resolves the
already-published Hub `.34`; it does not float either dependency.

## Upgrade

```bash
anet upgrade --preview
```

Restart upgraded nodes so the new runtime process is active. Operators upgrading
an existing deployment should upgrade the Hub first, then node runtimes, then the
CLI. Only newly consumed tasks on the upgraded path receive exact boundaries;
historical rows remain explicitly absent rather than inferred.

Preview only; no `latest` promotion is part of this release.

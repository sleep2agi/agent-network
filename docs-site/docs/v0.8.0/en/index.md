---
title: v0.8.0 documentation archive
---

# 📦 Agent Network — v0.8.0 documentation archive

::: warning You are viewing a historical archive
This directory is a documentation snapshot of git tag [`v0.8.0`](https://github.com/sleep2agi/agent-network/releases/tag/v0.8.0) (first released 2026-05-11). **The current latest is v0.8.2** (shipped 2026-05-12 via npm `latest` tag; v0.8.1 patch landed in between) — see the [changelog](/en/changelog) and consider [returning to the latest docs](/en/).

Only use this archive if you specifically need v0.8.0 (e.g. your environment is pinned to v0.8.0 and you're cross-referencing this snapshot).
:::

## v0.8.0 content (snapshot)

Quick jumps inside this archive:

- [**Getting Started**](./guide/getting-started)
- [**Architecture**](./guide/architecture)
- [**CLI Commands**](./guide/cli)
- [**Dashboard**](./guide/dashboard)
- [**Tokens**](./concepts/tokens)
- [**Roles & Permissions**](./concepts/roles)
- [**Security**](./concepts/security)
- [**Docker Deploy**](./deploy/docker)
- [**Production Deploy**](./deploy/production)
- [**API Reference**](./api/mcp-tools)
- [**FAQ**](./faq)
- [**Troubleshooting**](./troubleshooting)

## v0.8.0 vs current latest — key diffs

| Item | v0.8.0 (this archive) | v0.8.1 (patch) | v0.8.2 (latest) |
|---|---|---|---|
| Dashboard | 0.4.1 | **0.4.2** (fixes /nodes /admin SSE-online bug) | 0.4.2 |
| CLI | 2.1.4 | 2.1.5 (PINNED_DASHBOARD bump) | **2.1.7** (telegram one-shot + claude-code-cli session resume fix) |
| commhub-server | 0.8.0 | 0.8.0 | 0.8.0 |
| agent-node | 2.3.0 | 2.3.0 | 2.3.0 |

Full diff: [changelog](/en/changelog).

## Which version should I use?

- ✅ **New projects** / upgrading existing ones: use **v0.8.2 latest** ([return to current docs](/en/))
- 📦 **Environment pinned to v0.8.0**: this archive is the reference; upgrade to v0.8.2 is recommended (Dashboard SSE-display bug fixed in v0.8.1; claude-code-cli session resume + telegram one-shot bind added in v0.8.2)
- 🕰 **Historical lookup**: this archive is the exact documentation snapshot at the v0.8.0 git tag

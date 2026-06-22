# Versioning

Agent Network uses two parallel version-number schemes. First-time readers often find this confusing. This page explains how to read them, which one counts as "latest", and when to look at each.

## The two numbers you will see

| Where | Example | What it is |
|---|---|---|
| `anet -v` top line | `anet v2.2.15` | The npm package `@sleep2agi/agent-network` version |
| `anet -v` Components | `agent-node v2.4.11` / `commhub-server v0.8.6` / dashboard `v0.6.0` | Each npm package, independently versioned |
| [GitHub releases](https://github.com/sleep2agi/agent-network/releases) tag | `v0.10.15` | **bundle release** — the anchor name for a wave of npm-package releases |

## What does "latest" mean

**For installs and upgrades**: `anet upgrade` bumps all four npm packages to npm `latest`. Each package page's `latest` dist-tag is authoritative — see [@sleep2agi on npm](https://www.npmjs.com/org/sleep2agi).

**For release tracking**: each bundle release on [GitHub releases](https://github.com/sleep2agi/agent-network/releases) spells out the npm package versions that shipped together in that wave. For instance, `v0.10.15` corresponds to anet `2.2.15` / agent-node `2.4.11` / commhub-server `0.8.6` / dashboard `0.6.0`.

## Why both exist

- **npm package versions are independent**: hotfixes can bump just one package (e.g. commhub-server `0.8.6` lands a server-side fix without forcing the anet CLI to upgrade). Each package evolves via semver on its own cadence.
- **Bundle releases are pacing anchors**: every so often, the packages that "should be upgraded together" get bundled into a `v0.10.x` release published to GitHub. This lets you read one wave's changelog in one place instead of opening four npm pages.

## Practical tips

- Check what you have → `anet -v` (lists all four packages)
- Check release cadence / what one wave includes → [GitHub releases](https://github.com/sleep2agi/agent-network/releases)
- Check a single package's independent hotfix history → that package's npm registry versions list
- Bump to latest → `anet upgrade` (all four at once, no need to pick a wave)

## Next

- [Upgrade Guide](/en/guide/upgrade) — cross-version migration / breaking changes
- [Changelog](/en/changelog) — full change log

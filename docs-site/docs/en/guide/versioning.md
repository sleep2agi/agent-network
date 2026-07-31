# Versioning

Agent Network uses two parallel version-number schemes. First-time readers often find this confusing. This page explains how to read them, which one counts as "latest", and when to look at each.

> 📋 **Which overall version maps to which package versions** (authoritative matrix, kept current): [docs/version/](https://github.com/sleep2agi/agent-network/blob/main/docs/version/README.md)

## The two numbers you will see

| Where | Example | What it is |
|---|---|---|
| `anet -v` top line | `anet v2.2.21` | The npm package `@sleep2agi/agent-network` version |
| `anet -v` Components | `agent-node` / `commhub-server` / dashboard versions | Each npm package, independently versioned (your exact versions are whatever `anet -v` prints) |
| [GitHub releases](https://github.com/sleep2agi/agent-network/releases) tag | `v0.10.15` | **bundle release** — the anchor name for a wave of npm-package releases |

## What does "latest" mean

**For installs and upgrades**: `anet upgrade` bumps all four npm packages to npm `latest`. Each package page's `latest` dist-tag is authoritative — see [@sleep2agi on npm](https://www.npmjs.com/org/sleep2agi).

**For release tracking**: each bundle release's [GitHub releases](https://github.com/sleep2agi/agent-network/releases) notes spell out the exact npm versions of that wave — **treat those notes as authoritative**. To see what you currently have installed, run `anet -v` (it lists all packages). ⚠️ Since `v0.10.15`, packages have mostly shipped their own point releases independently, so npm `latest` is usually ahead of the most recent bundle wave — don't equate a given `v0.10.x` tag with "current latest"; current latest is whatever `anet upgrade` / the npm package pages resolve to.

## Why both exist

- **npm package versions are independent**: a hotfix can bump just one package (e.g. a commhub-server point release fixes a server bug without forcing the anet CLI to upgrade). Each package evolves via semver on its own cadence.
- **Bundle releases are pacing anchors**: every so often, the packages that "should be upgraded together" get bundled into a `v0.10.x` release published to GitHub. This lets you read one wave's changelog in one place instead of opening four npm pages.

## Practical tips

- Check what you have → `anet -v` (lists all four packages)
- Check release cadence / what one wave includes → [GitHub releases](https://github.com/sleep2agi/agent-network/releases)
- Check a single package's independent hotfix history → that package's npm registry versions list
- Bump to latest → `anet upgrade` (all four at once, no need to pick a wave)
- Switch to preview → `anet upgrade --channel preview`; switch back to stable → `anet upgrade --channel latest`

## Next

- [Upgrade Guide](/en/guide/upgrade) — cross-version migration / breaking changes
- [Changelog](/en/changelog) — full change log

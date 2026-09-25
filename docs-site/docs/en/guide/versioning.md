# Versioning

Agent Network uses two parallel version-number schemes. First-time readers often find this confusing. This page explains how to read them, which one counts as "latest", and when to look at each.

> 📋 **Which overall version maps to which package versions** (authoritative matrix, kept current): [docs/version/](https://github.com/sleep2agi/agent-network/blob/main/docs/version/README.md)

## The two numbers you will see

| Where | Example | What it is |
|---|---|---|
| `anet -v` top line | `anet v2.3.0-preview.N` | The npm package `@sleep2agi/agent-network` version |
| `anet -v` Components | `agent-node` / `commhub-server` / dashboard versions | Each npm package, independently versioned (your exact versions are whatever `anet -v` prints) |
| [GitHub releases](https://github.com/sleep2agi/agent-network/releases) tag | `v0.10.15` | **bundle release** — the anchor name for a wave of npm-package releases (older practice; the last one is `v2.2.15` from 2026-06-17, none since) |

## What does "latest" mean

**For installs and upgrades**: `anet upgrade` bumps all four npm packages to npm `latest`. Each package page's `latest` dist-tag is authoritative — see [@sleep2agi on npm](https://www.npmjs.com/org/sleep2agi).

**To see where the channels point now**: `npm view @sleep2agi/agent-network dist-tags` (same for `agent-node` and `commhub-server`). To see what you have installed, run `anet -v` (it lists all packages). Since 2026-06 the npm packages ship independently and no GitHub bundle release is published; the main repo's [GitHub releases](https://github.com/sleep2agi/agent-network/releases) stop at `v2.2.15` (2026-06-17) and do not reflect current versions. Desktop app installers are published at [agent-network-app releases](https://github.com/sleep2agi/agent-network-app/releases).

## Why both exist

- **npm package versions are independent**: a hotfix can bump just one package (e.g. a commhub-server point release fixes a server bug without forcing the anet CLI to upgrade). Each package evolves via semver on its own cadence.
- **Bundle releases were the early pacing anchor**: before 2026-06, packages that "should be upgraded together" were bundled into a `v0.10.x` release published to GitHub. Packages now ship independently; see the [Changelog](/en/changelog) for changes.

## Practical tips

- Check what you have → `anet -v` (lists all four packages)
- Check where the channels point → `npm view @sleep2agi/agent-network dist-tags`
- Check what changed → [Changelog](/en/changelog); list every version of a package → `npm view @sleep2agi/agent-network versions`
- Bump to latest → `anet upgrade` (all four at once, no need to pick a wave)
- Switch to preview → `anet upgrade --channel preview`; switch back to stable → `anet upgrade --channel latest`

## Next

- [Upgrade Guide](/en/guide/upgrade) — cross-version migration / breaking changes
- [Changelog](/en/changelog) — full change log

## Initial admin password by version

- **`>= 2.2.22-preview.4`** (2026-06-28, PR [#264](https://github.com/sleep2agi/agent-network/pull/264) fixing [#261](https://github.com/sleep2agi/agent-network/issues/261); today's `latest` and `preview` are both in this range): the first `anet hub start` prints a **one-time random password** — shown once, save it right then; the first login prompts you to change it.
- **`<= 2.2.22-preview.3` (including `2.2.21` and earlier)**: fixed default `admin` / `anethub` — run `anet passwd` immediately after login.

Any internet-facing deployment must run `anet passwd` right after login, regardless of version.

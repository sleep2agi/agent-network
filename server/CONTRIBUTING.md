# Contributing to Agent Network

Thanks for considering a contribution. This document covers how to set up, propose changes, and get them merged.

## Quick start

```bash
git clone https://github.com/sleep2agi/agent-network.git
cd agent-network
bun install
```

Each subproject (`agent-network/`, `server/`, `agent-node/`) has its own `bun run` scripts — see the `package.json` in that directory.

## Found a bug?

1. Search [existing issues](https://github.com/sleep2agi/agent-network/issues) first
2. If new, open a **bug report** with reproduction steps + your environment (`anet --version`, OS, Node version)

## Want to add a feature?

1. Open a **feature request** issue first to discuss scope
2. Once aligned, fork → branch → PR

Direct PRs without prior discussion are welcome but might be redirected if they conflict with planned work.

## Branching & commits

- Branch off `main`
- Use [Conventional Commits](https://www.conventionalcommits.org/):
  - `feat: add X`
  - `fix: Y was broken when Z`
  - `docs: clarify W`
  - `chore: bump deps`
  - `refactor: extract V`
  - `test: add coverage for U`

## PR checklist

- [ ] Tests pass locally (`bun test` in the affected subproject)
- [ ] Docs updated if user-visible behavior changed (`docs-site/`)
- [ ] No secrets, tokens, or private IPs introduced (we run `gitleaks` in CI)
- [ ] Changelog entry added if release-worthy
- [ ] PR description explains **why**, not just **what**

## Code style

- TypeScript strict mode
- No new `any` without justification
- Prefer existing helpers over new ones

## Releasing (maintainers)

1. Update version in each affected `package.json`
2. Update `docs-site/docs/changelog.md`
3. Tag: `git tag vX.Y.Z`
4. CI publishes to npm with `--tag latest` for stable, `--tag preview` for pre-releases

## Where to ask

- 💬 [GitHub Discussions](https://github.com/sleep2agi/agent-network/discussions) — design questions, ideas
- 🐛 [GitHub Issues](https://github.com/sleep2agi/agent-network/issues) — bug reports, feature requests
- 🔒 [Security Advisories](https://github.com/sleep2agi/agent-network/security/advisories/new) — vulnerabilities

## Code of Conduct

By contributing you agree to follow our [Code of Conduct](./CODE_OF_CONDUCT.md).

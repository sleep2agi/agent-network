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
- **No `Co-Authored-By: Claude*` footer** in commits (OSS rule)
- No secrets / tokens / private IPs / `/home/<user>` paths in commits or diffs

## How changes get merged (lightweight pipeline)

Substantive changes (`agent-network/` / `server/` / `agent-node/` / `agent-network-dashboard/` / root-level `*.md`) should go through a **Pull Request**:

1. Branch off `origin/main` (suggested name: `fix/issue-<N>-<slug>` or `feat/<short-name>`)
2. Implement + commit + push the branch
3. Open a PR — fill in the [PR template](./.github/PULL_REQUEST_TEMPLATE.md)
4. `Closes #N` in the description auto-closes the linked issue on merge
5. At least 1 maintainer reviews, squash-merges
6. GitHub auto-deletes the head branch on merge

Docs-only updates (`docs/**`, `docs-site/docs/**`) can be pushed directly to `main` for now — there is an automated docs-loop that maintains them with high frequency; gating them through PR review would block that.

For the longer-term design (CI checks, branch protection, CODEOWNERS, preview release automation, etc.), see [#15](https://github.com/sleep2agi/agent-network/issues/15) — being rolled out incrementally as the project grows.

## PR checklist

See the [PR template](./.github/PULL_REQUEST_TEMPLATE.md) — the checklist lives there and stays in sync.

## Code style

- TypeScript strict mode
- No new `any` without justification
- Prefer existing helpers over new ones

## Releasing (maintainers)

1. Update version in each affected `package.json` (use `x.y.z-preview.N` for pre-releases)
2. Update `docs-site/docs/changelog.md`
3. Tag: `git tag vX.Y.Z`
4. **`npm publish --tag preview`** first (release-preview-first policy since 2026-05-11 — avoid pushing bugs to all `@latest` users)
5. After manual smoke test, promote: `npm dist-tag add @sleep2agi/<pkg>@x.y.z latest`

Note: no CI auto-publish workflow yet (only `e2e-docker.yml` runs on PRs); all `npm publish` is manual by a maintainer.

## Where to ask

- 💬 [GitHub Discussions](https://github.com/sleep2agi/agent-network/discussions) — design questions, ideas
- 🐛 [GitHub Issues](https://github.com/sleep2agi/agent-network/issues) — bug reports, feature requests
- 🔒 [Security Advisories](https://github.com/sleep2agi/agent-network/security/advisories/new) — vulnerabilities

## Code of Conduct

By contributing you agree to follow our [Code of Conduct](./CODE_OF_CONDUCT.md).

# Contributing to Agent Network

Thanks for considering a contribution. This document covers how to set up, propose changes, and get them merged.

## Quick start

```bash
git clone https://github.com/sleep2agi/agent-network.git
cd agent-network

# 🔴 仓库根目录**没有** package.json —— 依赖是按子包各装各的。
# 在根目录跑 `bun install` 会直接失败:
#   error: Bun could not find a package.json file to install from
cd <子包目录> && bun install
```

仓库有五个子包,各有自己的 `package.json`、依赖和 `bun run` 脚本 ——
`agent-network/`(anet CLI)、`server/`(CommHub 服务端)、`agent-node/`(节点运行时)、
`channel/`、`docs-site/`(https://anet.sh)。脚本以那个目录的 `package.json` 为准。

🔴 `git worktree add` **不带 `node_modules`**。忘了装依赖时,失败签名
**看起来像功能坏了**(`expect(result.code).toBe(0)`,一个字不提依赖) ——
判据:失败全部集中在会 `spawnSync` 真 CLI 的用例上,纯读源码的测试照常全绿。
完整说明见仓库根的 [CONTRIBUTING.md](../CONTRIBUTING.md)。

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

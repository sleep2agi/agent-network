# Contributing to Agent Network

Thanks for considering a contribution. This document covers how to set up, propose changes, and get them merged.

## Quick start

```bash
git clone https://github.com/sleep2agi/agent-network.git
cd agent-network

# 🔴 仓库根目录**没有** package.json —— 依赖是按子包各装各的。
# 在根目录跑 `bun install` 会直接失败:
#   error: Bun could not find a package.json file to install from
cd agent-network && bun install     # anet CLI(这个子目录与仓库同名)
```

装哪个子包取决于你要改什么 —— 五个子包各有自己的 `package.json`、依赖和 `bun run` 脚本：

| 子包 | 是什么 | 常用脚本 |
|---|---|---|
| `agent-network/` | `anet` CLI | `build` / `typecheck` |
| `server/` | CommHub 服务端 | `dev` / `start` / `test` |
| `agent-node/` | 节点运行时 | `build` |
| `channel/` | MCP channel | — |
| `docs-site/` | https://anet.sh 文档站 | — |

脚本以那个目录的 `package.json` 为准，上表只是索引。

### 🔴 在新建的 `git worktree` 里跑测试之前

`git worktree add` **不会**带上 `node_modules`。忘了装依赖时，失败长这样：

```
(fail) #518 node start help ... > real `anet node start --help` names ...
       expect(result.code).toBe(0)
```

**报错里一个字都不会提依赖** —— 因为那几个用例 `spawnSync` 真 CLI，拿到的只是退出码。
自己手跑一次才看得见真因：

```bash
$ bun bin/cli.ts node start --help
error: Cannot find module '@inquirer/prompts'
```

判据:失败**全部**集中在会 spawn 真 CLI 的用例上,纯读源码的测试照常全绿。
先 `cd <子包> && bun install` 再跑。

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

Substantive changes (`agent-network/` / `server/` / `agent-node/` / root-level `*.md`) should go through a **Pull Request**. Dashboard code and docs live in [sleep2agi/agent-network-dashboard](https://github.com/sleep2agi/agent-network-dashboard) — PRs here cannot change them.

1. Branch off `origin/main` (suggested name: `fix/issue-<N>-<slug>` or `feat/<short-name>`)
2. Implement + commit + push the branch
3. Open a PR — fill in the [PR template](./.github/PULL_REQUEST_TEMPLATE.md)
4. `Closes #N` in the description auto-closes the linked issue on merge
5. At least 1 maintainer reviews, squash-merges
6. GitHub auto-deletes the head branch on merge

Docs-only updates (`docs/**`, `docs-site/docs/**`) go through the same PR flow — the "docs-loop" that used to push them straight to `main` no longer exists in this repo (no workflow, no script), and the doc gates catch mistakes either way: `lint (docs integrity)` on any PR touching `*.md`, `docs locale parity` on `docs-site/docs/**`, `doc-symbol-anchors` and `home-path-baseline` on every PR. A docs-only PR is cheap to land; a silent direct push is unreviewed and unguarded.

The PR pipeline (CI checks, branch protection, squash-merge) that issue [#15](https://github.com/sleep2agi/agent-network/issues/15) designed is now in force; that issue is closed.

## PR checklist

See the [PR template](./.github/PULL_REQUEST_TEMPLATE.md) — the checklist lives there and stays in sync.

## QA expectations (the `anet QA (v0)` workflow)

Every PR to `main` runs [`bash scripts/qa.sh`](./scripts/qa.sh) (L0 unit + L1 Docker contract tests, ~40 s on a GH runner). The workflow is currently **report-only**: a red ✕ does **not** technically block merge, but socially it should:

- **Green ✕ on `anet QA (v0)` → strongly prefer fix-or-explain before merge.** This suite has 0 known false positives across 20+ runs; a fresh fail is almost always real.
- **Bypass only if** the failure is unrelated to your change AND you've filed an issue. Document the bypass in the PR description.
- The matrix + strategy live in [docs/qa/](./docs/qa/) — see [docs/qa/README.md](./docs/qa/README.md) for adding new tests (6-step flow).
- v0 ship-readiness snapshot: [docs/qa/v0-summary.md](./docs/qa/v0-summary.md). Roadmap (which way the gate is going next): [docs/qa/v1-roadmap.md](./docs/qa/v1-roadmap.md).

### Don't leave a test sitting near its own timeout (`TEST-MARGIN v1`, #1627/#1309)

The timeout that actually applies to a test often appears **nowhere in its source**:
bun's implicit per-test default, measured on the pinned 1.3.14 (`oven/bun:1.3.14`,
no `bunfig.toml`, no `--timeout` in `qa.sh`), is **5000ms** — a test that never
resolves fails with `[5000.01ms]` and `^ this test timed out after 5000ms.`, with
or without `--coverage`. So grepping for `timeout` finds nothing, and when a slow
runner pushes a near-limit test over, the failure reads exactly like a real defect
(`[20832.89ms]`, with `^ this test timed out after …ms.` only on the next line).
2026-08-31 produced three batches of red this way, one of them on a PR that
changed two `.md` files. `L1-TIMING v1` records durations at **suite** granularity;
this failure mode lives at the **single test**.

- `python3 scripts/check-test-margin.py --logs '/tmp/qa-l0-*.log' '/tmp/qa-l1-*-run.log'`
  prints `TEST-MARGIN v1 tests=… hooks=… threshold=50% near=… slowest=<slug>=<pct>%,…`
  and lists offenders as `duration / effective timeout / pct / source:line`.
  **Effective** timeout = the test's own declared `timeout`, else its `describe`'s,
  else the implicit default above — **measured, not assumed**
  (`bunfig.toml`'s `[test] timeout` and `TEST_MARGIN_DEFAULT_MS` override it).
  Measuring everything against one constant instead would report a test that
  already declares `}, 60_000)` as 90% dangerous (its real margin is 3.3x) *and*
  hide the 2.5–5s unannotated tests this report exists to surface. A hook that
  times out is counted against the timeout it actually hit, because the log names
  the duration but not the hook's declaration.
  It is **report-only** (exit 0; `--pct`/`TEST_MARGIN_PCT` sets the threshold,
  `--fail` is opt-in) and `scripts/qa.sh` calls it next to `L1-TIMING`.
- So: when a test is genuinely slow, **declare** a timeout with headroom over the
  observed duration (own or `describe`-level) and say why in a comment. Do not
  rely on the implicit default for anything slow, and do not leave a test within
  ~2× of whichever timeout actually applies to it.
- Promoting this to a ratchet gate (fail the job) is a separate decision with its
  own threshold; it is deliberately not taken here.

### tmux in tests: always `-L`/`-S` and `env -u TMUX`; never `kill-server` (#505)

A test or script running inside a tmux pane inherits `$TMUX`, and `$TMUX` beats
`TMUX_TMPDIR` when tmux picks its socket. So `TMUX_TMPDIR=$d tmux kill-server`
from a pane kills the **default** server — that is how 71 production nodes went
down at once (#505).

- Every tmux call in a test names a private server: `tmux -L <unique-name> …` or
  `tmux -S <socket> …`, **and** runs with `env -u TMUX -u TMUX_PANE`.
- Never `kill-server`. Clean up with `kill-session -t =<name>` on your own server.
- Tests that start real tmux sessions run inside Docker only.
- Product code calls tmux only through `agent-network/src/tmux.ts` (copy:
  `agent-node/src/tmux.ts`): with `ANET_TMUX_SOCKET` or `TMUX_TMPDIR` set it passes
  `-S` and drops a foreign `$TMUX`; it refuses `kill-server` always.
  `agent-network/src/tmux-ratchet.test.ts` fails on a new raw `execFileSync("tmux", …)`.

### Mutation anchors: refactoring a pinned line breaks a Docker suite you never ran

Many Docker suites prove themselves with witnessed-red mutations that edit one exact source string
(`sed -i 's/…/…/'`, `perl -0pi`, `run_mutation NAME LAYER FILE FROM TO PROBE`, `bun mutate.ts FILE BEFORE AFTER`,
mode tables in `mutate.mjs`, inline `bun -e` / `python3 -` mutators). Change that string and the suite reports
`MUTATION_NOOP` / `anchor count=0`, but only late, in L2 CI. `python3 scripts/check-mutation-pins.py`
(the `mutation pin integrity` workflow, on every PR, about 3 s) finds every such anchor and checks
that it still occurs in the current tree the number of times the harness expects. Exit `1` means a
dead anchor: point the mutation at the new text and keep its meaning. Exit `2` means the
ratchet in `scripts/mutation-pins-baseline.json` went up because a new harness hides its anchor or target
behind a runtime value. Write anchors and targets as literals the gate can read, and don't raise the baseline.
`--list` prints every anchor it checked; `--selftest` exercises each harness form.

## Code style

- TypeScript strict mode
- No new `any` without justification
- Prefer existing helpers over new ones

## Releasing (maintainers)

1. Update version in each affected `package.json` (use `x.y.z-preview.N` for pre-releases)
2. Update `docs-site/docs/changelog.md`
3. Tag: `git tag vX.Y.Z`
4. **Publish to the preview channel via GitHub Actions** (release-preview-first policy since 2026-05-11 — avoid pushing bugs to all `@latest` users):

   ```bash
   gh workflow run release.yml -f package=<pkg> -f version=<x.y.z-preview.N> -f publish=true --ref main
   ```

5. After a real-environment smoke test (≥30 min) **and an explicit owner/lead ACK**, promote:

   ```bash
   gh workflow run promote-latest.yml -f package=<pkg> -f version=<x.y.z-preview.N> \
     -f must_contain='<a string only that version contains>' -f ack=true --ref main
   ```

🔴 **Do not publish from a local machine.** No `npm publish`, no `npm dist-tag add`. This rule
was set on 2026-08-27 after a local `npm publish` that omitted `--tag preview` overwrote the
`latest` tag. Releases go through Actions, and only from `main`.

Note: `release.yml` has a `publish (preview only)` job that runs **only** when four gates all
pass; if any gate is red the publish job is skipped, so a half-broken build never reaches npm.
A local publish has none of that.

## Where to ask

- 💬 [GitHub Discussions](https://github.com/sleep2agi/agent-network/discussions) — design questions, ideas
- 🐛 [GitHub Issues](https://github.com/sleep2agi/agent-network/issues) — bug reports, feature requests
- 🔒 [Security Advisories](https://github.com/sleep2agi/agent-network/security/advisories/new) — vulnerabilities

## Code of Conduct

By contributing you agree to follow our [Code of Conduct](./CODE_OF_CONDUCT.md).

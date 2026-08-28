## Author & Helpers

<!--
Required for anet team collaboration — agent team shares one GitHub account (s2agi),
so we tag each PR with the alias of the primary agent + helpers.
Human contributors leave Author as "human (your-github-handle)".
-->

**Author (Primary)**: <your-agent-alias>

**Helpers** (optional):
- <helper-1>: <role e.g. "design" / "review" / "patch round 2" / "smoke verify">
- <helper-2>: <role>

**Tier review gate**: <reviewer agents, e.g. "通信龙 + 通信SDK马" for onboarding PRs>

## Why

<!-- Motivation + linked issue.
     🔴 二选一，**不要默认选 Closes** —— 判据不是「我修完了没有」，是「**验收现在能不能验完**」：

       Closes #N   判据在这个 diff 里就能验完（改完即成立）
       Refs #N     验收要靠时间 / 样本 / 下一次触发（"真正的验收是下一次它红的时候…"）

     判断方法：如果你在下面任何一节写了「这个 PR 不能证明什么」「真正的验收是……」，
     那就用 Refs，不要用 Closes。
     2026-08-27 实测:当天关闭的 5 个 issue 里 **3 个是误关** —— PR 正文里明写着还没验完，
     末尾却带着 Closes。散文写给人看(人在 issue 关掉之后才读到),关键字写给机器(合入即生效)。
     详见 #1324 / #1337 / #1339 的重开说明。 -->

Refs #

## What

<!-- One-line summary of the change. The diff explains the rest. -->

## How to verify

<!-- Repro steps a reviewer can copy-paste to confirm the change works. -->

## Test evidence

<!-- docker test output, path to docs/tests/report-testN.txt, or screenshot.
     Leave "n/a" for docs-only / template changes. -->

## Checklist

- [ ] Relevant tests pass locally (`bun test`, docker test, etc.)
- [ ] `docs-site/docs/changelog.md` updated (for user-visible changes)
- [ ] Docs synced (interface / command / behavior changes)
- [ ] No secrets / tokens / private IPs / `/home/<user>` paths in the diff
- [ ] Conventional Commits message (`feat:` / `fix:` / `chore:` / `docs:` / `test:` / `refactor:`)
- [ ] **No `Co-Authored-By: Claude*` footer** (OSS rule)
- [ ] Issue 链接用对了关键字：`Closes #N` **仅当验收判据在本 diff 里就能验完**；
      验收要等时间/样本/下一次触发的用 `Refs #N`（判断方法见上面 Why 一节的注释）

<!-- Pipeline reference: #15 -->

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
- [ ] **投递语义自答**：本 PR 若改动了带投递含义的返回值（`ok` / `delivered` /
      `sent` / `acked` / `routed` / `status`），请在 How to verify 里回答一句：
      **没人接收 / 没真正送达时，这个字段是否仍是成功值？**
      <!-- 🔴 为什么要作者自答,而不是留给评审看:这一族的失败态与成功态**在返回值上同值**,
           评审读 diff 看不出来 —— 只有写的人知道那个 ok 是从哪儿来的。
           2026-08-29 一周内三处互不相干的代码同时踩到(#1276 编造收件人 / #1277 delivered
           无条件置位 / #1459 离线丢失仍报 ok:true):不同的包、不同的作者、不同的功能,
           **不是一个 bug 被抄了三遍**。它难被发现是因为:常见路径下碰巧是对的,
           而且修一处不会让另两处变红(它们没有共享代码)。
           判据一句话:这个字段必须来自**投递事实的实测**,不能来自「我把它交出去了」。
           测试写法见 tests/lib/delivery-discrimination.sh(两种相反情形必须给出不同读数)。 -->

<!-- Pipeline reference: #15 -->

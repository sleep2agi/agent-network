# PR Review Room Demo

`anet demo pr-review` is a built-in demo in the anet CLI ([PR #41](https://github.com/sleep2agi/agent-network/pull/41) merged 2026-05-13; already wired into the CLI's `demoCommand`). The CLI spawns 4 ephemeral agents — 3 parallel reviewers (**security / performance / style**) plus 1 final judge — and writes a markdown PR review with an LGTM / Request Changes / Comment verdict that you can paste straight back to a GitHub PR.

Full design contract: [`docs/demos/pr-review-room-proposal.md`](https://github.com/sleep2agi/agent-network/blob/main/docs/demos/pr-review-room-proposal.md).

## One-line run

```bash
# Run an in-repo sample (any of three)
anet demo pr-review --diff tests/test28-pr-review-room/samples/typo-pr.diff

# Run against your local git diff
anet demo pr-review --ref origin/main

# Run against a live GitHub PR
anet demo pr-review --pr https://github.com/sleep2agi/agent-network/pull/40
```

Expect 1-3 minutes (3 reviewers in parallel + judge serial). Requires `anet login` first and a MiniMax API Key:

```bash
export MINIMAX_KEY=sk-cp-...
```

## Roles (4 agents)

| Role alias | Focus | Output |
|-----------|-------|--------|
| `reviewer-security-<suffix>` | injection / credential leakage / authz bypass / SSRF / deserialization / command injection / unsafe reflection / privilege escalation | `- [severity] file:line — issue — fix` lines + `## 安全 issue 数: N` |
| `reviewer-performance-<suffix>` | N+1 queries / O(n²) / unnecessary IO / blocking await / large objects / memory leaks / lock contention / missing caches | same shape + `## 性能 issue 数: N` |
| `reviewer-style-<suffix>` | naming / comments / abstraction levels / dead code / complexity / duplication / type signatures | same shape + `## 风格 issue 数: N` |
| `judge-<suffix>` | dedup by `(file:line)` tuple → sort by severity → pick LGTM / Request Changes / Comment | top-of-file `**决议：**` field + stats + three issue sections + `## 终审说明` |

`<suffix>` is 4 hex characters (e.g. `7f3a`), overridable with `--suffix`.

## Orchestration timeline (6 steps)

```
[1/6]  Create 4 agents (alias suffix -<suffix>)
[2/6]  Start 4 agents in tmux sessions → SSE connected
[3/6]  Broadcast review task to 3 reviewers (parallel)
       └─ Each reviewer logs duration + char count on completion
       └─ Parallel total vs serial estimate (saved ~Xs)
[4/6]  Barrier: collect 3 reviews, pack and dispatch to judge
[5/6]  Judge integrates → final verdict
[6/6]  Write ./pr-review-<suffix>-<ts>.md
       └─ Clean up 4 agents + delete dedicated network (unless --keep)
       └─ Print next steps: less to view + gh pr comment one-liner
```

Parallelism payoff: 3 reviewers run simultaneously, so total review time ≈ the slowest single dimension, not the sum of all three.

## Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--diff <file>` | — | Local `.diff` / `.patch` file |
| `--ref <ref>` | — | Auto-derive patch via `git diff <ref>..HEAD` (e.g. `--ref origin/main`) |
| `--pr <url>` | — | GitHub PR URL, fetched via `gh` CLI (requires local [gh](https://cli.github.com)) |
| `--key <key>` | `$MINIMAX_KEY` / `$ANTHROPIC_AUTH_TOKEN` | MiniMax API key |
| `--out <path>` | `./pr-review-<suffix>-<ts>.md` | Review output path |
| `--keep` | false | Retain 4 agents + dedicated network after run |
| `--step-timeout <s>` | 180 | Per-reviewer / judge timeout in seconds |
| `--suffix <s>` | random 4 hex | Alias suffix |
| `--no-network` | false | Run in current / default network |
| `--network <id>` | — | Use an existing network |

At least one diff entry flag is required.

## Three in-repo sample diffs

`tests/test28-pr-review-room/samples/` ships three fixture diffs covering typical scenarios:

| File | Scenario | Expected verdict |
|------|----------|-----------------|
| `good-pr.diff` | Single-line README typo fix | **LGTM** |
| `typo-pr.diff` | 1-2 minor style issues (dead helper / over-commented) | **Comment** |
| `cross-file-pr.diff` | SQL injection + N+1 query + hardcoded password + path traversal | **Request Changes** |

Run it:

```bash
anet demo pr-review --diff tests/test28-pr-review-room/samples/cross-file-pr.diff
```

Expected output structure is asserted in [`tests/test28-pr-review-room/expected/assertions.json`](https://github.com/sleep2agi/agent-network/blob/main/tests/test28-pr-review-room/expected/assertions.json) — verdict regex / per-dimension issue count ranges / required sections.

> ⚠️ **LLM output is non-deterministic.** What's shown below is the output **structure and fields** (verdict / issue counts / required sections / console pacing) — exact text, ordering, and tone shift with model state, prompt hit rate, and sampling temperature. The structural assertions in [`assertions.json`](https://github.com/sleep2agi/agent-network/blob/main/tests/test28-pr-review-room/expected/assertions.json) (regex + count ranges) are more reliable than verbatim string matches.

## Output markdown structure

`./pr-review-<suffix>-<ts>.md` follows a fixed shape (see [`cli.ts` lines 4876-4891](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L4876)):

```markdown
# PR Review

**来源**: <local file / git diff / owner/repo#N>
**大小**: X.X KB
**时间**: <localized datetime>
**Run**: <suffix>
**总耗时**: Ns

**决议：** LGTM | Request Changes | Comment
**统计：** 安全 N1 处 / 性能 N2 处 / 风格 N3 处

## 安全
- [严重] src/auth.ts:42 — User input concatenated into SQL — use parameterized query
- [中] ...

## 性能
- [中] src/api/users.ts:88 — DB query inside for-loop (N+1) — batch the query

## 风格
- [低] src/utils/format.ts:12 — Name `tmp` is unclear — rename to `formattedRows`

## 终审说明
This PR introduces one severe security risk (SQL injection); recommend switching
to a parameterized query before merge. Performance and style issues are non-blocking
and can be addressed in a follow-up PR.

---
## 附：3 reviewer 原始输出

### reviewer-security (reviewer-security-<suffix>, Xs)
<raw markdown>

### reviewer-performance (reviewer-performance-<suffix>, Xs)
<raw markdown>

### reviewer-style (reviewer-style-<suffix>, Xs)
<raw markdown>
```

> The text content above is illustrative — actual reviewer findings come from the LLM and vary every run. Section headers are in Chinese because the agent prompts use Chinese (preserved verbatim by `judge`).

## Console output cadence

What you see in the terminal once the run starts (see [`cli.ts` lines 4711-4893](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L4711)):

```text
  🔍 PR diff: local file tests/test28-pr-review-room/samples/typo-pr.diff
  📏 Size:   1.0 KB
  📡 Hub:    http://127.0.0.1:9200
  📂 Net:    (pr-review-7f3a net_ab12cd34...)
  🆔 Run:    7f3a

  [1/6] 创建 4 个 agent (alias 后缀 -7f3a)...
        ✓ 创建/更新 4 个 agent
  [2/6] 启动 4 个 agent (tmux session)...
        ✓ 4 agent 全部 SSE connected
  [3/6] 广播 review task 给 3 reviewer (parallel)...
        ✓ reviewer-security-7f3a       38s, 412 字
        ✓ reviewer-performance-7f3a    41s, 287 字
        ✓ reviewer-style-7f3a          52s, 503 字
        ─ 并行总耗时 52s (估串行 131s, 节省 ~79s)
  [4/6] barrier 收齐 3 份 review，整包派给 judge...
  [5/6] judge 整合 + 终审...
        ✓ judge-7f3a 19s, 786 字
  [6/6] 写入 review: ./pr-review-7f3a-1714766365.md
        ✓ 1842 字写入 ./pr-review-7f3a-1714766365.md

  🧹 清理 4 个 agent (用 --keep 跳过)...
        ✓ 删除独立 network (net_ab12cd34...)
        ✓ 清理完成

  🏁 完成！review: ./pr-review-7f3a-1714766365.md

     下一步建议:
       1. 查看: less ./pr-review-7f3a-1714766365.md
       2. 贴到 GitHub PR: gh pr comment <PR-N> --repo <owner>/<repo> -F ./pr-review-7f3a-1714766365.md
```

> Console output is in Chinese (CLI is bilingual: code-path strings + log lines are Chinese; flags / docs are bilingual). Durations / char counts / saved-seconds shown are illustrative — actual LLM runs vary ±50%. The proposed `+seconds` prefix from the [v3 §UX feedback section](https://github.com/sleep2agi/agent-network/blob/main/docs/demos/pr-review-room-proposal.md) is planned for a follow-up iteration.

When using `--pr`, the trailing `gh pr comment` line auto-fills the PR number + repo from the URL — copy-paste as is.

## Network isolation

Same machinery as the [Debate Demo](/en/cases/debate#network-isolation):

1. Auto-creates a dedicated `pr-review-<suffix>` network
2. Provisions 4 ephemeral agents into it
3. Includes `network_id` in dispatched tasks
4. Cascade-deletes all 4 agents + network on exit (tasks, inboxes, node data all cleared)

To keep the run for Dashboard inspection:

```bash
anet demo pr-review --diff <file> --keep
```

With `--keep`, the CLI prints manual cleanup commands at the end:

```text
  📌 已保留 4 个 agent (alias 后缀 -7f3a)。手动清理:
     tmux kill-session -t pr-review-7f3a-*
     anet node delete reviewer-security-7f3a reviewer-performance-7f3a reviewer-style-7f3a judge-7f3a
     anet network delete net_ab12cd34...
```

To reuse an existing network:

```bash
anet demo pr-review --diff <file> --network net_xxx
```

To fall back to the current / default network (legacy behavior):

```bash
anet demo pr-review --diff <file> --no-network
```

## Troubleshooting

Each entry below quotes the actual error text from [`cli.ts`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts):

**❌ 没有 hub. 先 'anet init' 或 'anet hub start'.**

No init or hub not running. `anet init` to configure the hub URL, then `anet hub start` to launch commhub-server.

**❌ 没有 token. 先 'anet login'.**

Not logged in. Run `anet login` to obtain a user token.

**❌ 需要 --diff \<file\> / --ref \<ref\> / --pr \<github-url\> 之一**

One of the three diff entry flags is required. `--diff` is most reliable (no network or gh-CLI dependency), then `--ref`, then `--pr`.

**❌ --diff 文件不存在: \<path\>**

`--diff` path is wrong. Check relative path vs current working directory. Bundled samples live at `tests/test28-pr-review-room/samples/`.

**❌ git diff 失败: ...**

`--ref` failed to run `git diff <ref>..HEAD`. Common causes: ref doesn't exist (run `git fetch`), or current directory is not a git repo (`cd` to project root).

**❌ git diff \<ref\>..HEAD 输出为空**

No diff between `<ref>` and HEAD. Try a different ref, e.g. `--ref main` or `--ref HEAD~5`.

**❌ --pr 需要本地装 gh CLI**

`--pr` requires [gh CLI](https://cli.github.com). After install, run `gh auth login` once. Or switch to `--diff` / `--ref` to bypass.

**❌ --pr 不是合法 GitHub PR URL**

URL must be `https://github.com/<owner>/<repo>/pull/<N>`. Note: it's the PR URL, not an issue URL.

**❌ gh api 拉 PR diff 失败**

`gh` CLI not logged in, missing permissions, or private repo. Run `gh auth status` to check.

**⚠️ diff 大小 X KB > 30 KB**

Non-fatal warning, but MiniMax context may not fit a large diff. Use `gh api -X GET 'repos/.../files'` to pick key files and run them separately.

**❌ 需要 MiniMax key**

No env var or `--key` was provided. `export MINIMAX_KEY=sk-cp-...` or pass `--key sk-cp-...` once.

**❌ 创建 network 失败**

Hub returned a non-OK response. Check `anet hub status`, or pass `--no-network` to fall back to the default network.

**❌ tmux \<alias\>: ...**

An agent's tmux session failed to start. Check `tmux ls` for stale same-named sessions; `tmux kill-server` and retry in the worst case.

**❌ timeout waiting for \<alias\> reply**

A reviewer or the judge didn't respond within `--step-timeout` (default 180s). Usual causes: MiniMax quota exhausted, model failure, or slow inference on a large diff. Bump `--step-timeout 360` or run `anet logs <alias>` for the SDK error.

## Advanced usage

### Paste output back to a GitHub PR

With `--pr`, the closing message gives you a ready-to-copy `gh pr comment` line (PR number + repo pre-filled), e.g.:

```bash
gh pr comment 40 --repo sleep2agi/agent-network -F ./pr-review-7f3a-1714766365.md
```

For `--diff` / `--ref` modes, the closing message gives a template — fill in `<PR-N>` and `<owner>/<repo>` yourself.

### Watch it in Dashboard

Start the Dashboard first:

```bash
anet dashboard
```

Then run the demo in another terminal and open `http://127.0.0.1:5173/network/<network_id>` to see the topology + live message flow of all 4 agents. With `--keep`, the scene is preserved for replay.

### Switch model

The default is MiniMax-M2.7. Swap the 4 agents' `ANTHROPIC_*` env vars to any other Anthropic-compatible endpoint (DeepSeek / GLM / Kimi / Claude). See [Multi-model](/en/guide/multi-model). A side-by-side review-quality comparison across models is planned for v2.

## Next

**More demos**:
- [Debate](/en/cases/debate) — 6 agents, 9-step turn-based orchestration
- [Hello World](/en/cases/hello-world) — minimal two-agent conversation
- [Translation Pipeline](/en/cases/translation-pipeline) — 3-agent chain

**Customize and dig in**:
- Curious why there's no dedicated dispatcher agent? See [§Roles in the full proposal](https://github.com/sleep2agi/agent-network/blob/main/docs/demos/pr-review-room-proposal.md#角色4-个-agentapproved-设计).
- Want to modify the demo? Source at [`agent-network/bin/cli.ts:4585`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L4585) `demoPrReviewCommand`.
- Why a dedicated network per run? See [Networks & Nodes](/en/concepts/networks).

**Watch in Dashboard**:
- `anet demo pr-review --diff <file> --keep` → open the [Dashboard](/en/guide/dashboard) → in the topology you'll see the funnel shape: 3 reviewers in parallel → judge serial.
- The task panel walks you through the I/O of all 4 agents.

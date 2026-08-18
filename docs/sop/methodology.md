# 以 Issue 为中心的 AI-Native 研发迭代流程

> Agent Network 研发组在 v0.7 — v0.9.2 之间累计 11 次 release、200+ commits、40+ memory lessons 之后沉淀出的研发流程。这份文档是 [Issue #85](https://github.com/sleep2agi/agent-network/issues/85) 的正式产物。
>
> **核心叙事**：**GitHub Issue 是 single source of truth**。所有研发动作 — 派任务、reviewing、Release Ops、Verify-First、Lessons 沉淀 — 都围绕 Issue 组织。Issue 是一切的中心，其他章节都是 Issue 中心的不同侧面 / 工作流。
>
> **适用范围**：anet 核心团队（Tier 1 agents）、贡献者（Tier 2+ contributors）、参考方法论的外部团队。
>
> **维护者**：通信龙 + 通信工程马 · **最后更新**：2026-05-16

---

## 0. 为什么需要 SOP

AI-Native 团队特点：

1. **6-10 个并行 agent 同时跑** — claude-code-cli、codex-sdk、claude-agent-sdk 多 runtime 混跑
2. **每天 ship 1-3 次** — preview 节奏快，单 P0 修复链可能 5-7 个 preview 迭代
3. **lessons-fast cycle** — bug 发现到 fix ship 中位数 ~25min，但 lessons 沉淀慢
4. **session 上下文有限** — 单 agent 单 session 上下文 200k tokens 上限，跨 session 知识传递难

这些特点让"凭直觉做事"快速失效。SOP 的作用：

- 把 muscle memory 写成可读规则
- 让新加入 agent 跳过 onboarding 摸索
- 用 verifiable artifact 替代 trust-only 派单
- 让 lessons 不靠口口相传

### 0.1 为什么 "以 Issue 为中心"

传统 software team 用 Slack / Notion / Jira 等多个 tool 散落 context，AI-Native 团队跑得太快，6+ agents 并行 ship、单 session 200k token 上限、跨 session 知识传递天然丢失。**只有 GitHub Issue 是不丢的中心**：

- **不丢**：commit/PR 都强制 link issue；issue 评论永久留痕；agent session 死也不死 issue
- **可搜**：`gh issue list --search "<keyword>"` 100ms 内拿到所有相关历史
- **可分级**：label (P0/P1/P2) + milestone 天然给优先级排序
- **可 cross-link**：`#N` 自动 backref，commit msg 含 `Closes #N` 自动 close
- **公开可读**：OSS 团队 + 外部 contributor 一致 truth

派单不创 issue / 进度不更新 issue / 修完不 close issue —— 这三个反模式都让 AI-Native 团队跑爆，因为下一个 session 没办法从 chat 历史 recover context。**Issue 是 anet 研发的 DRAM，其他都是 cache**。

### 0.2 五个章节如何围绕 Issue 中心

| 章节 | 跟 Issue 的关系 |
|------|----------------|
| §1 Issue-Centric Iteration | 直接讲 issue lifecycle (create / update / close / 留痕) |
| §2 Release Ops | 每个 release 必有 tracking issue (e.g. #132 v0.9.2)，含 promote 进度 / verify 证据 / sub-task 状态 |
| §3 Verify-First | 验证 5 件 artifacts 第 3 件就是 "issue 评论"；smoke verdict 必须 post 进 release tracking issue |
| §4 Agent Dispatch | 派单内容指向 issue；HIGH 30s ack 也是 issue 维度；ETA stale alert 比对的是 issue 进度 |
| §5 Retro & Lessons | lessons cross-link 触发 issues；P0 cycle teach-by-example 引用 #135-#139 series |

## 1. Issue-Centric Iteration

> **核心原则**：每个 anet 工作都从 GitHub Issue 开始或结束，issue = single source of truth。

### 1.1 派任务前先查 issue

```bash
# 收到任务、想到 bug、计划 feature 前必做
gh issue list --repo sleep2agi/agent-network --state open --search "<keyword>"
```

如已有 issue：在评论里推进 / 切 sub-task / cross-link，不重复开。

如没有：先开 issue 锁定 scope（问题描述、复现步骤、期望、owner、ETA），再开干。

### 1.2 进度即时更新

派任务带 ETA ≠ 抢跑。owner 实际进度（无论 ahead 或 behind）必须及时 post issue 评论：

- **Tier 1 agents**（claude-code runtime）：自己 post
- **Tier 2+ agents**（codex-sdk runtime, PAT 受限）：lead 代 post 进度更新

### 1.3 完成必 close —— 评论 4 要素后 close

per Vincent 5273 强制规范：**修完不直接 close, 必先评论 4 要素再 close**。

```
✅ 修完!

- **哪个版本可以用**: agent-network@2.1.15 (npm latest 已 ship)
- **怎么修的**: <root cause + fix 1-2 行 summary + commit SHA>
- **谁修的**: @<github-handle> / Agent-Author: <X马 alias>
- **验证证据**: smoke 测试 / curl 输出 / PR link / release notes link

Closes #<N>
```

**4 要素强制**:

1. **哪个版本可以用** — 用户立刻知道升级到哪个 npm version 拿到 fix
2. **怎么修的** — root cause + fix one-liner，详细 root cause link 到 commit message / PR body / release notes
3. **谁修的** — author agent alias (X马) + github commit author (vansin)，留痕三轨 per [[feedback_attribution_traceability_sop]]
4. **验证证据** — smoke PASS link / Vincent macOS 实战 alive / Docker pexpect output / 同 issue 用户在评论里实测 confirm

**反模式**:
- ❌ 修完直接 close 不评论 — 用户重新打开 issue 找不到 "升级到哪个版本就行" 答案
- ❌ 评论 "fixed" 一字一行 close — 没说哪个版本 / 没 commit SHA / 没 verify 证据
- ❌ commit msg 写 `Closes #N` 但 issue 没 close (PAT scope quirk 可能漏 close) — 必 verify `gh issue view N` state=CLOSED

**24h 内 close**: 修 + 验证 + ship 后 24h 内必 close。超 24h 没 close 算 lead 漏管。

per [[feedback_issue_close_protocol]]：close protocol 是 hard rule，不是 optional。

### 1.4 留痕三轨

per [[feedback_attribution_traceability_sop]]：

- **Issue body**：含 `Author-Agent: <alias>` footer
- **PR body**：含 `## Author` + `Agent: <alias>` 段
- **Commit message**：含 trailer `Co-Authored-By: <agent-alias> <agent@sleep2agi>` 不是 Claude

git author 全是 vansin 看不出谁提的，三轨补齐才知道。

---

## 2. Release Ops

> **核心原则**：以 Issue 为中心，**一个版本一个版本迭代**。每个版本流程：Issue 规划 → preview.N 迭代 + preview 文档同步 → clean version for latest → two-phase npm publish → GitHub release (EN+ZH) → stable 文档同步 (anet.sh 强制) → Vercel deploy。

### 2.0 版本迭代总览 (per Vincent 5282)

一个完整版本 (e.g. v0.9.X → v0.10.0) 的生命周期：

```
┌─────────────────────────────────────────────────────────────┐
│ Stage 1: Issue 规划 (Issue-Centric, §1)                       │
│ ├─ 建 release tracking issue (e.g. #132 v0.9.2)              │
│ ├─ scope 列入 issue body (含 sub-issues + 优先级)              │
│ └─ 子任务派单, 进度更新到 issue 评论                            │
├─────────────────────────────────────────────────────────────┤
│ Stage 2: preview.N 迭代 ship (中间态)                         │
│ ├─ npm publish --tag preview (preview.0 → preview.N)         │
│ ├─ ✅ **preview 文档同步** — 用户拿 @preview 装 时同步 docs      │
│ │   • docs-site 中 @preview reference 跟 preview.N 同步        │
│ │   • CHANGELOG.md preview entry (per-iteration)              │
│ │   • Vercel deploy (10 轮节流) 让 anet.sh preview 用户读到新文档 │
│ └─ 5 件 verifiable artifacts 全绿 + 测试马 smoke PASS          │
├─────────────────────────────────────────────────────────────┤
│ Stage 3: clean version promote latest (正式)                  │
│ ├─ Vincent A signal                                          │
│ ├─ version bump: -preview.N → clean (drop suffix, §2.1)      │
│ ├─ Method B 2-phase npm publish (§2.2)                       │
│ └─ npm dist-tag add latest                                    │
├─────────────────────────────────────────────────────────────┤
│ Stage 4: GitHub Release (§2.4, 含 EN + ZH 双语)                │
│ ├─ release body 跟 §2.4.1 发版规范一致 (10 checklist)          │
│ └─ release tracking issue close + addendum                   │
├─────────────────────────────────────────────────────────────┤
│ Stage 5: ⚠️ **anet.sh stable 文档同步 — 强制**                  │
│ ├─ PINNED_AGENT_NETWORK_VERSION → 新 clean version             │
│ ├─ PINNED_AGENT_NODE_VERSION → 新 clean version                │
│ ├─ CHANGELOG.md stable entry                                  │
│ ├─ README banner v0.X-1 → v0.X                                │
│ ├─ anet.sh version switcher entry                             │
│ ├─ getting-started.md / faq.md 等 banner sweep                │
│ ├─ ZH+EN parity                                               │
│ └─ Vercel deploy --prebuilt --prod                            │
│                                                              │
│ 🚫 anet.sh 文档没同步 = 用户 npm install 拿到新版但 docs 仍指    │
│    旧版 → 用户体验破裂. 这一步**不是 optional**.                │
├─────────────────────────────────────────────────────────────┤
│ Stage 6: post-promote verify & lessons (§5)                  │
│ ├─ 测试马 latest install smoke (R26 SOP)                       │
│ ├─ Vincent macOS retest 实战 verify (ground-truth probe)       │
│ ├─ retro lessons → memory feedback file                       │
│ └─ 通信龙 single telegram surface "all done"                   │
└─────────────────────────────────────────────────────────────┘
```

**Vincent 5282 关键洞察**：

> "先在 issue 做下一个版本规划，npm 然后中间态用 preview.1 .2 发版，然后发正式版本前先更新好 preview 文档，后面再更新文档。正式版本发版一定要配备 anet.sh 网站的文档一定要更新好"

→ **两阶段 docs sync**：
1. **Preview docs** (Stage 2)：跟 preview.N ship 同步，让 `@preview` 用户拿到匹配文档
2. **Stable docs** (Stage 5)：跟 latest ship 同步，**强制 gate**，anet.sh 文档必同步, 不同步=用户体验破裂

→ **一个版本一个版本迭代**：上一个版本 ship 完整闭环（含 Stage 5 docs 同步）才开始下一个版本 issue 规划。不能 skip Stage 5。

### 2.0.1 中间可以插入需求 (per Vincent 5284)

版本迭代流程**不是死板顺序**。Stage 2 preview 迭代中，**新需求 / P0 bug / 用户实测 catch 都可以中途插入**，不必延后到下个版本。

**插入触发条件**（任一）：
- 🔴 **P0 bug** 用户实测撞（e.g. Vincent macOS 5194 撞 #138 launchAgent race during v0.9.2 preview.5）
- 🟡 **scope creep**：原 issue 解一半发现 sub-issue（e.g. #138 ripple 到 #139 5 个 async dispatch）
- 🟢 **战略机会**：竞品出新功能 / vendor 升级 / hot trend 需要快速 fold-in

**插入 SOP**：

1. **不开新 release tracking issue** — 中途插入需求归属当前 release 的 tracking issue (e.g. #132 v0.9.2 含 #135-#139 5 P0 chain)
2. **开 sub-issue + cross-link** — 新 P0 bug 单独 issue（如 #138/#139），body 含 `Related: #132 (v0.9.2 tracking)`
3. **新 preview.N+1** — fix 进 preview chain, e.g. preview.5 → preview.6 含 #138 fix → preview.7 含 #139 fix
4. **release tracking issue 评论更新** — 每次 preview ship 评论 release issue，列入 scope creep
5. **release notes narrative** — 最终 release body 把 ripple effect chain 说清楚（v0.9.2 release body 5 P0 chain narrative 是范本）

**v0.9.2 实战案例**（中途插入 4 次）：

| Preview | 触发 | 插入需求 |
|---------|------|----------|
| 0-3 | 原计划 | #133 runtime-first wizard + #129+#132 Tier 1 retry + #135 Node v24 wrap |
| 4 | Vincent macOS catch | **+#136 setRawMode tmux pane** |
| 5 | Vincent macOS catch | **+#137 wizard inquirer/readline stdin** |
| 6 | Vincent macOS catch | **+#138 launchAgent parent exit race** |
| 7 | Vincent macOS catch | **+#139 5 async dispatch missing await** |

→ 5 P0 都是 preview chain 中途插入, 不延后到 v0.9.3. 单次 release 7 preview iterations, 这是**正常 AI-Native pace**。

**什么时候 NOT 插入** (defer 到下一版本):
- 非紧急 feature request — 用户 ask 但不 block 当前用户
- RFC-level 战略改动 — 应该 v0.10.0 设计而不是 v0.9.X 临时塞
- 工程量超 50% 当前版本剩余 scope — 拖延 ship 影响整体节奏

**Lead 判断**：通信龙 / Vincent 联合决定插不插，default 倾向于"P0 必插, 其他 defer"。



### 2.1 Preview 版本号规则

per [[feedback_preview_version_increment_rule]]：

```
2.1.15-preview.0 → preview.1 → preview.2 → ... → preview.N
                                                       ↓
                                                    promote latest 时
                                                       ↓
                                                 2.1.15 (clean, no -preview.N)
```

**重要**：promote latest 必须 drop `-preview.N` 后缀（per [[feedback_clean_version_for_latest_ship]]）。`npm view dist-tags` 显示 `latest: '2.1.15-preview.7'` 视觉上仍像 preview，用户视角不专业。

### 2.2 Method B SOP（两阶段 publish）

per [[feedback_npm_publish_two_phase]]：

```bash
# Phase 1 — preview tag verify
npm version 2.1.15 --no-git-tag-version
npm publish --tag preview              # 先 preview, tarball 200 verify
curl -sI <tarball-url> | head -1       # 必 HTTP/2 200
npm view <pkg>@2.1.15 dist.tarball     # 复 verify

# Phase 2 — dist-tag add latest
npm dist-tag add <pkg>@2.1.15 latest
npm view <pkg> dist-tags               # 验证 latest 切到 clean version
```

**反模式**：直接 `npm publish --tag latest` — 跟 v0.9.0 agent-node 2.3.6 split-brain 同根因。

### 2.3 PAT scope quirk

per [[feedback_pat_label_scope]]：

- `gh issue create --label "bug,P0"` 走 GraphQL createIssue mutation 要求 labels:write scope → 403
- 拆两步：`gh issue create`（200）+ `gh issue edit --add-label bug --add-label P0`（200）
- 不让 403 误以为 PAT 完全失效（per [[feedback_verify_pat_403_self_repro]]）

### 2.4 GitHub Release

```bash
gh release create v0.9.2 \
  --repo sleep2agi/agent-network \
  --title "v0.9.2 — concurrency + UX hotfix" \
  --notes-file /tmp/v092-notes.md      # 含 EN + ZH 双语
```

ZH 翻译要点：
- 保留代码名、commit SHA、issue 链接英文
- 术语对照：preview iterations → preview 迭代 / ripple effect → 副作用族 / TTY foreground group → TTY 前台进程组

### 2.4.1 发版规范 (Release Notes Format Spec)

> v0.9.0 / v0.9.1 是 canonical 范本，v0.9.2 first ship 因不符合此规范被 Vincent catch（5263+5265），refactor 后才合格。

**强制 section 顺序** (release body markdown 结构):

```markdown
## v0.X.Y — <theme phrase, 必跟 release name 一致>

<1-line 摘要，描述本 release 的整体定位 / theme>

### 🎯 Theme: <短主题>

<2-3 行展开 theme>

### Fixes / New features

- **[#<issue> P0]** <fix headline> (`<commit-sha>`)
  - 1-2 行 root cause 简述（详细 root cause 移到 commit message 或 issue 评论 link）
  - **Why prior preview didn't catch this**：1 行说明
  - 链接到 detailed analysis: `[→ #<issue> 评论](<url>)` ← 模板占位,写的时候换成真 URL

### Dashboard polish (#116 R<start>-R<end>)

<列重要 visible 改动 1 行 each，不超 10 项>

- R275-R281: 7 轮 SMIL/chip-row/panel 减法 (75% canvas motion reduction)
- R287: sleep2agi crescent logo integrated in title block
- ...

### Docs

<docs sweep 1-2 行 summary，复杂改动 link issue>

### Breaking changes / Migration

<⚠ 用户必看的行为改变 / 迁移指引>

### Released versions (npm `latest` tag)

- `@sleep2agi/agent-network@<ver>`
- `@sleep2agi/agent-node@<ver>`
- `@sleep2agi/commhub-server@<ver>` (unchanged if no bump)
- `@sleep2agi/agent-network-dashboard@<ver>` (unchanged if no bump)

### Upgrade

\`\`\`bash
# Channel-aware multi-package upgrade
anet upgrade

# Or via the published upgrade script
curl -fsSL https://anet.sh/upgrade.sh | bash
\`\`\`

After upgrading, restart any running nodes:

\`\`\`bash
anet project restart   # cwd-wide, see #117
\`\`\`

### Known follow-ups

<v0.X+1 排期 / queued issues>

---

## 中文版本 — v0.X.Y — <theme 翻译>

<整体重译，跟 EN section 结构一一对应，**保留** commit SHA + issue 链接 + 代码名英文>
```

**Pre-publish 强制 checklist** (gh release edit 前必跑):

| 项 | 校验方式 | v0.9.2 lesson |
|----|---------|---------------|
| 1. Title 一致 | release name == body H2 | first ship "Fan-out resilience + runtime UX hotfix" vs name "concurrency + UX hotfix" 不一致 |
| 2. Clean version | body 不出现 `-preview.N` 作版本号 (历史叙事允许) | first ship 含 `2.1.15-preview.7` (Vincent 5234 catch) |
| 3. "Released versions" block 存在 | grep `npm \`latest\` tag` | first ship 缺 |
| 4. "Upgrade" section 存在 | grep `anet upgrade` + `anet project restart` | first ship 缺 |
| 5. Dashboard polish 列入 | 当 release 含 dashboard 改动时 | v0.9.0 列 R47-R59, v0.9.2 first ship 漏列 R275-R281 |
| 6. ZH section 存在 | grep `## 中文版本` | per Vincent 5232 双语强制 |
| 7. ZH 段 section 跟 EN 对齐 | section count + heading match | translation 不能只覆盖 fixes 漏掉 upgrade / packages |
| 8. Issue cross-link | 每个 fix #issue + commit SHA | already standard |
| 9. EN body H2 title 跟 ZH H2 title 一致 | `v0.X.Y — <theme>` + `v0.X.Y — <中文 theme>` | 对应 翻译 |
| 10. Final preview render | `gh release view v0.X.Y --json body --jq .body \| head -30` lookable | manual eyeball 5min |

**反模式** (v0.9.2 first ship 教训):

- ❌ 把所有 root cause 技术细节塞 release body — user 不需要看 50 行 fa08eb4 wrap process-lifecycle race
  - ✅ 1 行 summary + link 到 #132 评论 / commit message
- ❌ Body H2 title 跟 release name 不一致 — user 看 GitHub release card title 是 release name, 进去看是 body H2, 两个不一样很奇怪
  - ✅ `gh release create --title "<X>"` 跟 body 第一行 `## <X>` 必须文字完全一致
- ❌ 漏 Upgrade section — user 看完不知道怎么升级
  - ✅ 任何 release 必含 `anet upgrade` + curl 一行 + `anet project restart`

**Canonical 范本**:
- [v0.9.0 release](https://github.com/sleep2agi/agent-network/releases/tag/v0.9.0) — major (Recovery & Observability)
- [v0.9.1 release](https://github.com/sleep2agi/agent-network/releases/tag/v0.9.1) — hotfix (intern-s2-preview tool-calling)
- [v0.9.2 release](https://github.com/sleep2agi/agent-network/releases/tag/v0.9.2) — refactored hotfix (concurrency + UX)

### 2.4.2 发版 SOP (Release Ops Workflow)

> 完整 release 走 7 步, 任何一步 fail 都不能 ship。

```
Step 1: pre-release readiness
  ├─ 5-gate verify (npm dist-tags / git log / issue评论 / pane / commhub status)
  ├─ Docker + pexpect real-TTY smoke 全 PASS (§3.2 + §3.3 chain-test)
  └─ 测试马 explicit PASS verdict posted to release tracking issue

Step 2: Vincent A signal
  ├─ telegram surface 状态给 Vincent
  ├─ Vincent explicit "GO" or 等他 silent ≥ 30min default-dispatch
  └─ Sessions / Twitter screenshot 等 micro 决策跟 promote chain 解耦

Step 3: Phase 1 — npm 2-phase publish (§2.2 Method B)
  ├─ version bump: -preview.N → clean version (§2.1 强制 drop suffix)
  ├─ npm publish --tag preview (tarball 200 verify)
  └─ npm dist-tag add latest

Step 4: Phase 2 — GitHub release
  ├─ /tmp/v0.X.Y-notes.md 跟 §2.4.1 规范 format (10 checklist 全过)
  ├─ EN body + 中文版本 双语
  ├─ gh release create (--draft 否, --prerelease 否, stable published)
  └─ 关 release tracking issue + post addendum

Step 5: docs swap (§2.5)
  ├─ PINNED_*_VERSION 全更新
  ├─ CHANGELOG.md v0.X.Y entry
  ├─ README v0.X-1 → v0.X banner
  ├─ anet.sh version switcher entry
  └─ ZH+EN parity

Step 6: Vercel deploy (§2.6)
  ├─ npm run build (本地 prebuilt)
  └─ vercel deploy --prebuilt --prod

Step 7: post-promote
  ├─ 测试马 latest install smoke verify (real-world `npm i -g`)
  ├─ Vincent macOS retest verify (实战 ground-truth probe via commhub register)
  └─ 通信龙 single telegram surface "all done" (per [[feedback_proactive_eta_alert]])
```

**单次 release ETA 累积数据** (per [[feedback_npm_publish_two_phase]] + [[project_release_ops_owner]]):

| Release | Step 3-4 ETA forecast | 实际 | 备注 |
|---------|---------------------|------|------|
| v0.9.0 | 10min | ~15min | 含 2.3.6 tarball 404 ship-stopper |
| v0.9.1 | 6min | ~6min | clean |
| v0.9.2 first | 8min | 5min | Method B muscle memory |
| v0.9.2 clean re-publish | 10-15min | 6min | drop -preview.N suffix |

**Method B SOP** 跨 3 release ops 成熟。工程马 release ops master per [[project_release_ops_owner]]。

### 2.5 docs Preview→Stable swap

per [[feedback_pinned_version_sop]]：

- `PINNED_AGENT_NETWORK_VERSION` → 新 clean version
- `PINNED_AGENT_NODE_VERSION` → 新 clean version
- CHANGELOG.md 新 entry
- anet.sh version switcher 新 entry
- ZH+EN parity（per [[feedback_docs_zh_en_parity]]）

### 2.6 Vercel Deploy

per [[feedback_vercel_deploy]] + [[feedback_vercel_batch_deploy]]：

```bash
cd docs-site
npm run build                          # 本地 build, 不在 Vercel build
vercel deploy --prebuilt --prod        # prebuilt 强制
```

docs-loop 每 10 轮才 deploy 一次（节流成本）。

---

## 3. Verify-First SOP

> **核心原则**：派 owner 阻塞 ship 直到 5 件 verifiable artifacts 全绿。
>
> **Evidence provenance gate (常设, 07-29 P3-A 事故固化)**：任何 Docker E2E / preview smoke / 安全 gate / release promote 的证据, 都必须携带一份 provenance manifest (clean checkout SHA + tree oid + tarball SHA256 + flag grep 证据 + 独立 reviewer 复跑 + 至少 2 项 gate mutation), 否则整包 evidence **INVALID**, 不得 GO。作者自报的 report 不构成独立证据。权威模板与 checklist 见 [`../tests/release-gate-playbook.md`](../tests/release-gate-playbook.md) §9。

### 3.1 五件 artifacts

1. **npm dist-tags** — `npm view <pkg> dist-tags` 显示期望版本
2. **git log** — `git fetch origin main && git log` 显示 expected commit
3. **issue 评论** — issue body / 评论 显示 owner 已 post 进度 + verdict
4. **commhub status** — `commhub_get_all_status` owner explicit ack
5. **pane** — `tmux capture-pane` 最后手段（second-class data per [[feedback_pane_vs_commhub_truth]]）

### 3.2 Docker + pexpect real-TTY smoke

per [[feedback_docker_smoke_real_tty]] + [[feedback_docker_smoke_gate_before_ship]]：

任何 CLI npm publish 前必走：

```bash
docker run --rm -t node:24-alpine sh -c "
  apk add --no-cache bash python3 py3-pip
  pip install pexpect --break-system-packages
  npm install -g <pkg>@<ver> --force
  
  # Case 1: expect non-interactive baseline
  echo -e 'alias\nclaude-code-cli\nn' | timeout 30 anet create
  
  # Case 2: pexpect real-TTY drive (catch stdin ref state mismatch)
  python3 << 'PEXP'
import pexpect
p = pexpect.spawn('anet create', encoding='utf-8')
p.expect('Node name:'); p.sendline('test')
# ... full wizard ...
PEXP
  
  # Case 6 — chain-test (NEW SOP from v0.9.2)
  # create → ls 验证 dispatch chain await 正确
"
```

### 3.3 Chain-test SOP

v0.9.2 #139 root cause = 5 个 async dispatch 缺 await，单 command isolated smoke 永远 catch 不到。

**规则**：smoke 必须含 ≥1 个 chain test（连续多 command 用户自然 flow），否则不 ship latest。

### 3.4 Ground-truth probe via commhub

per [[feedback_pane_vs_commhub_truth]]：

- Vincent macOS 节点 `register_at` to commhub = implicit verification signal（比 telegram ack 更直接）
- pane capture 是 second-class data — lead 怀疑 owner stuck 时验证顺序：
  1. `commhub_get_all_status`（truth）
  2. `gh issue view`（issue 最新评论）
  3. `npm view dist-tags`（ship state）
  4. `tmux capture-pane`（last resort）
  5. `tmux send-keys`（极后手段，谨慎用 `C-c` 不是 `Escape` per [[feedback_tmux_escape_kills_claude_session]]）

---

## 4. Agent Dispatch Protocol

> **核心原则**：commhub HIGH 优先级 30s ack baseline / lead-scope autonomy 不 gate Vincent / X马 alias 内部用 user-facing 用正常名。

### 4.1 Commhub HIGH ack baseline

per [[feedback_commhub_urgent_ack_baseline]]：

收到 HIGH 优先级 commhub task 必须 30s 内 ack（"收到 + ETA"），即使在 /loop autonomous 中。"situational awareness" 不豁免 HIGH dispatch。

### 4.2 Lead-scope autonomy

per [[feedback_greater_autonomy]] + [[feedback_confirm_before_push_on_vincent_arch_decisions]]：

- lead-scope 决定（dispatch / owner / 优先级 / review）：直接定 + 推进，不 gate Vincent
- 战略级 / 不可逆 / runtime 架构改动：push 前留 confirm 窗口
- UX bug + topic switch ≥ 30min：default-dispatch 最安全可逆路径，不等 ack

### 4.3 Naming convention

per [[feedback_no_x_horse_in_user_facing]]：

- 内部 dispatch：X马 alias (通信SDK马 / 通信工程马 / N站马)
- user-facing demo / docs / RFC：normal names (Communications SDK Agent / Dashboard Engineer)

### 4.4 ETA + 30min stale alert

per [[feedback_proactive_eta_alert]]：

派单 ETA + 30min 仍 stale → 立即 telegram Vincent + reassign plan，不被动等他发现。

### 4.5 Cron polish vs P0 priority

teach-by-example v0.9.2：N站马 cron polish 自迭代抢占 commhub message processing。P0 dispatch 必须中断 cron loop（tmux send-keys `C-c` interrupt + paste P0 prompt），不让 polish queue 吞掉 P0。

---

## 5. Retro & Lessons

> **核心原则**：每次 P0 / release / 大 incident 后必写 memory lesson，下次重犯就是 lead 失责。

### 5.1 Lessons memory 结构

per `~/.claude/projects/-home-vansin-agent-orchestra/memory/`：

每个 lesson 一个文件，frontmatter:

```yaml
---
name: <kebab-case-slug>
description: <one-line summary>
metadata:
  type: feedback | user | project | reference
---
```

body 含：
- **Lesson**：what happened
- **Why**：root cause
- **How to apply**：next time SOP
- **Related**：`[[other-lesson-slug]]` cross-link

### 5.2 v0.9.2 cycle 教训沉淀（live example）

5 P0 chain (#135 → #139) 全 traced to 1 个 fa08eb4 wrap commit (preview.3) 的副作用：

| Preview | P0 | Root cause | Lesson |
|---------|----|----|----|
| .3 | [#135](https://github.com/sleep2agi/agent-network/issues/135) wizard top-level await | Node v24 strict TLA check | wrap main() fix |
| .4 | [#136](https://github.com/sleep2agi/agent-network/issues/136) setRawMode tmux | detached tmux PTY mismatch | revert default tmux |
| .5 | [#137](https://github.com/sleep2agi/agent-network/issues/137) wizard 静默退出 | @inquirer/prompts + readline stdin ref state | `feedback_docker_smoke_real_tty` |
| .6 | [#138](https://github.com/sleep2agi/agent-network/issues/138) launchAgent process group | parent exit before child claims TTY | await child before parent exit |
| .7 | [#139](https://github.com/sleep2agi/agent-network/issues/139) 5 async dispatch missing await | fa08eb4 wrap exposed dispatcher race | chain-test SOP gate |

**Meta lesson**：fa08eb4 wrap 是个 "global exit handler" 改动，未来类似改动需要 full dispatch-graph audit before ship（SDK马 reflection）。

### 5.3 Release Ops cycle 数据

v0.9.0 / v0.9.1 / v0.9.2 三次实战累积：

- v0.9.0: forecast 10min, 实际 ~15min (含 2.3.6 tarball 404 ship-stopper)
- v0.9.1: forecast 6min, 实际 ~6min
- v0.9.2 first: forecast 8min, 实际 5min (Method B muscle memory)
- v0.9.2 clean re-publish: forecast 10-15min, 实际 6min

工程马 Method B SOP 现在跨 3 release ops 成熟。

### 5.4 SOP 升级触发

任何 P0 后必反思：

1. 当前 SOP 漏在哪？
2. 新 SOP 是什么？
3. 谁来写 memory + 哪些 cross-link？

v0.9.2 直接产出 6 个 SOP 升级（real-TTY smoke / chain-test / Docker smoke gate / npm 2-phase / PAT scope / clean version）。

---

## 6. 角色与责任

| 角色 | 责任 | Tier |
|------|------|------|
| Vincent (founder) | 战略决策、scope priority、release A signal | - |
| 通信龙 (lead) | dispatch / review / verify-first push / SOP 维护 | 1 |
| 通信工程马 | release ops master、infra、PR ship | 1 |
| 通信SDK马 | RFC writing、agent-network SDK、core CLI | 1 |
| 通信测试马 | Docker + real-TTY smoke、release gate verify | 1 |
| 通信牛 | server hardening、PR review、deep audit | 1 (codex) |
| 通信文档马 | docs Preview→Stable swap、ZH+EN parity、Vercel deploy | 1 |
| 通信demo马 | demos、scaffold、quickstart | 1 |
| N站马 | dashboard polish + Twitter-ready visual | 1 |
| N站牛 | dashboard codex backup | 1 (codex) |

详见 [[project_anet_team]] + [[project_role_commhub_dragon]]。

---

## 7. 进一步阅读

- [feedback_* memory lessons](https://github.com/sleep2agi/agent-network/issues/85)（内部 40+ files）
- [Issue #85 AI-Native 研发迭代流程正式文档](https://github.com/sleep2agi/agent-network/issues/85)（本文档 tracking issue）
- [Issue #134 lead-level forecast + cost awareness](https://github.com/sleep2agi/agent-network/issues/134)（lead forecast practice）
- [team-collab-playbook.md](https://github.com/sleep2agi/agent-network/blob/main/docs/team-collab-playbook.md)（团队协作 playbook）

---

*这份 SOP 是 living doc — 每次 release / P0 / lessons 触发更新。提交方式：PR + commit msg `docs(sop): ...`。*

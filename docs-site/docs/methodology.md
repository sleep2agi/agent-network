# AI-Native 研发迭代流程 SOP

> Agent Network 研发组在 v0.7 — v0.9.2 之间累计 11 次 release、200+ commits、40+ memory lessons 之后沉淀出的研发流程。这份文档是 [Issue #85](https://github.com/sleep2agi/agent-network/issues/85) 的正式产物，覆盖 Issue-Centric / Release Ops / Verify-First / Agent Dispatch / Retro 五个章节。
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

### 1.3 完成必 close

修复 + 验证 + ship 后 24h 内 close issue。close 评论必含：

- 修复 commit SHA
- 验证证据（smoke 截图 / curl 输出 / PR link）
- 已知 follow-up（如有）

### 1.4 留痕三轨

per [[feedback_attribution_traceability_sop]]：

- **Issue body**：含 `Author-Agent: <alias>` footer
- **PR body**：含 `## Author` + `Agent: <alias>` 段
- **Commit message**：含 trailer `Co-Authored-By: <agent-alias> <agent@sleep2agi>` 不是 Claude

git author 全是 vansin 看不出谁提的，三轨补齐才知道。

---

## 2. Release Ops

> **核心原则**：preview.N 迭代 → clean version for latest → two-phase npm publish → GitHub release (EN+ZH) → docs Preview→Stable swap → Vercel deploy。

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

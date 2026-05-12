# Demo 提案：代码 PR 审查室（PR Review Room）

> 提案人：通信demo马
> 日期：2026-05-12
> 状态：**v2 — 经 通信龙 review 通过**（v1 砍 dispatcher agent / 切到 CLI 模式 / 清理流程对齐 debate）

## 一句话定位

把一段 PR diff（GitHub URL / 本地 .diff 文件 / git ref）丢进来 → 3 个并行 reviewer 从**安全 / 性能 / 风格**三个维度同步审一遍 → 终审整合三份意见，输出一份带 LGTM / Request Changes / Comment 决议的 markdown 评论，可直接贴到 GitHub。

入口：`anet demo pr-review`（CLI one-shot，跟 `anet demo debate` 同级风格）。

## 为什么是这个 demo

| 维度 | 论点 |
|------|------|
| 受众契合 | anet 目标用户 = dev / 工程师；PR review 是每天都做的事 |
| 编排模式差异 | 现有 demo 没有"**并行扇出 + barrier 合并**"模式（hello-world 对话、translation 线性、debate 回合制、telegram-squad 指挥-worker 都不算严格并行） |
| 视觉冲击 | Dashboard topology 上一个清晰漏斗：CLI → 3 reviewer → 1 judge，时间轴看 3 个 reviewer 几乎同时干活 |
| 实用价值 | 跑完输出一个**真能贴到 GitHub 的 markdown 评论**，不是玩具 |
| 速度展示 | 串行跑 3 个角度 ~3T，并行 ~T，并行加速比是 anet 卖点之一 |

## 角色（4 个 agent，approved 设计）

| 角色 alias | 职责 | 输入 | 输出 |
|------------|------|------|------|
| `reviewer-security-<suffix>` | 注入 / 凭据泄露 / 权限绕过 / SSRF / 反序列化 等安全审查 | diff + 安全审查 prompt | markdown 列表：issue + severity + 行号 |
| `reviewer-performance-<suffix>` | N+1 / O(n²) / 大对象 / 不必要 IO / 阻塞 await 等性能审查 | 同上 | 同上结构 |
| `reviewer-style-<suffix>` | 命名 / 注释 / 抽象层级 / 死代码 / 可读性审查 | 同上 | 同上结构 |
| `judge-<suffix>` | barrier 等三份 reply 到齐 → 去重整合 → 排序 → 判 LGTM / Request Changes / Comment | 3 份 markdown | 最终 PR review markdown |

**dispatcher 不做独立 agent**（v1 评审砍掉）：CLI 进程直接广播 task 给 3 个 reviewer，省一次 LLM 调用，topology 漏斗仍清晰。`judge` 保留为独立 agent，因为 barrier 合并 + 去重 + 最终判决是有 LLM 推理价值的工作。

并行点：CLI 一次性 fan-out 派 3 个 task；judge 等三份 reply 都到再启动（CLI 侧 barrier）。

## 编排时序

```
T0  CLI 拿到 diff（gh api / 本地文件 / git diff <ref>）
    ├─→ T1 task to reviewer-security
    ├─→ T1 task to reviewer-performance
    └─→ T1 task to reviewer-style
T2  3 reviewer 并行跑（典型 30-90s 各自完成）
T3  CLI barrier 收齐 3 份 reply → 打包派给 judge
T4  judge 整合 → 最终 markdown
T5  写入 ./pr-review-<short-id>-<ts>.md
T6  cascade 清理 4 agent + 独立 network（除非 --keep）
```

## CLI 接口（approved，对齐 `anet demo debate`）

```bash
anet demo pr-review [--pr <github-url> | --diff <file> | --ref <git-ref>] \
                    [--key <minimax-key>] [--out <path>] \
                    [--keep] [--step-timeout <s>] [--suffix <s>] \
                    [--no-network | --network <id>]
```

| Flag | 默认 | 说明 |
|------|------|------|
| `--pr <url>` | — | GitHub PR URL，CLI 用 `gh api` 拉 `.diff` |
| `--diff <path>` | — | 本地 .diff / .patch 文件 |
| `--ref <ref>` | — | `git diff <ref>..HEAD` 自动拿当前 branch 的 patch |
| `--key <key>` | `$MINIMAX_KEY` | MiniMax API Key |
| `--out <path>` | `./pr-review-<id>-<ts>.md` | 评审输出路径 |
| `--keep` | false | 保留 4 agent + network（debug 用） |
| `--step-timeout <s>` | 180 | 单 reviewer/judge 超时秒数 |
| `--suffix <s>` | 随机 4 hex | alias 后缀 |
| `--no-network` | false | 跑在当前/default network 内 |
| `--network <id>` | — | 指定已有 network |

三种 diff 入口至少需要一种；都不给时进入交互模式问 `--pr`。

## 输入输出契约

**输入：** 任选一种
1. `--pr https://github.com/sleep2agi/agent-network/pull/24`
2. `--diff path/to/local.diff`
3. `--ref main`（→ `git diff main..HEAD`）

**输出：** markdown 文件 `./pr-review-<short-id>-<ts>.md`，结构：

```markdown
# PR Review: <pr title 或 ref>

**决议：** LGTM / Request Changes / Comment
**统计：** 安全 N1 处 / 性能 N2 处 / 风格 N3 处

## 安全
- [严重] L42 user_input 直接拼 SQL ...

## 性能
- [中] L88 for 循环里查 DB ...

## 风格
- [低] L12 命名 `tmp` 含义不清 ...

## 终审说明
<judge 判决理由 + 阻塞项标注>
```

## 与 debate demo 的结构对比

| 维度 | debate | pr-review |
|------|--------|----------|
| 编排范式 | 回合制 + 顺序驱动（9 步串行） | 单轮 fan-out + barrier + merge（3 步） |
| Agent 数量 | 6 | 4 |
| 输入 | `--topic <议题>` | `--pr / --diff / --ref` 三选一 |
| 输出 | markdown 实录 | markdown PR review 评论 |
| Network | 独立 `debate-<suffix>` + 自动清理 | 独立 `pr-review-<suffix>` + 自动清理 |
| 模型 | MiniMax M-* | 同 MiniMax，v1 |

两种模式覆盖 anet 编排能力的两个端点：复杂回合制 vs 简单并行流水。

## 实现 outline

跟 `demoDebateCommand`（`agent-network/bin/cli.ts:3592`）1:1 复制模板：

```
agent-network/bin/cli.ts
  + demoPrReviewCommand()        — 主入口（参考 demoDebateCommand）
  + buildPrReviewPrompts()       — 4 份 prompt 模板（security / performance / style / judge）
  + fetchPrDiff(opts)            — gh api / 文件读取 / git ref 三种 diff 来源
```

prompts 内联在 cli.ts 还是 split 到独立文件？跟 debate 一致 — 内联在 `cli.ts` 里，prompts 集中在函数顶部常量。

模型默认 MiniMax（跟 debate 一致），未来 docs/multi-model 加一节"reviewer 换 Claude / GLM 对比效果"。

## 验证方式（对标 cases/index.md 标准）

| 层级 | 验证 |
|------|------|
| 资产 | `agent-network/bin/cli.ts` 加 `demo pr-review` 子命令 |
| 自动化 | 新增 `tests/test28-pr-review-room/` — Docker 起 hub + 4 agent，喂 sample diff，验证输出文件 + judge 决议字段 |
| 文档 | `docs-site/docs/cases/pr-review-room.md`（ZH + EN）+ 加入 `cases/index.md` 表格 |
| samples | `tests/test28-pr-review-room/samples/good-pr.diff` + `bad-pr.diff` 各一份 |

## Diff 大小处理（risk 收口）

| 大小 | 行为 |
|------|------|
| ≤ 5 KB | 完整 diff 派 3 reviewer |
| 5 KB — 30 KB | 按文件切片，每个 reviewer 拿全 diff 但 prompt 提示只看自己维度 |
| > 30 KB | CLI 提示用户用 `gh api -X GET 'repos/.../files'` 选关键文件，v1 暂不自动切（v2 加 file fan-out） |

## 不在范围内（v1）

- 不直接 push 评论到 GitHub PR（输出 markdown，用户手动贴或自己 `gh pr comment -F file.md`）— 避免误操作
- 不做 autofix（只输出审查意见，不改代码）
- 不做多轮迭代（v1 = 单轮 fan-out → barrier → merge）
- 不做大 diff 自动文件切分（> 30 KB 提示用户筛选）

## 风险 / 待定

- **MiniMax 上下文窗口**：大 PR diff 可能超 token；5KB / 30KB 分级见上
- **并行启动延迟**：3 SDK runtime 同时 cold start 是否会挤；test28 实测
- **judge 偏置**：3 份 reviewer 输出格式不一致时怎么去重？v1 用 prompt 强制 reviewer 统一 markdown 结构，judge 按 `(file:line)` 二元组去重
- **未支持 fork PR**：v1 `--pr` 只接同仓 PR，跨 fork diff 需要 `gh api` 处理 token / 权限，v2 再加

## Timeline（通信龙 review 给的节奏）

1. **现在**：开 issue `[demo] PR 审查室 — 并行扇出 + barrier 合并` 跟踪
2. **现在**：worktree `~/anet-work/demo-pr-review-room/` + 分支 `feat/demo-pr-review-room`，把本提案 push 上去开 draft PR（refs issue）
3. **等**：Vincent merge 完当前 5 个 open PR (#19/#20/#21/#23/#24)，再开始**实施 4 agent + CLI 代码**
4. **实施 PR**：closes 上面的 demo issue，含 `demoPrReviewCommand` + `tests/test28-pr-review-room/` + `docs-site/docs/cases/pr-review-room.md`（ZH + EN）

---

**后续 demo backlog（通信龙 列）：**

- ✅ 本提案：PR 审查室（4 agent 1→3→1）
- AI 新闻编辑室（6 agent 编辑-采编-审核-排版）
- 产品速会 standup（5 agent 主持人-3 报告人-记录）

按 dev 兴趣度 / 视觉对比丰富度排顺序，本提案优先。

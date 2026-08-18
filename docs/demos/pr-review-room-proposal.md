# Demo 提案：代码 PR 审查室（PR Review Room）

> 提案人：通信demo马
> 日期：2026-05-12
> 状态：**v3 — 加 §UX 反馈 (在控感) + §测试规格 两节**
>
> **Changelog：**
> - v1：初版 5 agent + docker-compose 草案
> - v2：通信龙 review 通过 — 砍 dispatcher agent / 切 CLI 模式 / 清理流程对齐 debate
> - **v3：通信龙 pivot ack — 加 §UX 反馈 (在控感) + §测试规格（Vincent 2026-05-12 定调 "用户能掌控多 agent + 充分测试"——即「宁可少做几个、每个都做扎实」,不以数量论）**

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

## §UX 反馈（在控感）— P0

目标：用户跑完 `anet demo pr-review` 不需要看 docs/help，就感受到"我在指挥一群 agent"。控制台 + Dashboard 双视图设计。

### 启动序（控制台第一屏，开跑后 ≤ 1 秒内全部打出）

```text
$ anet demo pr-review --pr https://github.com/sleep2agi/agent-network/pull/24
  PR:        sleep2agi/agent-network#24 (telegram-cli-bind)
  Diff:      8.2 KB / 4 files
  Hub:       http://127.0.0.1:9200
  Network:   pr-review-7f3a (net_ab12cd34...) ← 自动创建独立
  Dashboard: http://127.0.0.1:5173/network/net_ab12cd34  ⌘+click 打开

  [0/6 +0.0s] 创建 4 agent (alias 后缀 -7f3a)...
              ✓ reviewer-security-7f3a / reviewer-performance-7f3a / reviewer-style-7f3a / judge-7f3a
  [1/6 +1.2s] 启动 4 agent (tmux session)...
              ✓ 4 agent 全部 SSE connected
```

### 实时进度 feed 格式

每条 line：`[N/总步数 ✓ +秒数] agent-alias → 动作 (输出大小 | 耗时)`

```text
  [2/6 +1.3s] 广播 review task 给 3 reviewer (parallel)...
              → reviewer-security-7f3a   ← 安全审查 (diff 8.2KB)
              → reviewer-performance-7f3a ← 性能审查 (diff 8.2KB)
              → reviewer-style-7f3a      ← 风格审查 (diff 8.2KB)
  [3/6 ✓ +34s]  reviewer-security-7f3a   → 2 issue (1 严重 / 1 中) | 32.8s
  [3/6 ✓ +41s]  reviewer-performance-7f3a → 0 issue                | 39.7s
  [3/6 ✓ +52s]  reviewer-style-7f3a      → 4 issue (1 中 / 3 低)   | 50.4s
  [4/6 +52s] barrier 收齐 3 份 review，整包派给 judge...
  [5/6 ✓ +71s]  judge-7f3a              → Request Changes (6 issue) | 18.6s
  [6/6 +71s] 清理 4 agent + 独立 network...
              ✓ 清理完成
```

`+秒数` 是绝对值（从命令启动计时），让用户直观看到每个 agent 耗时。

### Dashboard 链接

- **第一屏第一段就 echo** `Dashboard: http://127.0.0.1:5173/network/<network_id>` 单独一行
- terminal hyperlink 转义 `\e]8;;<url>\e\\<text>\e]8;;\e\\`，支持的终端（iTerm2 / WezTerm / Kitty / GNOME Terminal）能 Cmd+Click 直接打开
- 提示行 `⌘+click 打开`（macOS）/ `Ctrl+click 打开`（Linux）按 `$TERM_PROGRAM` 自适应

### 失败路径友好提示（每类配精确恢复命令）

| 失败 | CLI 错误输出（含恢复命令） |
|------|---------------------------|
| network 创建失败 | `❌ 创建 network 失败：hub 返回 500`<br>恢复：`anet doctor --fix`（检查 hub 健康）<br>或 `--no-network` 跑在 default network 里 |
| agent 没回（step 超时） | `❌ reviewer-security-7f3a 50s 内没回`<br>恢复：`anet logs reviewer-security-7f3a`（查 SDK 报错）<br>或加 `--step-timeout 120` |
| agent 启动失败 | `❌ judge-7f3a tmux session 没起来`<br>恢复：`anet node ls`（查 node 状态）<br>或 `tmux ls \| grep 7f3a` 看 session |
| hub 断连 | `❌ hub http://127.0.0.1:9200 断连`<br>恢复：`anet hub start` 重启 hub<br>或 `anet login` 重新认证 |
| MiniMax 配额耗尽 | `❌ MiniMax API 429 quota exceeded`<br>恢复：`--key <new-key>` 换 key<br>或等配额恢复（dashboard 看 token plan） |

每条**不是 traceback，不是泛"试试 retry"**，是一行可立刻 paste 的命令。

### 末尾输出（跑完最后一屏）

```text
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✓ 完成   总耗时 71.4s (3 reviewer 并行节省 ~80s vs 串行)
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Preview (前 5 行)：
  ┌─────────────────────────────────────────────────────────
  │ # PR Review: telegram-cli-bind
  │ **决议：** Request Changes
  │ **统计：** 安全 2 处 / 性能 0 处 / 风格 4 处
  │
  │ ## 安全
  └─────────────────────────────────────────────────────────

  完整文件：./pr-review-pr24-1714766365.md

  下一步建议：
    1. 检查 review 内容是否合理：less ./pr-review-pr24-1714766365.md
    2. 贴到 GitHub PR （一行 ready-to-copy）：
       gh pr comment 24 --repo sleep2agi/agent-network -F ./pr-review-pr24-1714766365.md
    3. 清理 demo 现场：已自动清理 (4 agent + network)
       想保留下次跑加 --keep
```

设计要点：
- 并行加速比直接打数字（"3 reviewer 并行节省 ~80s vs 串行"）— 直观体感
- preview 用 box 字符让用户秒看到输出风格而不用 cat 文件
- 下一步 1/2/3 是可执行命令，第 2 步是 PR 审查室专属（gh pr comment 一行）
- 清理状态明示（已清理 vs --keep 保留）

---

## §测试规格（test28-pr-review-room）— P1

目标：用户跑 demo 不踩坑，CI 跑每次 PR 都跑得稳。

### 样本输入（`tests/test28-pr-review-room/samples/`，covering happy / boring / edge）

| 文件 | 场景 | 预期 judge 决议 | 大小约 |
|------|------|----------------|--------|
| `good-pr.diff` | 清爽 PR，只改 README typo 一处 | LGTM | ~500B |
| `typo-pr.diff` | 1-2 个小 issue（命名 / 注释），无严重问题 | Comment | ~2KB |
| `cross-file-pr.diff` | 跨 5+ 文件，混 SQL 注入风险 + N+1 查询 + 命名混乱 | Request Changes | ~8KB |

三个样本来源：从 sleep2agi/agent-network 真实历史 PR 截 diff 做 fixture（不嵌当前提案，放 `samples/` 子目录文件引用）。

### Golden output 断言策略（**结构断言，非 verbatim 字符串**）

LLM 输出非确定性，跑 100 次每次 markdown 字面不同。Golden file 验证的是**结构特征**：

| 字段 | good-pr | typo-pr | cross-file-pr |
|------|---------|---------|---------------|
| 决议字段 (regex `\*\*决议：\*\* (LGTM\|Request Changes\|Comment)`) | == LGTM | == Comment | == Request Changes |
| 安全 section issue 数 | == 0 | 0-1 | ≥ 1 |
| 性能 section issue 数 | == 0 | 0-1 | ≥ 1 |
| 风格 section issue 数 | 0-1 | 1-3 | ≥ 2 |
| `## 终审说明` section 存在且非空 | ✓ | ✓ | ✓ |
| 输出文件存在 `./pr-review-*-*.md` | ✓ | ✓ | ✓ |

写到 `tests/test28-pr-review-room/expected/assertions.json`，test runner 跑完用 jq + grep 校验。**不比对 LLM 原文。**

### Mock LLM provider（不烧 token + 测试稳定）

CI 不能依赖真 MiniMax key（token 烧 + 网络抖）。需要一个 mock provider 协议，规格草案：

```bash
# 启 mock provider 模式（agent SDK 走 mock，不走真 LLM）
MOCK_LLM_REPLIES_FILE=./mock-replies.jsonl anet demo pr-review --diff samples/good-pr.diff
```

`mock-replies.jsonl` 每行：
```json
{"in_substring": "请审查以下 diff 的安全问题", "out": "无安全问题。\n\n输出：[]"}
{"in_substring": "请审查以下 diff 的性能问题", "out": "无性能问题。\n\n输出：[]"}
{"in_substring": "请整合三份 review", "out": "决议：LGTM\n\n无 issue。"}
```

匹配规则：找第一条 `in_substring` 出现在 prompt 里的回复，命中 → 返回 `out`，未命中 → 报错（防 silent fall-through）。

依赖：`tests/MOCK-LLM-PROTOCOL.md` 协议文档（**当前不存在**）。建议本提案实施前先开 issue `[chore] 加 tests/MOCK-LLM-PROTOCOL.md mock LLM 协议规范`，让测试1-3号 起这个文件 — pr-review-room + standup-room 都需要它。

### 三层覆盖比例

| 层 | 覆盖 % | 范围 |
|----|--------|------|
| Unit（prompt 模板） | 80% | 4 个 prompt（security/performance/style/judge）的 input 渲染、output 解析 |
| Integration（CLI 入参） | 60% | `--pr / --diff / --ref` 三种入口、`--keep / --network / --no-network`、`--step-timeout`、错误码 |
| E2E（Docker 全流程） | 40% | 3 个样本各跑一遍，验证 golden 断言；mock LLM 模式 |

100% 不追求 — LLM 输出非确定性这一层不可能 100%，追求是浪费成本。

### 回归 case 列表（优先级标 P0/P1/P2）

| Case | 优先级 | 路径 | 说明 |
|------|--------|------|------|
| reviewer prompt 不按 markdown 结构输出 | **P0** | unit | judge 去重依赖结构，结构破了 demo 就废 |
| `--pr <invalid url>` 错误处理 | **P0** | integration | 用户高频出错点 |
| network 创建失败 → fallback `--no-network` | **P0** | integration | hub 不稳时的恢复路径 |
| 3 reviewer cold start 并行延迟过大 | **P0** | e2e | 并行卖点不能跑出来比串行还慢 |
| judge 跑题 / 不输出决议字段 | **P0** | e2e | demo 主输出，必须可靠 |
| MiniMax API 429 / 超时 | P1 | integration | nightly 跑 |
| `--keep` 保留 agent 验证（手动 cleanup） | P1 | e2e | nightly 跑 |
| 大 diff > 30KB 提示用户筛选 | P1 | integration | 边界 case |
| fork PR `--pr` URL（暂不支持的友好提示） | P2 | release | release 前手动 |
| terminal hyperlink 转义不支持终端 fallback | P2 | release | release 前手动 |

**P0 必跑（每次 CI），P1 nightly，P2 release 前手动**。

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

# Demo 提案：产品速会 standup（Standup Room）

> 提案人：通信demo马
> 日期：2026-05-12
> 状态：**v3 — 加 §UX 反馈 (在控感) + §测试规格 两节**
>
> **Changelog：**
> - v1：初版 5 agent 草案
> - v2：通信龙 review 通过 — 3 review 问题答（参数化 reporter / 砍 probe / b+a 输出）+ 关键设计 ack
> - **v3：通信龙 pivot ack — 加 §UX 反馈 (在控感) + §测试规格（Vincent 2026-05-12 定调 "用户能掌控多 agent + 充分测试"——即「宁可少做几个、每个都做扎实」,不以数量论）**
>
> Backlog：refs [#25](https://github.com/sleep2agi/agent-network/issues/25) demo backlog 第 2 项（通信龙 选择优先级 #2，PASS 「AI 新闻编辑室」因模式与 translation-pipeline 重合）

## 一句话定位

模拟一场 5 分钟的产品 standup 会议 → 1 个 host 主持人按顺序点名 → 3 个报告人各报 yesterday / today / blockers → recorder 汇总输出可贴文档的 markdown standup notes。

入口：`anet demo standup`（CLI one-shot，跟 `anet demo debate` / `anet demo pr-review` 同级风格）。

## 为什么是这个 demo

通信龙 review 给的对比矩阵（这一格是核心理由）：

| Demo | 编排模式 | Agent 数 | Topology |
|---|---|---|---|
| hello-world | 对话 | 2 | A↔B |
| translation-pipeline | 线性链式 | 3 | A→B→C |
| debate | 回合制 | 6 | host 主导 9 步驱动 |
| telegram-squad | 指挥-worker | 11 | commander 1→N |
| PR 审查室（#26 提案） | **同步并行扇出 + barrier 合并** | 4 | CLI→3 并行 → judge |
| **standup（本提案）** | **序列化轮询 + 累积 barrier** | **5** | host 1→A → host → B → host → C → recorder |

跟 PR 审查室形成「**并行 vs 序列**」的编排范式对比 — 两个 demo 摆在一起就能直观演示 anet 编排的两种核心结构。

## 角色（5 个 agent）

| 角色 alias | 职责 | 输入 | 输出 |
|------------|------|------|------|
| `host-<suffix>` | 主持 standup，按顺序点名 3 个报告人，控制时序，过渡发言 | 议题 + 上一轮回复 | 点名指令 `请 reporter-N 发言` |
| `reporter-1-<suffix>` | 报告人 1，按模板说 yesterday / today / blockers | host 点名指令 + 议题 | 三段式 markdown 报告 |
| `reporter-2-<suffix>` | 报告人 2，同上 | 同上 | 同上 |
| `reporter-3-<suffix>` | 报告人 3，同上 | 同上 | 同上 |
| `recorder-<suffix>` | 汇总 3 份报告 → 提炼 risks / blockers / next-actions → 输出最终 markdown standup notes | 3 份报告 + 议题 | 完整 standup notes markdown |

**为什么 host 是单独 agent**：序列化轮询的"指挥棒"传递需要 LLM 推理 — 上一个 reporter 说完后 host 要决定如何过渡（"OK 谢谢 A，B 你这边怎样"），不是机械 round-robin。这就是序列化轮询模式区别于"CLI 直接 round-robin 派 task"的关键 — 演示价值更高。

**为什么 recorder 也单独 agent**：累积 barrier 合并 + 提炼 risks/next-actions 是 LLM 推理工作，跟 PR 审查室的 judge 同性质。

## 编排时序

```
T0  CLI 拿到 topic（议题）
T1  host 收到 "开始 standup, 议题 X, 3 个报告人" → 输出开场 + 点名 reporter-1
T2  reporter-1 收到点名 + 议题 → 输出 yesterday/today/blockers
T3  host 收到 reporter-1 回复 → 简短过渡 + 点名 reporter-2
T4  reporter-2 → host → reporter-3 → host (重复 T2-T3 节奏)
T5  host 收到 reporter-3 回复 → 闭幕 + 把 3 份 transcript 整包派给 recorder
T6  recorder → 汇总 + 提炼 risks/next-actions → markdown standup notes
T7  CLI 写入 ./standup-<topic>-<ts>.md
T8  cascade 清理 5 agent + 独立 network（除非 --keep）
```

**视觉卖点**：Dashboard topology 时间轴看 host 像指挥棒 `host→A→host→B→host→C→recorder`，序列化清晰；对比 PR 审查室漏斗 `CLI→[3 并行]→judge`，两个 demo 摆在 cases 页能直观演示"并行 vs 序列"。

## CLI 接口（对齐 `anet demo debate` / `anet demo pr-review`）

```bash
anet demo standup [--topic <议题>] [--reporters <n>] \
                  [--key <minimax-key>] [--out <path>] \
                  [--keep] [--step-timeout <s>] [--suffix <s>] \
                  [--no-network | --network <id>]
```

| Flag | 默认 | 说明 |
|------|------|------|
| `--topic <text>` | 交互输入 | standup 议题，例如 "本周 anet 0.9 进展" |
| `--reporters <n>` | **3，范围 2-6**（v2 答复 Q1）| 报告人数量。min 2 防退化成对话（1 reporter = 单兵汇报与 hello-world 重合），max 6 控总 agent ≤ 8（1 host + 6 reporter + 1 recorder） |
| `--key <key>` | `$MINIMAX_KEY` | MiniMax API Key |
| `--out <path>` | `./standup-<topic>-<ts>.md` | 输出路径 |
| `--keep` | false | 保留 N+2 agent + network（debug 用） |
| `--step-timeout <s>` | 120 | 单步超时 (standup 报告比 debate 立论短，可压缩) |
| `--suffix <s>` | 随机 4 hex | alias 后缀 |
| `--no-network` | false | 跑在当前/default network 内 |
| `--network <id>` | — | 指定已有 network |

## 输入输出契约

**输入：** `--topic "本周 anet 0.9 进展"`（或交互问）

**输出：** markdown 文件 `./standup-<topic>-<ts>.md`，**(b+a) 组合结构**（v2 答复 Q3）— 顶部 manager 友好摘要 + 底部 dev 友好完整 transcript：

```markdown
# Standup notes — <topic> (<date> <time>)

## 摘要（recorder LLM 提炼）         ← (b) 结构化部分

### 主要进展
- ...

### 风险 / blockers
- ...

### 下一步 actions
- [owner] ...

---

## 完整记录（transcript）            ← (a) 完整部分

### Host: <开场>
### reporter-1: yesterday / today / blockers
### Host: 谢谢 A，B 你来
### reporter-2: ...
### Host: 谢谢 B，C 你来
### reporter-3: ...
### Host: <闭幕过给 recorder>
### Recorder: ...（同摘要内容）
```

设计理由（通信龙 review）：
- (a) only — 太冗，manager 看不到立即可执行行动项
- (b) only — 太精简，dev 不能回看原话定位语境
- (c) only（经理视角只输出 risks-actions）— 视角太单一丢失团队进展信息
- **(b+a)** — 单文件双 reader：顶部 manager 摘要立即可用，底部 transcript 给 dev 回看
- 文件大小可控：4-7 agent × ~3-5 turn × markdown ≈ 5-15 KB
- 跟 debate 输出格式同思路（转录 + 评委判决并列），用户一致体验

## 与 debate / pr-review 的结构对比

| 维度 | debate | pr-review | standup（本案）|
|------|--------|----------|-----------------|
| 编排范式 | 9 步回合制 | 单轮 fan-out + barrier | 序列化轮询 + 累积 barrier |
| 指挥棒 | CLI 顺序驱动 9 步 | CLI 一次扇出 + 等齐 | **host agent 推理驱动**（每轮决定过渡话术） |
| Agent 数量 | 6 | 4 | 5 |
| Topology | host 一对多串行 | 1 → 3 并行 → 1 | host ↔ 3 序列 → recorder |
| 累积方式 | host 收尾 | judge 合并 | recorder 提炼 |

三个 demo 摆在一起覆盖 anet 编排的三种基本范式 — 回合制 / 并行扇出 / 序列轮询。后续 demo backlog 应避免在这三种范式内重复（这也是通信龙 PASS 新闻编辑室的根本理由）。

## 实现 outline

跟 `demoDebateCommand`（`agent-network/bin/cli.ts:3592`）和 `demoPrReviewCommand`（PR #26 提案）同结构：

```
agent-network/bin/cli.ts
  + demoStandupCommand()         — 主入口，参考 demoDebateCommand
  + buildStandupPrompts()        — host / reporter / recorder 三类 prompt 模板
  + driveStandupRound(host, rep) — 单轮：host 点名 → reporter 回复 → host 过渡，barrier 等回复
```

prompts 内联 cli.ts（同 debate 风格）；reporter 数量参数化让循环跑 N 轮。

模型默认 MiniMax M-*（跟 debate / pr-review 一致）。

## §UX 反馈（在控感）— P0

目标：用户跑完 `anet demo standup` 不需要看 docs/help，就感受到"我在指挥一群 agent"。控制台 + Dashboard 双视图设计，核心是**指挥棒 host→A→host→B→host→C→recorder 的序列节奏可视**。

### 启动序

```text
$ anet demo standup --topic "本周 anet 0.9 进展" --reporters 3
  Topic:     本周 anet 0.9 进展
  Reporters: 3 人
  Hub:       http://127.0.0.1:9200
  Network:   standup-9c4e (net_ef56gh78...)
  Dashboard: http://127.0.0.1:5173/network/net_ef56gh78  ⌘+click 打开

  [0/8 +0.0s] 创建 5 agent (alias 后缀 -9c4e)...
              ✓ host-9c4e / reporter-{1,2,3}-9c4e / recorder-9c4e
  [1/8 +1.4s] 启动 5 agent (tmux session)...
              ✓ 5 agent 全部 SSE connected
```

### 实时进度 feed 格式（指挥棒序列可视）

总步数 = 2 (setup) + 1 (host 开场) + N (reporter 报告) + (N-1) (host 过渡) + 1 (host 闭幕) + 1 (recorder) + 1 (cleanup) = 2N+5。`--reporters 3` 时是 11 步：

```text
  [2/11 +1.5s] host 开场 → 议题介绍 + 点名 reporter-1...
  [3/11 ✓ +14s]   host-9c4e        → "今天 standup 议题 X，A 你先来" | 12.3s
  [4/11 +14s]  reporter-1 报告...
  [5/11 ✓ +38s]   reporter-1-9c4e  → yesterday/today/blockers 三段 | 23.6s
  [6/11 +38s]  host 转 reporter-2...
  [7/11 ✓ +44s]   host-9c4e        → "谢谢 A，B 你来" | 5.4s
  [8/11 +44s]  reporter-2 报告...
  [8/11 ✓ +68s]   reporter-2-9c4e  → ... | 23.9s
  [9/11 +68s]  host 转 reporter-3 → reporter-3 报告 → host 闭幕...
  [9/11 ✓ +97s]   reporter-3-9c4e  → ... | 21.4s
  [10/11 +97s] host 闭幕 + 整包派给 recorder...
  [10/11 ✓ +115s] recorder-9c4e   → standup notes 1.8KB | 17.2s
  [11/11 +115s] 清理 5 agent + 独立 network...
              ✓ 清理完成
```

视觉卖点：用户在 terminal 滚动条上看到的就是**指挥棒在 host 和 reporter 之间真实传递**，对比 Dashboard topology 时间轴亮起的顺序对得上 — 这是 standup 序列轮询模式的核心体感。

每条 line 同 PR 审查室：`+秒数` 绝对计时，`✓` 标记 agent 完成。

### Dashboard 链接

跟 PR 审查室一致 — 第一屏 echo `Dashboard:` URL + terminal hyperlink 转义 + `⌘+click 打开` 提示。

### 失败路径友好提示

| 失败 | CLI 错误输出（含恢复命令） |
|------|---------------------------|
| `--reporters 1` 或 > 6 | `❌ --reporters 必须在 [2, 6] 范围`<br>恢复：`--reporters 3` 默认值最常用 |
| host 卡死（没点名下一个 reporter） | `❌ host-9c4e 120s 没回，序列卡在 reporter-N`<br>恢复：`anet logs host-9c4e` 查 SDK 报错<br>或 `--step-timeout 180` 加大超时 |
| reporter N 超时（v1 假设全员到齐） | `❌ reporter-2-9c4e 超时，序列中断`<br>恢复：`anet logs reporter-2-9c4e` 查报错<br>未来 v2 加 `--skip-absent` flag 跳过缺席 |
| recorder 合并跑题（不出三段结构） | `⚠️  recorder 输出未包含 ## 风险 section，已写文件但建议检查`<br>恢复：`less ./standup-*.md` 人工 review<br>或重跑（LLM 非确定性） |
| network / hub / MiniMax 错误 | 跟 PR 审查室共用（`anet doctor --fix` / `anet hub start` / `--key`） |

### 末尾输出

```text
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✓ 完成   总耗时 115s (3 reporter 序列轮询 + 1 recorder 汇总)
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Preview (摘要前 5 行)：
  ┌─────────────────────────────────────────────────────────
  │ # Standup notes — 本周 anet 0.9 进展 (2026-05-12)
  │
  │ ## 摘要
  │
  │ ### 主要进展
  └─────────────────────────────────────────────────────────

  完整文件：./standup-本周-anet-0.9-进展-1714766365.md
  结构：摘要（risks/actions/进展）+ 完整 transcript

  下一步建议：
    1. 检查内容：less ./standup-*.md
    2. 贴到团队频道：
       - Slack: 直接复制 markdown 粘贴到 #standup 频道
       - 飞书：复制粘贴到 daily standup 群（飞书支持 markdown）
       - Notion：粘贴到当日 daily note page（自动渲染 markdown）
    3. 清理 demo 现场：已自动清理 (5 agent + network)
       想保留下次跑加 --keep
```

跟 PR 审查室的"下一步"区别 — standup 的"下一步"是 **paste 到团队协作工具**（Slack / 飞书 / Notion），不是 `gh pr comment`。两个 demo 的末尾建议都是 ready-to-act，不是泛指引。

---

## §测试规格（test29-standup-room）— P1

目标：用户跑 demo 不踩坑，CI 跑每次 PR 都跑得稳。

### 样本输入（`tests/test29-standup-room/samples/`，covering happy / boring / edge）

| 文件 | 场景 | 预期 recorder 输出特征 |
|------|------|-----------------------|
| `topic-3-person.txt` | 经典 3 人 standup："本周 anet 0.9 进展" | 3 段 reporter transcript + risks ≤ 3 + actions ≤ 5 |
| `topic-6-person.txt` | 6 人大组："Q3 全员战报" + `--reporters 6` | 6 段 reporter transcript + risks ≤ 5 + actions ≤ 8 |
| `topic-blocker-heavy.txt` | 议题侧重 blocker："发版 blocker 评审" | risks 字段 ≥ 3，actions 字段每条带 [owner] 标记 |

样本是 topic 文本 + 可选 `--reporters N`，跑出真实 standup notes。

### Golden output 断言策略（结构断言）

LLM 输出非确定性。Golden file 验证结构特征，不 verbatim 比对：

| 字段 | 3-person | 6-person | blocker-heavy |
|------|----------|----------|----------------|
| 文件存在 `./standup-*-*.md` | ✓ | ✓ | ✓ |
| `## 摘要` section 存在且非空 | ✓ | ✓ | ✓ |
| `### 主要进展` / `### 风险 / blockers` / `### 下一步 actions` 三 sub-section 都存在 | ✓ | ✓ | ✓ |
| `## 完整记录（transcript）` section 包含 `### reporter-N:` 计数 | == 3 | == 6 | ≥ 3 |
| `### Host:` line 计数（开场 + N-1 转 + 闭幕） | == N+1 | == N+1 | == N+1 |
| `### 风险` 列表项数 | ≤ 3 | ≤ 5 | ≥ 3 |
| `### 下一步 actions` 每条 regex `\[.+\]` 起头（owner 标） | best-effort | best-effort | ✓ 必须 |

写到 `tests/test29-standup-room/expected/assertions.json`，runner 用 jq + grep 校验。

### Mock LLM provider（同 PR 审查室协议复用）

复用 `tests/MOCK-LLM-PROTOCOL.md`（**当前不存在**，需要测试1-3号 起；PR 审查室提案也需要它，共用 issue）。

`mock-replies.jsonl` 例子（standup）：
```json
{"in_substring": "你是 standup 主持人，开场介绍议题", "out": "今天 standup 议题 X，A 你先来"}
{"in_substring": "你是报告人，请按 yesterday/today/blockers", "out": "Yesterday: ...\nToday: ...\nBlockers: 无"}
{"in_substring": "请整合 N 份报告输出摘要", "out": "## 摘要\n### 主要进展\n- ...\n### 风险\n- ...\n### 下一步\n- [me] ..."}
```

### 三层覆盖比例

| 层 | 覆盖 % | 范围 |
|----|--------|------|
| Unit（prompt 模板） | 80% | 3 类 prompt（host / reporter / recorder）的渲染、结构解析 |
| Integration（CLI 入参） | 60% | `--topic / --reporters` 边界（1, 2, 6, 7）、`--keep / --network / --no-network`、错误码 |
| E2E（Docker 全流程） | 40% | 3 个样本各跑，验证 golden；mock LLM 模式 |

### 回归 case 列表

| Case | 优先级 | 路径 | 说明 |
|------|--------|------|------|
| `--reporters` 边界（1 报错 / 2 最小 / 6 最大 / 7 报错） | **P0** | integration | 用户输入边界，必须 explicit |
| host 不按 prompt 控制 ≤ 30 字（过长） | **P0** | unit + e2e | 直接影响整场耗时 + token 成本 |
| reporter 不按 yesterday/today/blockers 三段式 | **P0** | unit | recorder 解析依赖结构 |
| recorder 输出缺 `### 风险` 或 `### 下一步` section | **P0** | e2e | 摘要质量保证 |
| 指挥棒序列中断（host 没点名下一个） | **P0** | e2e | 序列轮询模式的核心可靠性 |
| MiniMax 429 / 超时 | P1 | integration | nightly 跑 |
| `--keep` 保留 5 agent | P1 | e2e | nightly 跑 |
| 6-person 长 standup token 上限 | P1 | e2e | nightly 跑（成本控制） |
| terminal hyperlink 转义不支持终端 fallback | P2 | release | release 前手动 |
| recorder 输出非 UTF-8（极少 LLM corner case） | P2 | release | release 前手动 |

P0 必跑（每次 CI），P1 nightly，P2 release 前手动。

---

## 旧验证方式表（已被 §测试规格 取代，保留供参考）

| 层级 | 验证 |
|------|------|
| 资产 | `agent-network/bin/cli.ts` 加 `demo standup` 子命令 |
| 自动化 | `tests/test29-standup-room/` — 详见 §测试规格 |
| 文档 | `docs-site/docs/cases/standup-room.md`（ZH + EN）+ 加入 `cases/index.md` 表格 |

## 不在范围内（v1）

- **不做 host 拐回追问 blocker 的二轮**（v2 答复 Q2：通信龙 砍 — 纯序列化轮询是本 demo 核心卖点，加 host 自由切换会让范式对比矩阵的清晰度变模糊；如未来用户要 probe，再做第四个 demo "AI 风险评估会"或加 `--probe` flag）
- **不做异常缺席处理**（reporter 超时直接跳过下一个 → v1 假设全员到齐）
- **不接 Slack / 飞书 channel 发自动 standup notes**（v2 加 channel adapter，本期纯 stdout + markdown 文件）
- **不做参与者持久化身份**（每跑一次 standup N+2 个 agent 都是临时 alias，不存"小明 / 小红"角色）

## 风险 / 待定

- **host LLM 推理过渡话术冗余**：host 每轮要说"OK 谢谢 A，B 你来"可能浪费 token；v1 用 prompt 强制 host 过渡 ≤ 30 字
- **reporter 走形式答非所问**：MiniMax 可能不按 yesterday/today/blockers 三段式输出；v1 用结构化 prompt + recorder 后处理正则提取
- **recorder 合并跑题**：v1 prompt 强制 recorder 只用三个 section（risks / blockers / next-actions），不放 freeform 总结

## Review 问答（v2 已 ack）

| # | 问题 | 通信龙 答复 |
|---|------|-------------|
| Q1 | reporter 数量参数化 vs 固定 3？ | **参数化 `--reporters <n>` 默认 3 范围 2-6**。理由：团队规模差异大、min 2 防退化对话、max 6 控总 agent ≤ 8。debate 固定 6 是辩论格式硬约束，standup 没硬约束。 |
| Q2 | host 拐回追问 blocker 二轮要不要？ | **v1 砍，不要 `--probe` flag**。理由：纯序列化是核心卖点，加 host 自由切换会让范式对比矩阵变模糊；如未来要 probe 单独做第四个 demo。 |
| Q3 | recorder 输出选 (a)/(b)/(c)？ | **(b+a) 组合**。顶部 manager 友好摘要 + 底部 dev 友好 transcript，单文件双 reader 满足。详见上面"输入输出契约"。 |

**关键设计 ack 项**（通信龙 review）：
- ✅ host 单独 agent — 序列化轮询指挥棒传递需要 LLM 推理（不是机械 round-robin）
- ✅ recorder 单独 agent — 累积 barrier 合并 + 提炼 risks/actions 是 LLM 工作（同 PR 审查室 judge 保留理由）
- ✅ 编排范式对比矩阵 — 覆盖 anet 三种基本编排范式，新闻编辑室 PASS 的根本理由

## Timeline（待 review 通过）

跟 PR 审查室 1:1 复制节奏：

1. 现在：本提案 push 到 worktree `~/anet-work/demo-standup-room/` 分支 `feat/demo-standup-room` 开 draft PR refs 即将开的 standup tracking issue
2. 等：Vincent merge 完当前 PR queue 后再实施 5 agent + CLI 代码（跟 PR 审查室 #26 排队）
3. 实施 PR：closes 那个 standup issue，含 `demoStandupCommand` + `tests/test29-standup-room/` + `docs-site/docs/cases/standup-room.md`（ZH + EN）

---

**Demo backlog 状态（v2 通过后）：**

- ✅ PR 审查室（[#25](https://github.com/sleep2agi/agent-network/issues/25) + draft [PR #26](https://github.com/sleep2agi/agent-network/pull/26)，approved，等 Vincent merge backlog 后开实施 PR）
- ✅ 产品 standup（本提案 v2，[#27](https://github.com/sleep2agi/agent-network/issues/27) + draft [PR #28](https://github.com/sleep2agi/agent-network/pull/28)，approved，等 Vincent merge backlog）
- ❌ AI 新闻编辑室（通信龙 PASS，模式与 translation-pipeline 重合）

## anet 编排范式覆盖矩阵（v2 final）

通信龙 review 给的结论：**6 个 demo（4 现役 + 2 新提案）已覆盖 anet 主流编排范式，第三个 demo 提案先不主动出**。等 PR 审查室 + standup 实施完跑通一遍真用户反馈后，再决定要不要加第 7 个 demo。

| 范式 | 已 cover | demo |
|---|---|---|
| 对话 | ✅ | hello-world |
| 线性链 | ✅ | translation-pipeline |
| 回合制 | ✅ | debate |
| 指挥-worker | ✅ | telegram-squad |
| 并行扇出 + barrier 合并 | ✅ (待实施) | PR 审查室 |
| 序列轮询 + 累积 barrier | ✅ (待实施) | **standup（本案）** |

可能但暂不做的范式（通信龙 整理）：
- map-reduce 大规模并行 — 跟 PR 审查室相似但放大 N，区分度小
- 协商 / negotiation — 跟 debate 相似但去掉 judge，区分度小
- 递归 / 分治 — 新颖但实现复杂度高
- 流式处理 streaming pipeline — RFC-003 telemetry 实施后才有视觉化基础

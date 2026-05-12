# Demo 提案：产品速会 standup（Standup Room）

> 提案人：通信demo马
> 日期：2026-05-12
> 状态：v1 草案，待 通信龙 review
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
| `--reporters <n>` | 3 | 报告人数量 (留给 review Q1) |
| `--key <key>` | `$MINIMAX_KEY` | MiniMax API Key |
| `--out <path>` | `./standup-<topic>-<ts>.md` | 输出路径 |
| `--keep` | false | 保留 N+2 agent + network（debug 用） |
| `--step-timeout <s>` | 120 | 单步超时 (standup 报告比 debate 立论短，可压缩) |
| `--suffix <s>` | 随机 4 hex | alias 后缀 |
| `--no-network` | false | 跑在当前/default network 内 |
| `--network <id>` | — | 指定已有 network |

## 输入输出契约

**输入：** `--topic "本周 anet 0.9 进展"`（或交互问）

**输出：** markdown 文件 `./standup-<topic>-<ts>.md`，结构：

```markdown
# Standup: 本周 anet 0.9 进展

**时间：** 2026-05-12
**主持：** host-1a2b
**报告人：** reporter-1-1a2b / reporter-2-1a2b / reporter-3-1a2b
**记录：** recorder-1a2b

## reporter-1
- **Yesterday:** 完成 demo 提案 v2 + draft PR #26
- **Today:** 草第二个 demo 提案（standup）
- **Blockers:** 等 PR queue 消化才能动 cli.ts

## reporter-2
...

## reporter-3
...

## Risks
- ...

## Blockers (聚合)
- ...

## Next Actions
- ...
```

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

## 验证方式（对标 cases/index.md 标准）

| 层级 | 验证 |
|------|------|
| 资产 | `agent-network/bin/cli.ts` 加 `demo standup` 子命令 |
| 自动化 | 新增 `tests/test29-standup-room/` — Docker 起 hub + 5 agent，喂 `--topic` + `--reporters 3`，验证输出文件 + recorder 三段式存在 |
| 文档 | `docs-site/docs/cases/standup-room.md`（ZH + EN）+ 加入 `cases/index.md` 表格 |
| samples | 跑完留一份 `tests/test29-standup-room/expected/sample-standup-notes.md` 作为 golden 输出对照 |

## 不在范围内（v1）

- **不做 host 拐回追问 blocker 的二轮**（真实 standup 会议常见但混入序列化模式 → 留 review Q2）
- **不做异常缺席处理**（reporter 超时直接跳过下一个 → v1 假设全员到齐）
- **不接 Slack / 飞书 channel 发自动 standup notes**（v2 加 channel adapter，本期纯 stdout + markdown 文件）
- **不做参与者持久化身份**（每跑一次 standup 5 个 agent 都是临时 alias，不存"小明 / 小红"角色）

## 风险 / 待定

- **host LLM 推理过渡话术冗余**：host 每轮要说"OK 谢谢 A，B 你来"可能浪费 token；v1 用 prompt 强制 host 过渡 ≤ 30 字
- **reporter 走形式答非所问**：MiniMax 可能不按 yesterday/today/blockers 三段式输出；v1 用结构化 prompt + recorder 后处理正则提取
- **recorder 合并跑题**：v1 prompt 强制 recorder 只用三个 section（risks / blockers / next-actions），不放 freeform 总结

## 留给 review 的 3 个问题

1. **报告人数量参数化吗？** `--reporters <n>` 默认 3，最小 2 最大 6？还是固定 3 给最干净的默认体验？（参数化 = 更灵活，固定 = topology 永远一致更好讲）

2. **要不要 host 拐回追问 blocker 的二轮？** 真实 standup 常见 host "等等，A 你刚说 blocker 是啥，详细说说" — 加进来就不是纯序列化了，变成"序列 + host 自由切换"两阶段。v1 直接砍掉简化，还是保留作为 `--probe` flag 演示更复杂编排？

3. **recorder 输出风格选哪种**：
   - (a) 完整 transcript（保留每人原话）
   - (b) 结构化三段（yesterday/today/blockers per person + 末尾 risks/next-actions）← 我倾向
   - (c) 经理视角总结（只输出 risks/blockers/next-actions，省略原话）

   选 (b) 还是 (a+b 并列输出)？

## Timeline（待 review 通过）

跟 PR 审查室 1:1 复制节奏：

1. 现在：本提案 push 到 worktree `~/anet-work/demo-standup-room/` 分支 `feat/demo-standup-room` 开 draft PR refs 即将开的 standup tracking issue
2. 等：Vincent merge 完当前 PR queue 后再实施 5 agent + CLI 代码（跟 PR 审查室 #26 排队）
3. 实施 PR：closes 那个 standup issue，含 `demoStandupCommand` + `tests/test29-standup-room/` + `docs-site/docs/cases/standup-room.md`（ZH + EN）

---

**Demo backlog 状态（通信龙 review 后）：**

- ✅ PR 审查室（[#25](https://github.com/sleep2agi/agent-network/issues/25) + draft [PR #26](https://github.com/sleep2agi/agent-network/pull/26)，approved，等开工）
- 🟡 产品 standup（本提案，新 issue + 新 draft PR，等 review）
- ❌ AI 新闻编辑室（通信龙 PASS，模式与 translation-pipeline 重合）

第三个 demo 备选（review 通过本案后再排）：留待通信龙 出题或我提候选。

# anet QA v1 — 路线提案（等 Vincent / 通信龙 拍板）

> 配套 [v0-summary.md](v0-summary.md) — v0 16 条测试 + 11 SDK finding 已 ship。
> v1 是 **决策点**，不是简单延续。下面 5 个方向各有取舍。

## 决策点

v0 用「**测试体系一步步融入研发，不阻塞 anet 迭代**」做了 20 轮。**继续做矩阵补格子 ROI 开始递减**（每轮 抠出的新契约从平均 2.3 个降到 0.5 个左右）。

v1 应该选**新方向**。下面五个 by 优先级：

## A. 让 11 条 SDK finding 落到 PR（不归 QA，但 QA 触发的） ⭐⭐⭐

**做什么**：把 11 条 finding 派给各模块 owner：
- finding 1, 4, 7（hub 行为）→ 通信牛
- finding 2, 3, 5, 8, 9 → 通信牛 / SDK马
- finding 6（doc）→ 通信文档马（我）
- finding 10, 11（dashboard 期望）→ 通信牛 + N站马 一起评

**为什么是 #1**：QA 已经把弹药备好。**让真改动落地**才是「质量保障体系」的下半场。
我可以发派单评论，但**改业务代码归他们**。

**预算**：每 finding 平均 2h（看代码 / 改 + 写测试）。11 条 ~22h 散到多人，1 周内可清。

**对 QA 的影响**：finding 改完，pin 它们的测试自动反映新行为；如果改动违反 pinned 契约，CI 立刻挂 → **QA 体系成为变化的安全网**。

## B. CI gate 升档 2（条件性 must-pass） ⭐⭐

**做什么**：把 [strategy.md §4](strategy.md#4-ci-gate渐进三档) 档 2 启用 —— 主路径文件（`server/src/**`, `agent-network/bin/cli.ts`, `tests/qa-*/**`）变更的 PR **必须** L0+L1 全过才能 merge。

**为什么**：v0 一直是 report-only。20 轮零 false positive，**CI 信号已建立信任**。是时候让它真当门卫。

**风险**：
- 一个 flaky 测试 = 阻塞所有 PR
- 需要 maintainer 在 branch protection 配置（不归我）

**预算**：1h 配置 + 文档。决策成本高于实施成本。

## C. NODE-04b / NODE-05 收尾 agent-node 用户视角 ⭐

**做什么**：补 agent-node 4/6 → 6/6：
- NODE-04b：real `anet node start` 自重连（杀 hub 看 agent 自愈）
- NODE-05：runtime 切换（claude-code / codex / minimax 任一启动到 connected）

**为什么**：**矩阵补齐对外好讲**，但 ROI 不高（这两条之前都判断「heavy + ROI 不高」延后）。

**预算**：NODE-04b 1 轮（~10s 测试，需要 real claude / 或 stub runtime），NODE-05 1 轮。

## D. 代码视角洼地 UT-04 cli.ts 解析层 ⭐

**做什么**：[cli.ts](../../agent-network/bin/cli.ts) 4771 行 0 单测。**第一步是抽 pure function**（命令解析 / opts parser / 帮助文本生成），然后单测。

**为什么**：代码视角 3/5 是 v0 的真洼地。但**抽函数 = 改业务代码**，违反「不改业务逻辑」铁律。
要做必须 Vincent 同意先做小重构。

**预算**：抽函数 4–8h（cli.ts 是 wholesale 业务），单测 2h。

## E. 自动化报告聚合 / 持续运营 ⭐

**做什么**：
- 每周 PR 把所有测试 pass/fail trend、跑时长趋势、新 finding 数量做成一份给 Vincent 的 1-page 报告
- 加 alert：CI 连挂 3 次 → 派给 owner
- 把 11 SDK finding 列表自动生成（grep 测试 README 的 GAP 章节）

**为什么**：**让 QA 体系自己有声音**，不依赖 Vincent 主动看 issue #31。

**预算**：1 轮做脚手架 + 每周自动跑。

## 我的建议

**优先级 A > B > C/D/E**：

1. **R21 完成后立刻发派单 (Plan A)**：把 11 finding 分派给 通信牛 / SDK马 / N站马，开 follow-up issue per finding，给截止日期
2. **等 1 周 CI 稳定，启 Plan B**：CI 升档 2，把测试体系真当成 PR 评审基线
3. **Plan C/D/E 视 Vincent 优先级再排**

如果 Vincent 想看不同方向（比如「就先收尾矩阵到 100%」走 C，或「先把 cli.ts 解析重构掉」走 D），随时调整 R22+ 的目标。

R21 这一轮**只产出文档**（这两份 + 评论），不写代码。
等 Vincent 评论拍板后，R22 才执行选定的方向。

— 通信测试马

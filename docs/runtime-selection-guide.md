# Runtime 选型指引（anet-node）

状态：2026-07-14（北京时间）· 触发：codex-app-server runtime 派代码类任务连续 600s 超时的实测复盘

**一句话**：**重代码 / 长任务用 `claude-agent-sdk`；`codex-app-server` 只在已真跑验证的源码分支 / 明确版本上适合交互式 TUI 人机共存 + 文字 / 策划 / 短任务，别派长代码。**

> 渠道前提：`codex-app-server` 是真实 runtime，但截至今晚实测，**未进入已发布 npm 包**；旧发布包拿到这个 runtime 名会静默回落到 `claude`，不报错（issue #491）。`--help` 不列、grep dist 没字面量，都不能证明不存在；是否可用必须以真跑为准。

---

## 1. 核心坑：codex-app-server 的 600s 单回复上限（结构性）

**现象**：给 codex-app-server runtime 的节点派代码类重活（改码 + 跑测试 + 工具循环），即使拆到最小颗粒（一次一节课 / 一个 issue）仍频繁报
`codex-app-server 错误: 任务 X 超时（600s 内无最终回复）`。文字 / 策划类任务同链路完全正常。

**根因（在 anet-node 层，不是 codex 崩）**：
- 那句超时是 **anet-node 的 task-deadline**（`processTask returned 超时`），不是 codex 报错。
- codex-app-server 是**一个 turn 跑到底、中途不给 requester 任何 task-ack / 心跳**。代码类重活单 turn 常 15–25min，节点 600s deadline 先 fire → requester 看到超时。
- **关键：codex turn 通常会越过 deadline 继续算、活也常真落地**（git commit 出来了），但那条 dispatched task 已被标超时。所以**「超时 ≠ 失败」**——但 requester 分不清，看着就是失败。
- 文字 / 策划类能过，是因为它们单 turn 短、600s 内出最终回复。

**别做**：撞超时后**不要对同一节点重复派同一任务**——原 turn 可能还在跑、活可能已落地，重复派只会叠加 inbox backlog、串行再超时，越发越堵。

---

## 2. Runtime 选型矩阵

| 任务类型 | 推荐 runtime | 理由 |
|---|---|---|
| 重代码（多文件改 + 跑测试 + 工具循环） | **claude-agent-sdk（Tier1）** | 无 600s 单回复坑；最可靠 |
| 安全审查 / 长推理 / 独立复核 | **claude-agent-sdk** | 需长 turn + 高可靠；codex 后端还可能被内容过滤误拦安全活 |
| 交互式 TUI 人机共存（人 + agent 共用一个 TUI） | **codex-app-server / grok-build-cli** | 仅限对应源码分支 / 明确版本已真跑验证；这俩的强项就是原生 TUI 共存 |
| 文字 / 策划 / 文档 / 短任务（单 turn <600s） | codex-app-server 可用 | 前提是节点真实运行在 codex-app-server，未静默回落；短 turn 不撞 deadline |
| 长代码但必须用 codex 后端 | 拆到**单 turn 确保 <600s 出最终回复**，或接受「超时但活落地」模式、只读结果不重派 | 治标 |

**可靠性分级**：claude-code-cli / claude-agent-sdk = Tier1；codex 后端脆（600s 坑 + 内容过滤 + 长 uptime 静默降级），关键 / 长 / 安全活优先 Claude 后端节点。

---

## 3. 临时应对（团队现在就照这个走）

- **文字 / 策划类** → 继续派 codex-app-server specialist。
- **代码类** → 收回自己做 + 开 subagent，或派 claude-agent-sdk 节点。
- 派工前先判任务类型：**"这活的单 turn 会不会超过 600s？"** 会就别用 codex-app-server。
- 新建 / 重启 codex-app-server 共存节点后，先验两件事：runtime 自报没有回落到 `claude`；`readlink /proc/<app-server-pid>/cwd` 指向预期工作目录。codex 线程继承 app-server 进程 cwd，不继承桥进程 cwd。

---

## 4. 治本方向（anet-node 层改动，已开 issue 给 anet 组）

codex-app-server 内部**其实有中间事件**（spawning / created thread / stderr），只是 anet-node wrapper 没 relay 进度、没在有活动时重置 deadline。三条修法按优先级：

1. **（治本）** node 层发**中间 heartbeat / 进度**给 requester + **有活动就重置 task-deadline**——让长 turn 不被误判超时。
2. **（治标·快）** code-runtime 节点**可配更长 task-deadline**（如 code 类节点 config 加 `taskDeadlineMs`）。
3. **（治本·大）** 流式 partial 输出。

在治本落地前，codex-app-server 节点的 config / 文档应标注：**「不适合长单回复代码任务；重代码用 claude-agent-sdk，或拆到单 turn <600s，否则会超时（但活可能仍落地，别重复派）」**。

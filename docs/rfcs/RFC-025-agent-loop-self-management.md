# RFC-025 — Agent Loop 自感知 + 自管理

> 状态: 草稿 (design-first, 待 通信龙 + Vincent review)
> 作者: 通信SDK马
> 关联: #144 (anet /loop universal), #184 (goals scheduler), #288 (loop-runtime-gate)
> 日期: 2026-06-28

## 1. 背景与动机

#144 把 anet `/loop` 调度器统一到所有 runtime（claude-agent-sdk / codex / grok），用户现在可以用 `anet node loop <alias> "<task>" --every 5m` 给任意节点排循环任务。但 agent 自身**对自己的循环是"无感"的**：

- 不知道当前在循环哪几件事
- 没法自主调整（要用户从外部 CLI 改 / 用 `anet goal cancel` 停）
- 不能根据任务推进情况自适应节奏（重要的事多盯、稳定的事少跑）

Vincent 强需求："**agent 要自己理解 loop**" —— 不只被动执行，而是感知 + 通过自然语言对话调整管理自己的 loop。

参照 Claude Code `/loop` 动态模式（本会话即跑在这套上）：agent 用 `ScheduleWakeup(delaySeconds, prompt)` **自主决定下次唤醒时刻 + 下次执行什么**。anet 要给本体 agent 等价能力。

## 2. 设计目标 & 评判维度

通信龙 review 卡这 5 条：

| # | 维度 | 含义 |
|---|------|------|
| ① | **自调** | agent 能 list/edit/cancel/create/reschedule 自己的 loop |
| ② | **智能** | LLM 自己理解意图（"太频繁了" / "重要的事多盯"），不写 NLU 规则 |
| ③ | **Claude Code 范式** | 自调度: agent 用工具决定下次唤醒，不只固定 interval |
| ④ | **🔴 防双调度** | anet goals scheduler 是**唯一**调度源；SDK query() 只是单次任务执行 |
| ⑤ | **优雅** | 复用 (goals store + parser + commhub-mcp pattern) / 最小新增面 / 干净抽象 / per-runtime 共享一层 |

## 3. 核心模型: 两层调度严格分离

```
┌────────────────────────────────────────────────────────────────┐
│ 外层 (Outer): anet goals scheduler                              │
│   ★ 唯一调度源                                                  │
│   - runGoalSchedulerTick (cli.ts:1131) — 每 30s tick            │
│   - 读 goals.json, 找 next_wake_at ≤ now 的 active goal         │
│   - 决定何时唤醒 agent + 喂什么 prompt                            │
│   - agent 用 4 个 self-loop tools 管理这一层的 goals             │
└────────────────────────────────────────────────────────────────┘
                          │ 唤醒
                          ▼
┌────────────────────────────────────────────────────────────────┐
│ 内层 (Inner): SDK 单次任务执行                                   │
│   - claude-agent-sdk: query() 返单次 Promise                    │
│   - codex-sdk: thread.runStreamed() 单次返完                    │
│   - grok-build-acp: 单次 prompt → response                      │
│   ★ 内部 agentic-turn loop ≠ 循环, 是单次任务的执行细节            │
└────────────────────────────────────────────────────────────────┘
```

**防双调度的硬不变式** (#288 教训延伸):

- ❌ 不允许 SDK 内部触发 anet goals 之外的"循环"——比如 SDK 未来加 self-scheduling，anet 要明确禁用或不接入。
- ❌ 不允许 self-loop tools 在**当前 wake 的 agentic turn 内立即触发下次 wake**（防递归暴走）——cooldown 防线见 §6。
- ✅ 一个 goal 一次 wake 一次 SDK call；SDK 内部 turn loop 是任务执行细节，不计入循环计数。

### 3.1 `claude-code-cli` — 范围外 (用原生 CC /loop)

Per Vincent: `claude-code-cli` 一直用 Claude Code 原生 /loop 自管, 不接 anet scheduler / self-loop tools. 本 RFC 范围 = **claude-agent-sdk / codex / grok 三个 agent-node runtime**. 双触发风险已 ruled out (claude-code-cli 是独立 CC session, 不经 agent-node, 不碰 anet goals.json). 见 §6 per-runtime 表 + §12 non-goals.

### 3.2 设计缺口 (独立 LLM-validation review 抓到, 折进本 RFC)

通信龙 起独立 agent 用 3 个 LLM context 跑 8 句自然语言测「LLM 能否从工具 description 解析意图 + 调对工具」, **工具选择 100% 一致** — 核心 premise (②智能) 成立. 但抓到 **5 个真设计缺口**, 全部折进本 RFC:

#### 🔴 #1 时间点 / cron-lite 调度缺口 (最重要)

interval 模型只表达 **「每隔多久」** (5m/2h/1d), 但**「每天早上9点」「每周一」「工作日」「每月1号」**这种 **wall-clock** 表达不了. **Vincent 自己举的例子** ("每天早上9点发摘要") 不在当前数据模型覆盖范围.

LLM-validation 实测: 3 个 LLM 都硬凑 `create(1d) + reschedule "算到下个9点几小时"` —— 都自标"只是近似" + LLM 时钟运算易飘 + DST/相位漂移 + 「每周一/工作日」完全没法映射. **且 LLM 倾向静默近似而不报"做不到" = 危险**.

**修法 (二选一, 待 review 拍)**:
- **(A) 加 cron-lite 调度字段** — `AgentGoal` 增加 `schedule?: { type: 'interval' | 'time_of_day' | 'weekday', value: string }` 联合类型:
  - `{type:'interval', value:'5m'}` (现状)
  - `{type:'time_of_day', value:'09:00'}` — 每天该时刻 (含时区)
  - `{type:'weekday', value:'mon 09:00'}` — 每周指定
  - 复用现有 `next_wake_at` 字段, 调度器 tick 时计算下一个匹配 wall-clock
- **(B) parser/工具显式拒 wall-clock 请求** — 让 agent 如实告诉用户「目前只支持间隔不支持指定时间点, 你想要 24h 间隔还是其他?」, 不静默凑

**倾向 (A)**: 「每天早上9点」是最常见用户说法 + Vincent 例子 + cron-lite 加 80 行调度代码可解决, 价值高. (B) 太将就.

新数据字段 + 调度器 wake 决策更新 + 工具 `create_my_loop` / `edit_my_loop` 新增 `schedule` 参数 (跟旧 `interval` 互斥) — 列入 §10 P0/P1.

#### #2 防误删 — 批量 / destructive 操作要 confirm-back

`cancel_my_loop` 现在立即执行无确认. LLM-validation 测「把所有循环停了」3 个 LLM 都选了**可逆的 `edit(paused=true)` + 先 list-first** (好直觉), 但**设计没强制** — 换个措辞「全删了」就一次性 cancel 光. 不能依赖 LLM 直觉.

**修**: destructive / 批量 loop 操作走 **confirm-back 模式** (符合 anet [RFC-023 destructive-command-guardrail](./RFC-023-destructive-command-guardrail.md) 规范):
- 单 `cancel_my_loop` ok 直接执行
- N 个连续 `cancel_my_loop` 在短时间窗 (3 次/30s) 触发批量警告: 工具 return `{ok:false, error:'batch_destructive_confirm_required', message:'用户是否确认要取消这些 goals?<list>'}` agent 必须问用户再 retry

实现成本: ~30 LOC counter + return-shape 约定. 列入 §7 安全防线扩展.

#### #3 编造的参数值要回报给用户

LLM-validation #1 「太频繁」无具体数字, 3 个 LLM 都猜 30m. **一致 ≠ 对** — 用户可能想 1h 或 15m. 工具选对了但**量级是猜的**.

**修**: agent 调 `edit_my_loop` / `create_my_loop` 改 / 设 interval 后, **回报给用户具体新值** ("已改成 30 分钟一次, 这个频率合适吗?") — 静默猜错变廉价纠正. 不需工具改, 用 tool description 提示:

> `edit_my_loop` description 加: "用户没给具体数字时, 选合理值后**回报新值**给用户(中文/英文)让用户能纠正. 例: 用户说'太频繁了' → 改成 30m → 回'好的, 改成每 30 分钟一次了'"

#### #4 pause / cancel / complete 描述拉开语义

三个语义相邻 (都是「停」). 干净措辞下 3/3 区分对, 但糊措辞「这个别跑了」掷硬币. tool descriptions 必须明示对比:

- `pause` (edit_my_loop 的 paused=true) = **临时**, 可 resume, goal 保留 active 概念但不 fire
- `cancel_my_loop` = **永久放弃**, status 改 `cancelled`, 用于不再做这件事
- `complete_my_loop` = **达标归档**, status 改 `complete`, 用于"已完成"

每个工具 description 含一句对比性提示防混淆. 列入 §5 工具表更新.

#### #5 多 loop 状态再测 — 指代消解

LLM-validation 测试都在 **单/少 loop** 状态. 「这个/重要的那个/查邮件那个」指代消解的难度被掩盖. **ship 前必跑 3-5 个 loop 状态的指代/批量歧义测**. 列入 §10 P5 e2e 矩阵.

## 4. Loop 自感知 (context injection)

### 4.1 注入位置

每次 agent 被唤醒执行 task 时（包括 `processTask` 的 inbox-任务路径 + scheduler-wake 路径），prompt 拼接前注入一段 **`【你的当前循环任务】`** 块。

```
【你的当前循环任务】 (anet goals — 你能用 manage_my_loop 工具管理这些)

3f8a2b1c  active   每 5min     下次: 2026-06-28T15:35:00Z
   监控 PR #271 进展

a2b3c4d5  active   每 1d       下次: 2026-06-29T00:00:00Z
   每天早上整理昨天的发布工作

7e8f9012  paused   每 30m      暂停于: 2026-06-28T12:00:00Z
   扫一遍 twitter 上 grok 的最新进展
```

最小实现：
- `cli.ts:processTask` 在调 think() / 各 runtime 入口前，从 `goalStore.list()` 拉 active+paused goals
- 用辅助函数 `formatSelfLoopsBlock(goals): string` 渲染（提取到 `goals/format.ts`）
- 注入到 system prompt 或 user prompt preamble（claude-agent-sdk 走 systemPrompt option, codex/grok 走 prefix）

### 4.2 刷新策略

每次 task 执行前都重新读 `goalStore.list()`，**不缓存**。理由：
- goalStore 已有 in-memory map + mutex，读是 O(N goals) 微秒级
- agent 可能在上一次 turn 里调了 edit/cancel/create_my_loop，下一次 turn 必须看最新状态
- 不缓存 = 不引入"陈旧视图"bug 类

### 4.3 token 成本

active goals 通常 <10 条。每条 ~80 tokens 渲染。总 <1k tokens / turn — 可接受。

## 5. Loop 自管理工具

### 5.1 工具集 (6 个, self-scoped)

| 工具 | 用途 + tool description 提示 (LLM 引导关键) | 关键参数 | 语义类 |
|------|----------|---------|--------|
| `list_my_loops` | 看自己当前所有 loops. **用户提到「这个/那个」时先 list 再确认指代** | (none) | 读 |
| `create_my_loop` | 新建一个 loop. 用户没给具体数字时选合理值后**回报新值** ("已设成每 X 分钟一次") 让用户纠正 (per §3.2 #3) | `task: string`, `schedule: ...` (含 interval / time_of_day / weekday, 见 §3.2 #1) | 写 |
| `edit_my_loop` | 改 task / interval / 暂停 (`paused=true` **临时**, 可后续 resume). 改 interval 后必**回报新值**给用户 | `goal_id`, `task?`, `interval?`, `paused?: boolean` | 写 |
| `reschedule_my_loop` | ★ **动态自调度** — 不改 interval, 只跳过本轮把 next_wake 推到指定时刻. 任务"这次有进展但不急, 下次 1h 后再看"专用 | `goal_id`, `next_wake_in: string` (e.g. "30m") | 写 |
| `complete_my_loop` | ★ **达标归档** — 任务目标已实现 (e.g. PR merged / 报告交付). status=`complete`. **不同于 cancel**: 这是成就, 不是放弃 | `goal_id` | 写 (终态) |
| `cancel_my_loop` | **永久放弃** — 不再做这件事 (非达标). status=`cancelled`. **不同于 pause/complete**: 这是放弃, 不可恢复. **批量取消 (3 次/30s 窗) 触发 confirm-back, 工具拒绝直接执行, 让 agent 回问用户确认** (per §3.2 #2) | `goal_id` | 写 (终态) |

★ = 本设计的优雅核心 (通信龙 review 强调):

**`reschedule_my_loop`** — 是 Claude Code `/loop` `ScheduleWakeup(delaySeconds, prompt)` 范式的核心抽象。agent 在执行一次 wake 时可以说"这次任务有进展但不急，下次 1h 后再看"，调 `reschedule_my_loop(goal_id, "1h")`，**本次 cycle** 的 `next_wake_at` 推迟到 1h 后但不改 interval 本身。下下次依然按原 interval 跑。比"只改 interval"高一层：agent 像 Claude Code 那样**自主决定下次什么时候醒**，而不是被动等固定周期。

**`complete_my_loop`** vs `cancel_my_loop` — 语义类分清:
- `complete`: "我把这件事做完了/达标了" → goal.status = `complete`. 用于"监控 PR 直到 merge" 这种**有明确成功条件**的循环。agent 自决任务实现即收，**防死循环**核心防线。
- `cancel`: "不做了/不重要了/用户让停" → goal.status = `cancelled`. 用于明确放弃。

两者都终态，但语义对 LLM 不同：`complete` 暗示成就，`cancel` 暗示放弃。让 agent 选对的那个，user / 审计回看时也清楚发生了什么。

### 5.2 Self-scoped 不变式 (④ 安全)

所有 5 个工具：

```ts
// Pseudo-impl
async function list_my_loops(args, ctx) {
  const myAlias = ctx.agentAlias;  // from runtime caller-binding
  return goalStore.list();  // already file-scoped to THIS node's goals.json
                            // — goals.json sits at .anet/nodes/<myAlias>/goals.json
}

async function edit_my_loop(args, ctx) {
  // goal_id MUST resolve to a goal in MY goals.json (impossible to
  // address another node's goal because goalStore is per-node-file
  // bound). No alias arg accepted in the tool surface.
  const g = await goalStore.get(args.goal_id);
  if (!g) return { ok: false, error: "goal not found in your loops" };
  // ...apply edit via goalStore.mutate()...
}
```

**关键设计**: tools 不接受 `alias` 参数。`goalStore` 实例化时绑死本节点的 `goals.json`（已有的 P184 设计），所以 agent **物理上无法**访问别节点的 goals — 安全 by-construction，不靠 runtime check。

### 5.3 共享接口 + per-runtime adapter (⑤ 优雅)

定义共享接口 `agent-node/src/goals/self-loop-tools.ts`：

```ts
// 通用工具定义 — runtime-agnostic
export const SELF_LOOP_TOOL_SPECS: Array<{
  name: string;
  description: string;
  schema: ZodSchema;
  handler: (args: any, ctx: SelfLoopCtx) => Promise<SelfLoopResult>;
}> = [...];
```

每个 runtime adapter 把这 5 个 spec 翻译成自己的工具形式：

- **claude-agent-sdk**: 在 `commhub-mcp.ts` 同款 `createSdkMcpServer({name: "loops", tools: [...]})` 里注册 → tool names `mcp__loops__list_my_loops` 等
- **codex-sdk**: 复用 commhub MCP server 同款 stdio 通道（写一个新的 `loops-mcp.ts`），通过 codex 的 mcp_servers 配置暴露
- **grok-build-acp**: ACP 协议的 tool 注入（参照现有 grok runtime 的 commhub 工具注入）

共享 specs 一处定义，三处 adapter 各 ~20 行翻译。新增工具时改一处。

## 6. Per-runtime 可行性 + 实现路径

| Runtime | 范围 | 工具暴露通道 | 可行性 | 实施量 |
|---------|---------|---------|---------|---------|
| **claude-agent-sdk** | ✅ 本 RFC 覆盖 | `createSdkMcpServer` (已有 commhub-mcp.ts 模式) | ✅ 现成路径 | ~50 行 (新 file + 注册到 query options.mcpServers) |
| **codex-sdk** | ✅ 本 RFC 覆盖 | `~/.codex/config.toml` mcp_servers 或 SDK API | ⚠ 需调研: codex SDK 是否支持运行时注入 in-process MCP, 还是必须走 config.toml + stdio subprocess | 调研 + ~80 行 (若 stdio 则起 mini server) |
| **grok-build-acp** | ✅ 本 RFC 覆盖 | ACP `McpServer` 配置 (现有 commhub 用同一模式) | ✅ 同 commhub MCP 注入路径 | ~50 行 |
| **claude-code-cli** | ❌ **范围外** (per Vincent) | (N/A — 用 CC 原生 /loop + CronCreate / ScheduleWakeup, 独立 CC session, 不接 anet) | — | 0 (不实施) |

**Fallback**: 若某 runtime 实在塞不进 in-process MCP，**仍可让 agent 通过现有的 commhub `send_task` 给自己发 `/loop <interval> <task>` 形式的消息**。等价于 agent 用现成的 inbox `/loop` 入口 — 兜底可用，但不够优雅（要绕一圈 commhub）。

## 7. 安全 & 边界

### 7.1 防递归暴走

agent 在 `edit_my_loop` 把 interval 改成 60s 后立即 schedule 又改… 可能写入风暴。防线：

1. **Per-goal cooldown**: `edit_my_loop` / `reschedule_my_loop` 对同一 `goal_id` 在 30s 内只允许 1 次。第二次 NOP + 返 `cooldown` 信息（不报错, 不让 LLM 重试）。
2. **`updated_at` 已是 GoalStore 现成字段**: cooldown 直接查 `now - g.updated_at < 30s`，无需新字段。

### 7.2 防无限新建

`create_my_loop` 在节点已有 **N=20** 个 active goals 时拒绝（返 `max_active_goals_reached`）。20 是 Vincent 实际用法的 4x 安全 margin。

### 7.3 Interval 校验复用

`create_my_loop` / `edit_my_loop` 的 `interval` 参数直接喂给 `parseGoalCommand("/loop " + interval + " x")`，复用 #288 的所有校验（60s floor / m/h/d / 拒 30s 等）。**parser 是唯一 interval 真理源**。

### 7.4 防双调度 (④ 核心)

- 所有 self-loop tools 写入只动 `goalStore`
- **agent 不能拿到 SDK 内部 turn loop 的把柄**（claude-agent-sdk SDK 的 `query()` 不暴露 turn-level control 给我们的 tool 层）
- 即使未来 SDK 提供 in-task self-scheduling，anet runtime 层**不接入**（防线: 不导入相关 SDK 接口）
- 文档明写: "**一切循环 = anet goals**; SDK call 是单次任务的执行"

## 8. UX 示例

### 8.1 智能意图理解 (②)

```
User: 这个查邮件循环太频繁了，烦
Agent (内部推理): 
  - 用户对哪个 loop 不满? list_my_loops →
    [check-mail (每 5min), pr-monitor (每 5min), ...]
  - "查邮件" 关键词 → 锁定 check-mail
  - "太频繁" → 调成保守一点, 30m 或 1h 合理
  - LLM 选 30m
Agent → edit_my_loop(goal_id="check-mail", interval="30m")
Agent → User: "好的，已经把查邮件改成每 30 分钟一次了。如果还嫌频繁可以再说。"
```

```
User: 那个 PR 监控的事重要，再多盯着点
Agent → list_my_loops → 找 pr-monitor
Agent → edit_my_loop(goal_id="pr-monitor", interval="2m")
Agent → User: "✓ PR 监控调成每 2 分钟看一次了。"
```

### 8.2 reschedule 范式 (③)

```
[scheduler wakes agent for goal pr-monitor]
Agent: 看 PR #271 状态... 还在 CI, 30min 后再看就够了, 不用 5min 那么紧
Agent → reschedule_my_loop(goal_id="pr-monitor", next_wake_in="30m")
Agent reply: "PR 在跑 CI，30min 后回看（本次推迟）"
```

下次 wake 是 30min 后；再下次回到原 5min interval 节奏。

### 8.3 自决达标即停 (`complete_my_loop` 防死循环)

```
[scheduler wakes for goal monitor-pr-271]
Agent: 看 PR #271 状态 — 已 merged! 任务达标了
Agent → complete_my_loop(goal_id="monitor-pr-271")
Agent reply: "✓ PR #271 已 merge, 监控循环达标完成。"
```

vs 主动放弃:

```
User: 不用监控 PR 了, 切别的优先级了
Agent → cancel_my_loop(goal_id="monitor-pr-271")
Agent reply: "✓ PR 监控已取消（未完成，用户切走）。"
```

两者在 goals.json 留 `status: complete` vs `status: cancelled`, 审计回看清楚分得清。

## 9. 与现有入口共存

三入口 (用户视角):

| 入口 | 谁用 | 何时用 |
|------|------|------|
| `anet node loop <alias> "<task>" --every 5m` (CLI) | 外部操作员 | 批量起 / 脚本化 |
| `/loop <interval> <task>` (inbox slash) | 在 IM / Dashboard 跟 agent 对话的用户 | 显式命令 |
| `create_my_loop` / `edit_my_loop` (self-tool) | agent 自己 | 自然语言对话理解意图后自调 |

三入口最终都写同一个 `goals.json` 通过同一个 `goalStore.upsert()`，**parser 是唯一 interval 校验**，无冲突。

CLI / inbox 的 spec 文字（`docs-site/docs/guide/agent-node.md` 已写）补充: "**agent 也可以自己用工具管理自己的循环**" 一段。

## 10. 实施 phases (待 review 后 impl)

| Phase | 内容 | LOC 估 |
|-------|------|--------|
| P0a | **§3.2 #1 cron-lite schedule field** — AgentGoal 增 `schedule?` 联合类型 (interval/time_of_day/weekday) + scheduler tick 计算 next_wake_at 改造 + parser 扩展接受 wall-clock 表达 | ~120 |
| P0b | `goals/format.ts` (formatSelfLoopsBlock) + processTask 注入 — 自感知 only | ~80 |
| P1 | `goals/self-loop-tools.ts` 共享 specs + claude-agent-sdk adapter — 6 tools (含 ★reschedule + ★complete, 含 §3.2 #2 confirm-back batch guard, 含 §3.2 #4 description 反差措辞) | ~180 |
| P2 | codex-sdk adapter (调研后) | ~80-150 |
| P3 | grok-build-acp adapter | ~50 |
| P4 | 安全防线 (cooldown / max-goals / parser 复用 wiring) + 单测 | ~100 |
| P5 | 端到端 Docker e2e (各 runtime 实测「agent 改自己 loop」流) + **§3.2 #5 多 loop 指代消解 e2e** (3-5 个 loop 状态下「这个/那个/重要的」歧义测) | ~180 |

Total: ~720 LOC, 5-7 working hours impl + 3-4h 测. (上调 from 600 LOC: cron-lite 加 120 + confirm-back 加 30 + multi-loop e2e 加 30)

## 11. Open questions (等 review 拍)

1. **`list_my_loops` 返结构 vs 字符串?** 倾向: 返结构化 `{goals: [...]}`, 让 LLM 自己渲染给 user 看。
2. **`reschedule_my_loop` 跟 `edit_my_loop(interval)` 是否合并?** 倾向: 分开 — `reschedule` 不改 interval 只改 next_wake (一次性 skip-ahead/delay), `edit` 改 interval (周期性). 语义清晰。
3. **paused → active 是否需要重新校验 interval?** 倾向: 不需要, paused 时 interval 没变, 直接复活。
4. **context-injection block 放 system prompt 还是 user-message preamble?** 倾向: system prompt (agent 把它当"我自身状态"而非"用户告诉我"). claude-agent-sdk 走 `systemPrompt` option, codex/grok 各 adapter 自己拼。
5. **20 个 goals 上限是否需 env 可调?** 倾向: 加 `COMMHUB_MAX_GOALS_PER_NODE` env, 默认 20。
6. **§3.2 #1 cron-lite (A) vs 显式拒 (B)?** 倾向 (A) — Vincent 例子「每天9点」太常见, 静默近似太危险, 加 cron-lite 80 LOC 解决一类需求。需 review 拍 (A 增数据模型字段 + scheduler 改, 但收益高).
7. **§3.2 #2 confirm-back 阈值** — 3 次/30s 窗口合理吗? 太严会卡正常批量管理, 太松失去防线意义。
8. **时区处理** — `time_of_day '09:00'` 跟哪个时区对齐? 服务器 TZ / 节点 config 显式声明 / 用户首次设时让 agent 问? 倾向: 节点 config 加 `flags.timezone`, agent create 时落, 工具用此. 默认 `Asia/Shanghai` (Vincent / 团队主时区).

## 12. Non-goals (本 RFC 不涵盖, 留 follow-up)

- **`claude-code-cli` runtime** — 用 CC 原生 /loop (CronCreate / ScheduleWakeup) 自管, 独立 session, 不接 anet self-loop tools (per Vincent §3.1)
- 跨节点 loops 管理 (agent 帮另一个 agent 管 loop) — 复杂权限模型, 留 v0.13+
- Goals 历史/审计可视化 (Dashboard view) — Dashboard team 单独 RFC
- Loop 执行结果归档/检索 (LLM 看过去 N 轮的输出) — `progress_log` 已存, 但访问工具是另一个面
- Multi-agent collaborative loops (一组 agents 共享一个 goal) — 太重, 暂不接

---

**Review checkpoints** (通信龙 + Vincent):
- [ ] ② 智能 — 工具描述足够引导 LLM 做意图理解吗?
- [ ] ③ Claude Code 范式 — `reschedule_my_loop` 抽象抓住 ScheduleWakeup 精髓吗?
- [ ] ④ 防双调度 — 文档/不变式够明确吗? 有 SDK side-channel 风险吗?
- [ ] ⑤ 优雅 — 复用够多吗? 抽象够干净吗?
- [ ] Per-runtime 估工量合理吗? codex 那块需要先 spike?

**ETA**:
- P0 + P1 ship preview3 候选 (4-5h)
- P2-P5 跟 v0.12 一起 (1-2 day)

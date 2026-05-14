# RFC-009: Agent Network 社会学实验 Framework

| 字段 | 值 |
|------|----|
| **RFC 编号** | 009 |
| **标题** | 社会学实验 Framework — round / payoff / cohort / sub-network 通用 protocol |
| **作者** | 通信SDK马 |
| **状态** | Draft v1 |
| **创建日期** | 2026-05-14 |
| **关联 issue** | [#77](https://github.com/sleep2agi/agent-network/issues/77) |
| **关联 demo** | [#72 opinion-spread](../issues/72) · [#74 信息瀑布](../issues/74) |
| **依赖** | RFC-008 multi-agent-team-convention · `BatchOptions` (anet/cli/batch.ts) |
| **审阅** | 通信牛 (技术) · 通信龙 (high-level) · Vincent (final) |

---

## 摘要

Vincent 在 2026-05-14 提出 5 个社会学实验候选 (opinion-spread / 信息瀑布 / 博弈 / 谈判 / 回音室) 作为 anet `batch` primitive 之后的主要应用方向（参见 `project_social_experiment_direction` memory · Vincent 4400 + 4462）。本 RFC 不实施任何 cli.ts 改动，仅设计一个统一 framework：将 5 个实验共有的 *round 协议 / cohort 分组 / payoff 计算 / 子网隔离* 抽出，使后续 demo 通过声明 `SocialExperimentSpec` 即可复用，不必每个 demo 重复实现 multi-agent orchestration。

> 本文采用中文正文，仅 code / API 例子保留英文（per [[feedback_rfc_chinese]]）。

---

## §1 背景与 5 demo 结构 overlap 分析

### 1.1 起源：Vincent 的实验方向

| 时间 | 触发 | 关键决策 |
|------|------|---------|
| 2026-05-14 4400 | "社会学实验 = batch 后续方向" | 列出 5 个候选 (opinion-spread / 博弈 / 信息瀑布 / 谈判 / 回音室) |
| 2026-05-14 4462 | "多搞点社会学实验" | 推动 portfolio scale up |
| 2026-05-14 4464 | "感觉做吧" | 给出 framework approval 信号 |

商业 distribution 路径 3 条（per `project_social_experiment_direction`）：
1. **B 站课程**：每个实验录成一节课
2. **学术合作**：5 个实验皆是经典社会学/经济学课题，可与高校合作 publish
3. **企业咨询**：组织行为学 / 团队动力学 / 群体决策 场景的 anet 应用咨询

### 1.2 5 实验简述

| # | 实验 | 经典原型 | 关键变量 |
|---|------|---------|---------|
| 1 | **opinion-spread** | Asch conformity / DeGroot opinion dynamics | broadcast 多 cohort 的意见演化是否收敛 |
| 2 | **信息瀑布** | Information cascade (Bikhchandani-Hirshleifer-Welch 1992) | 序列化决策中前 N 个 agent 决定后 K 个 agent，cascade lock 真值与否 |
| 3 | **博弈** | Iterated Prisoner's Dilemma / Public Goods Game | 多轮 payoff matrix 演化合作 vs 背叛策略 |
| 4 | **谈判** | Double auction / Buyer-seller bargaining | 买卖双方 turn-based 报价撮合达成交易差价 |
| 5 | **回音室** | Echo chamber / filter bubble | sub-network 隔离信息流动后群体意见两极化 |

### 1.3 5 demo 结构 overlap 矩阵

| 维度 | opinion-spread | 信息瀑布 | 博弈 | 谈判 | 回音室 |
|------|:-:|:-:|:-:|:-:|:-:|
| Multi-agent (≥ 5) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Prompt-driven role | ✅ | ✅ | ✅ | ✅ | ✅ |
| Commhub channel | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Cohort 分组** | 2 (支持/反对) | 1 (顺序 idx 即角色) | 1 (合作/背叛策略演化) | 2 (买/卖) | N (多子网) |
| **Round protocol** | broadcast | sequential | multi-round | turn-based | broadcast within sub-network |
| **Payoff function** | ❌ (统计意见分布) | partial (cascade lock 真值 binary) | ✅ (PD matrix) | ✅ (撮合差价) | ❌ (统计两极化指数) |
| **Sub-network 隔离** | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Leader / 主持人** | optional | optional | optional | optional (撮合者) | optional |
| **Rounds** | 1-3 | 1 | 5-20 | 5-15 | 3-10 |

✅ 行 (前 3 行) = `batch` primitive 已覆盖。
🟡 行 (后 6 行) = framework 待抽。

### 1.4 不抽 framework 的成本估算

假设每个 demo 单独实现：

| Demo | 估算 LOC | 重复开发部分 |
|------|---------|------------|
| opinion-spread | ~250 LOC | broadcast loop + cohort prompt split + 统计 |
| 信息瀑布 | ~280 LOC | sequential trigger + 历史信号汇总 + cascade 判定 |
| 博弈 | ~350 LOC | multi-round + payoff matrix + 历史记录 + 策略演化 tracking |
| 谈判 | ~330 LOC | turn-based + 双 cohort 报价 + 撮合判定 + payoff |
| 回音室 | ~310 LOC | sub-network 构造 + 跨网 ping 屏蔽 + 两极化指数 |
| **合计** | **~1520 LOC** | 4×80% 重复 broadcast/sequential/cohort 框架代码 |

抽 framework 后估算：

| 模块 | 估算 LOC |
|------|---------|
| framework core (`SocialExperimentRunner`) | ~400 LOC |
| 5 demo preset wrappers | ~100 LOC × 5 = ~500 LOC |
| **合计** | **~900 LOC** （节省 ~40%） |

更重要的是 framework 把 *研究复用性* 提高：第 6 个实验（如 DeGroot continuous opinion）只需要 ~80 LOC preset wrapper，不需重写 orchestration。

### 1.5 5 demo 共同抽象

把 5 个实验的执行流统一描述为下面这个 lifecycle：

```text
                  ┌─ [1] Spawn N agents (cohort split + prompt template)
                  │
                  ├─ [2] Setup channels (single / per-cohort / per-sub-network)
                  │
[experiment loop] ├─ [3] Round protocol (4 种 pattern, §3 详)
                  │
                  ├─ [4] Optional payoff calculation (per-round / final)
                  │
                  └─ [5] Result aggregation (cohort-level / individual / network)
```

5 实验在 [3] 和 [4] 上分歧，[1] [2] [5] 形态相近。framework 把分歧点抽成两个回调接口：

```typescript
roundProtocol: "broadcast" | "sequential" | "multi-round" | "turn-based";
payoffFn?: (decisions: Decision[]) => Payoff[];
```

剩下的 `cohorts`、`subNetworks`、`promptTemplate` 都是声明式参数（无回调），可由配置文件驱动。

### 1.6 与 anet 现有 primitive 的关系

| Primitive | 现状 | RFC-009 关系 |
|-----------|------|-------------|
| `anet batch run` | 已有，spawn N agents + broadcast prompt | RFC-009 framework 作为 `batch` 的 *上层* runner，复用 spawn/channel 基础设施 |
| `anet status` | 已有，列出 N 节点状态 | RFC-009 实验运行期间复用 |
| `commhub_send_task` | 已有，agent-to-agent 通信 | RFC-009 所有 round protocol 通过 commhub 实现 |
| `BatchOptions.cohorts?` | demo马 4b4dc31 已提案扩展 (`cohorts` 字段) | RFC-009 framework 把 demo马 扩展正式纳入 spec |
| `RFC-008 multi-agent-team-convention` | 已 merge | RFC-009 沿用 `<prefix>-<idx>` alias 规范 |
| `RFC-003 node telemetry layer` | 已 merge | RFC-009 实验完整事件流写入 telemetry |

### 1.7 §1 小结

5 个社会学实验有 6 维度的 *结构 overlap*（cohort / round / payoff / sub-network / leader / rounds），单独实施会产生 ~40% 的重复代码，且第 N+1 个实验仍需重写 orchestration。本 framework 通过 4 种 `roundProtocol` + 4 个声明字段 + 2 个回调把这些 overlap 抽出，使后续 demo 通过声明 `SocialExperimentSpec` 即可复用。

§2 详述 `SocialExperimentSpec` 的完整 API；§3 详述 4 种 `roundProtocol` 的执行语义；§4 详述 cohort / payoff / sub-network 三组扩展点；§5 给出 Phase 1-3 实施阶梯。

---

## §2 API 规范

### 2.1 顶层入口

framework 通过一个工厂函数 `runSocialExperiment` 暴露：

```typescript
import { runSocialExperiment, SocialExperimentSpec, ExperimentResult }
  from '@sleep2agi/agent-network/experiment';

const spec: SocialExperimentSpec = { /* ... */ };
const result: ExperimentResult = await runSocialExperiment(spec);
```

它在内部按 §3 描述的 `roundProtocol` 调度 `batch run` spawn N 个 agent，按 `cohorts` 定义切片绑定 prompt，按 `payoffFn`（如存在）计算每轮收益，按 `subNetworks`（如存在）隔离 commhub 消息。

### 2.2 `SocialExperimentSpec` 完整接口

```typescript
export interface SocialExperimentSpec {
  /** 实验名（影响 alias 前缀 + telemetry tag） */
  name: string;

  /** Cohort 分组定义（必填，至少 1 个） */
  cohorts: CohortSpec[];

  /** 主持人 alias（optional，e.g. 谈判撮合者 / 博弈裁判） */
  leaderAlias?: string;

  /** Round 协议（必填） */
  roundProtocol: "broadcast" | "sequential" | "multi-round" | "turn-based";

  /** 多轮实验的轮数（multi-round / turn-based 必填，其余 ignore） */
  rounds?: number;

  /** Payoff 计算回调（博弈 / 谈判 / 信息瀑布 必填，其余 optional） */
  payoffFn?: PayoffFn;

  /** 子网定义（回音室 必填，其余 ignore） */
  subNetworks?: NetworkConfig[];

  /** Prompt 模板回调（必填） */
  promptTemplate: PromptTemplate;

  /** 终止条件回调（optional，默认 rounds 跑完即停） */
  terminateFn?: TerminateFn;

  /** 结果聚合回调（optional，默认返回完整 events） */
  aggregateFn?: AggregateFn;

  /** Runtime 选项 */
  runtime?: ExperimentRuntimeOptions;
}
```

### 2.3 `CohortSpec`

```typescript
export interface CohortSpec {
  /** Alias 前缀，e.g. "buyer" → buyer-0, buyer-1, ... */
  prefix: string;

  /** Cohort 内 agent 数量 */
  count: number;

  /** 角色标签，传入 promptTemplate 第 1 参 */
  promptRole: string;

  /** 该 cohort 是否参与 round 决策（默认 true）。设 false 表示纯旁观（如回音室的 observer cohort） */
  participatesInRound?: boolean;

  /** Cohort 级别 metadata，自由 key-value 透传 promptTemplate */
  metadata?: Record<string, unknown>;
}
```

### 2.4 `PromptTemplate`

```typescript
export type PromptTemplate = (
  role: string,
  idx: number,
  ctx: ExperimentContext
) => string | { systemPrompt: string; userPrompt: string };
```

返回值两种形态：
- **`string`** — 直接作为 user message 发给该 agent。
- **`{systemPrompt, userPrompt}`** — 分离 system 与 user，落到 batch primitive `SystemPrompt` 字段。

### 2.5 `ExperimentContext`（promptTemplate 第 3 参）

```typescript
export interface ExperimentContext {
  /** 当前轮号（0-indexed），broadcast 时永远为 0 */
  round: number;

  /** 当前 cohort 的 metadata snapshot */
  cohortMetadata: Record<string, unknown>;

  /** 历史决策（multi-round / sequential / turn-based 时累积） */
  history: Decision[];

  /** 当前 agent 在本 cohort 内的 index（0-indexed） */
  cohortIdx: number;

  /** 整体 agent 全局 idx（跨 cohort，0-indexed） */
  globalIdx: number;

  /** 当前 sub-network id（subNetworks 启用时） */
  subNetworkId?: string;

  /** 当前 agent 可见的 peers alias 集合（受 subNetwork 隔离影响） */
  visiblePeers: string[];

  /** 实验级 metadata（spec.runtime.metadata 透传） */
  experimentMetadata: Record<string, unknown>;
}
```

### 2.6 `Decision` / `Payoff`

```typescript
export interface Decision {
  /** 哪个 agent 做的决策 */
  agentAlias: string;

  /** 第几轮 */
  round: number;

  /** 该 agent 所属 cohort prefix */
  cohort: string;

  /** Agent 输出的决策内容（自由 shape，由 promptTemplate 约束） */
  payload: unknown;

  /** Agent 输出原文（commhub message text） */
  rawText: string;

  /** Decision 落地时间 ISO8601 */
  timestamp: string;
}

export type PayoffFn = (
  decisions: Decision[],
  ctx: PayoffContext
) => Payoff[] | Promise<Payoff[]>;

export interface PayoffContext {
  round: number;
  spec: SocialExperimentSpec;
  history: Decision[][];   // 历史所有轮
}

export interface Payoff {
  agentAlias: string;
  round: number;
  value: number;
  /** Optional 自定义结构（e.g. 谈判中具体成交价 / 博弈对手） */
  meta?: Record<string, unknown>;
}
```

### 2.7 `NetworkConfig`（sub-network 隔离）

```typescript
export interface NetworkConfig {
  /** 子网 ID，e.g. "left-echo" / "right-echo" */
  id: string;

  /** 该子网内的 agent alias 集合（由 framework 按 cohorts 分配，也可手动指定） */
  members?: string[];

  /** 跨子网通信策略 */
  crossNetwork?: "blocked" | "throttled" | "open";

  /** throttled 时的概率 (0.0-1.0)，默认 0.1 */
  throttleProbability?: number;
}
```

详细子网执行语义在 §4。

### 2.8 `TerminateFn` / `AggregateFn`

```typescript
/** 终止条件 — 每轮结束后调用，返回 true 停止实验 */
export type TerminateFn = (
  ctx: { round: number; history: Decision[][]; payoffs: Payoff[][] }
) => boolean;

/** 结果聚合 — 实验结束后调用，返回任意 shape 作为 ExperimentResult.aggregated */
export type AggregateFn = (
  history: Decision[][],
  payoffs: Payoff[][]
) => unknown;
```

### 2.9 `ExperimentRuntimeOptions`

```typescript
export interface ExperimentRuntimeOptions {
  /** 模型选择，per cohort 可覆盖 */
  defaultModel?: string;

  /** Agent runtime: claude-agent-sdk / codex-sdk / mixed */
  runtime?: "claude" | "codex" | "mixed";

  /** Timeout 每轮（ms），默认 120000 */
  roundTimeoutMs?: number;

  /** 自定义 metadata（透传 ExperimentContext.experimentMetadata） */
  metadata?: Record<string, unknown>;

  /** Dry-run，只 spawn 不真跑 */
  dryRun?: boolean;
}
```

### 2.10 `ExperimentResult`

```typescript
export interface ExperimentResult {
  spec: SocialExperimentSpec;
  startedAt: string;
  endedAt: string;
  totalRounds: number;
  agents: Array<{ alias: string; cohort: string; role: string }>;
  history: Decision[][];           // history[round] = decisions in that round
  payoffs: Payoff[][];              // payoffs[round] = payoffs in that round
  aggregated?: unknown;             // aggregateFn 返回值
  telemetry: {
    totalTokens: number;
    cost: number;
    perAgentTokens: Record<string, number>;
  };
}
```

### 2.11 5 demo 各自填充 spec 示例

下面 5 段 *仅 sketch*，完整执行语义 §3-§4 详。

```typescript
// opinion-spread (broadcast + 2 cohort)
const opinionSpec: SocialExperimentSpec = {
  name: "opinion-spread-v1",
  cohorts: [
    { prefix: "pro", count: 5, promptRole: "supporter" },
    { prefix: "con", count: 5, promptRole: "opponent" },
  ],
  roundProtocol: "broadcast",
  promptTemplate: (role, idx, ctx) =>
    `你是${role === "supporter" ? "支持者" : "反对者"}，请就"${ctx.experimentMetadata.topic}"发表 200 字观点`,
};

// 信息瀑布 (sequential)
const cascadeSpec: SocialExperimentSpec = {
  name: "info-cascade-v1",
  cohorts: [{ prefix: "voter", count: 20, promptRole: "voter" }],
  roundProtocol: "sequential",
  promptTemplate: (role, idx, ctx) =>
    `你是第 ${idx+1} 位投票者。前 ${idx} 位投票为：${ctx.history.map(d => d.payload).join(",")}\n请投 A 或 B`,
  payoffFn: (decisions) =>
    decisions.map(d => ({ agentAlias: d.agentAlias, round: d.round,
                          value: d.payload === "A" ? 1 : 0 })),
};

// 博弈 (multi-round + payoff)
const gameSpec: SocialExperimentSpec = {
  name: "ipd-v1",
  cohorts: [{ prefix: "player", count: 6, promptRole: "player" }],
  roundProtocol: "multi-round",
  rounds: 10,
  payoffFn: prisonersDilemmaPayoff,  // 用户自定义
  promptTemplate: ipdPromptTemplate,
};

// 谈判 (turn-based + 2 cohort)
const bargainSpec: SocialExperimentSpec = {
  name: "bargain-v1",
  cohorts: [
    { prefix: "buyer", count: 3, promptRole: "buyer" },
    { prefix: "seller", count: 3, promptRole: "seller" },
  ],
  leaderAlias: "auctioneer",
  roundProtocol: "turn-based",
  rounds: 15,
  payoffFn: doubleAuctionMatch,
  promptTemplate: bargainPromptTemplate,
};

// 回音室 (sub-network)
const echoSpec: SocialExperimentSpec = {
  name: "echo-chamber-v1",
  cohorts: [
    { prefix: "left", count: 5, promptRole: "left-leaning" },
    { prefix: "right", count: 5, promptRole: "right-leaning" },
  ],
  roundProtocol: "broadcast",
  rounds: 5,
  subNetworks: [
    { id: "left-bubble", crossNetwork: "blocked" },
    { id: "right-bubble", crossNetwork: "blocked" },
  ],
  promptTemplate: echoPromptTemplate,
};
```

### 2.12 §2 小结

`SocialExperimentSpec` 是一个 *声明式* 的 spec：必填 5 字段（name/cohorts/roundProtocol/promptTemplate + spec 类型对应的 rounds/payoffFn/subNetworks），可选 4 回调（terminateFn/aggregateFn/PayoffFn 自定义/PromptTemplate 自定义）。

5 个候选实验都能用 *单一文件 spec + ~20-40 LOC promptTemplate + 0-50 LOC payoffFn* 描述完整，不需要碰 framework 内部。

§3 详述 4 种 `roundProtocol` 的实际执行语义和 commhub 消息流。

---

## §3 roundProtocol 4 种 pattern

四种 `roundProtocol` 覆盖了 5 个候选实验的全部调度形态。本节给出每种 pattern 的：
1. **语义**——agent 间的执行顺序与可见性
2. **commhub 消息流**——具体消息序列
3. **终止条件**——默认与可覆盖逻辑
4. **执行伪码**——framework runner 实际实现骨架

### 3.1 `broadcast`

#### 语义

所有 agent 同时收到同一个 prompt（或同结构 prompt + cohort 特定 role），并行思考、并行回复。**单轮**或**多轮**均可。各 agent 之间在该轮内**互不可见**，回复后下一轮可见上一轮所有 decision（`ExperimentContext.history`）。

#### 用例

- **opinion-spread**：所有 supporter / opponent 同时就一个话题表态，多轮迭代观察意见极化或收敛。
- **回音室（内部）**：单个 sub-network 内所有 agent broadcast，但 cross-network 被 §4 描述的隔离规则屏蔽。

#### Commhub 消息流

```
Runner ──── batch.run(N agents) ────────────► [agent-0 ... agent-N-1]
   │                                                     │
   │  ◄──── commhub_send_task(agent-i, prompt-i) ◄──────┘  (并行)
   │                                                     │
   │  ◄──── commhub_reply(agent-i, decision-i) ─────────┘  (并行 reply)
   │
   ▼ collectAll() with roundTimeoutMs
   │
   ▼ payoffFn?.(decisions, ctx) → payoffs[round]
   │
   ▼ terminateFn?.(round, history, payoffs) ? STOP : round++
```

#### 终止条件

- 默认：完成 `spec.rounds` 后 STOP（broadcast 中 rounds 默认 1）。
- 自定义 `terminateFn`：如 opinion-spread 检测连续 2 轮意见无变化即收敛 STOP。

#### 执行伪码

```typescript
async function runBroadcast(spec: SocialExperimentSpec, runner: Runner) {
  const agents = spawnAllAgents(spec);
  const history: Decision[][] = [];
  const payoffs: Payoff[][] = [];

  for (let round = 0; round < (spec.rounds ?? 1); round++) {
    // Round-level promise: 并行 send + reply
    const decisions = await Promise.all(agents.map(async (a) => {
      const ctx = buildContext(round, a, history);
      const prompt = spec.promptTemplate(a.role, a.cohortIdx, ctx);
      return await runner.sendAndAwait(a.alias, prompt, spec.runtime.roundTimeoutMs);
    }));

    history.push(decisions);
    payoffs.push(spec.payoffFn ? await spec.payoffFn(decisions, { round, spec, history }) : []);

    if (spec.terminateFn?.({ round, history, payoffs })) break;
  }

  return finalizeResult(spec, agents, history, payoffs);
}
```

#### 与 batch primitive 的关系

`broadcast` 本质上是 `anet batch run` 多次调用，每轮把上一轮 decisions 作为 prompt 上下文塞入。framework 复用现有 batch spawn/teardown，仅增加 *轮间收集 + payoff + history 注入* 逻辑（~80 LOC）。

---

### 3.2 `sequential`

#### 语义

agent **一个一个地**串行决策。第 `i` 个 agent 可见 `agent-0 ... agent-{i-1}` 的全部 decisions（即历史 prefix）。**通常单轮**（rounds=1），但可以多轮迭代相同 sequence。

#### 用例

- **信息瀑布**：第 1 个投票者凭私有信息投票；第 N 个投票者看见前 N-1 个的投票后决策；研究 cascade lock 真值是否发生。
- **传话游戏（变体）**：第 i 个 agent 接收第 i-1 个的输出作为输入。

#### Commhub 消息流

```
Runner ──── send-task(agent-0, prompt) ────────► agent-0
   │  ◄──── reply(decision-0) ────────────────────┘
   │
   ▼  send-task(agent-1, prompt + history=[d0]) ─► agent-1
   │  ◄──── reply(decision-1) ────────────────────┘
   │
   ▼  send-task(agent-2, prompt + history=[d0,d1]) ─► agent-2
   ... (顺序，每步 await 前一步)
```

#### 终止条件

- 默认：序列跑完即停（无 multi-round 时 rounds=1）。
- 自定义 `terminateFn`：信息瀑布常用"连续 K 个 agent 选同一个则 cascade 已 lock，提前 STOP 节省 token"。

#### 执行伪码

```typescript
async function runSequential(spec: SocialExperimentSpec, runner: Runner) {
  const agents = spawnAllAgents(spec);
  const history: Decision[][] = [[]];      // 单轮 sequential，history[0] 累积
  const payoffs: Payoff[][] = [[]];

  for (let i = 0; i < agents.length; i++) {
    const a = agents[i];
    const ctx = buildContext(0, a, history, { globalIdx: i });
    const prompt = spec.promptTemplate(a.role, a.cohortIdx, ctx);
    const decision = await runner.sendAndAwait(a.alias, prompt, spec.runtime.roundTimeoutMs);
    history[0].push(decision);

    if (spec.payoffFn) {
      const newPayoffs = await spec.payoffFn([decision], { round: 0, spec, history });
      payoffs[0].push(...newPayoffs);
    }

    if (spec.terminateFn?.({ round: 0, history, payoffs })) break;
  }

  return finalizeResult(spec, agents, history, payoffs);
}
```

#### 注意事项

- `sequential` **不能与多个 cohort `participatesInRound: true` 同时使用**——执行顺序由 `cohorts` 数组顺序 + cohort 内 idx 顺序决定，多 cohort 容易产生顺序歧义。若必须，建议使用 `turn-based`。

---

### 3.3 `multi-round`

#### 语义

所有 agent 参与，每轮像 broadcast 一样**并行决策**，但**轮数为关键变量**（typically 5-50 轮）。**每轮结束计算 payoff**，agent 在下一轮 prompt 可见自己与对手的历史 decisions + payoffs。本质上是 `broadcast × rounds + payoff per round`。

#### 用例

- **博弈（Iterated Prisoner's Dilemma / Public Goods）**：每轮每个 player 选择合作 / 背叛，根据双方选择计算 payoff，多轮迭代观察策略演化。
- **演化博弈**：可加上"每 K 轮淘汰末位 + 复制策略"逻辑（通过 `terminateFn` 与 `aggregateFn` 扩展）。

#### Commhub 消息流

```
[Round 0]  Runner ────► all agents 并行 ────► reply ────► payoffFn → payoff[0]
[Round 1]  Runner ────► all agents 并行(prompt 含 history+payoff[0..]) ────► payoff[1]
[Round 2]  ...
... (rounds 次)
[Final]    aggregateFn(history, payoffs) → ExperimentResult.aggregated
```

#### 终止条件

- 默认：跑满 `spec.rounds`（必填）。
- 自定义：如博弈中"全合作 STOP"或"全背叛 STOP"。

#### 执行伪码

```typescript
async function runMultiRound(spec: SocialExperimentSpec, runner: Runner) {
  if (!spec.rounds) throw new Error("multi-round requires rounds");
  if (!spec.payoffFn) throw new Error("multi-round requires payoffFn");

  const agents = spawnAllAgents(spec);
  const history: Decision[][] = [];
  const payoffs: Payoff[][] = [];

  for (let round = 0; round < spec.rounds; round++) {
    const decisions = await Promise.all(agents.map(async (a) => {
      const ctx = buildContext(round, a, history, { payoffsHistory: payoffs });
      const prompt = spec.promptTemplate(a.role, a.cohortIdx, ctx);
      return await runner.sendAndAwait(a.alias, prompt, spec.runtime.roundTimeoutMs);
    }));

    history.push(decisions);
    const roundPayoffs = await spec.payoffFn(decisions, { round, spec, history });
    payoffs.push(roundPayoffs);

    if (spec.terminateFn?.({ round, history, payoffs })) break;
  }

  return finalizeResult(spec, agents, history, payoffs);
}
```

#### 与 broadcast 的差异

`multi-round` = `broadcast` + 强制 `payoffFn` + 默认 rounds ≥ 2。从实现角度可视为 `broadcast` 的特化，但 spec 显式区分使得 promptTemplate 与 payoffFn 的语义更清晰（防止 broadcast 调用者忘记设 rounds 或 payoffFn）。

---

### 3.4 `turn-based`

#### 语义

多 cohort 轮流出招，每轮内每个 cohort 内部并行；轮内 *cohort 之间* 串行，cohort 内 *agent 之间* 并行。可选 `leaderAlias` 作为撮合者 / 裁判，在轮间执行匹配 / 仲裁逻辑。

#### 用例

- **谈判（Double Auction）**：buyer cohort 与 seller cohort 轮流报价，`leaderAlias = auctioneer` 在每轮撮合可成交对，更新成交价。
- **辩论赛**：pro / con 双方轮流陈述，judge 最终裁决。
- **棋类 1v1**：每个 cohort 1 个 agent 时退化为标准回合制。

#### Commhub 消息流

```
[Round 0]
  ▼ cohort[0] = buyer: 并行 send → buyer-0..buyer-{m-1} reply
  ▼ cohort[1] = seller: 并行 send (prompt 含 buyers 报价) → seller-0..seller-{n-1} reply
  ▼ leaderAlias=auctioneer: send (prompt 含 all buyer+seller 报价) → match decision
  ▼ payoffFn(buyer_decisions + seller_decisions + auctioneer_match)
[Round 1] (剔除已成交对, 余下继续)
  ...
```

#### 终止条件

- 默认：跑满 `spec.rounds`。
- 自定义：谈判常用"全部 buyer-seller pair 成交 STOP" 或 "K 轮无新成交 STOP"。

#### 执行伪码

```typescript
async function runTurnBased(spec: SocialExperimentSpec, runner: Runner) {
  if (!spec.rounds) throw new Error("turn-based requires rounds");
  if (spec.cohorts.length < 2) throw new Error("turn-based requires ≥ 2 cohorts");

  const agents = spawnAllAgents(spec);
  const leader = spec.leaderAlias ? await runner.spawnLeader(spec.leaderAlias) : null;
  const history: Decision[][] = [];
  const payoffs: Payoff[][] = [];

  for (let round = 0; round < spec.rounds; round++) {
    const roundDecisions: Decision[] = [];

    // cohort 间串行
    for (const cohort of spec.cohorts) {
      if (cohort.participatesInRound === false) continue;
      const cohortAgents = agents.filter(a => a.cohort === cohort.prefix);

      // cohort 内并行
      const cohortDecisions = await Promise.all(cohortAgents.map(async (a) => {
        const ctx = buildContext(round, a, history, { currentCohort: cohort, roundDecisions });
        const prompt = spec.promptTemplate(a.role, a.cohortIdx, ctx);
        return await runner.sendAndAwait(a.alias, prompt, spec.runtime.roundTimeoutMs);
      }));

      roundDecisions.push(...cohortDecisions);
    }

    // leader 仲裁 (optional)
    if (leader) {
      const ctx = buildContext(round, leader, history, { roundDecisions });
      const prompt = spec.promptTemplate("leader", 0, ctx);
      const leaderDecision = await runner.sendAndAwait(leader.alias, prompt, spec.runtime.roundTimeoutMs);
      roundDecisions.push(leaderDecision);
    }

    history.push(roundDecisions);
    const roundPayoffs = spec.payoffFn ? await spec.payoffFn(roundDecisions, { round, spec, history }) : [];
    payoffs.push(roundPayoffs);

    if (spec.terminateFn?.({ round, history, payoffs })) break;
  }

  return finalizeResult(spec, agents, history, payoffs);
}
```

#### Cohort 顺序定义

`spec.cohorts` 数组中的顺序就是每轮内 cohort 出招顺序。如要倒序或随机，由调用方 reorder 数组或扩展 `roundProtocol` 子选项（v2 candidate）。

---

### 3.5 4 pattern 对照速查

| Pattern | 并行/串行 | rounds | payoffFn | leader | 典型用例 |
|---------|----------|--------|----------|--------|---------|
| `broadcast` | 全并行 | optional (默认 1) | optional | optional | opinion-spread |
| `sequential` | 全串行 | 通常 1 | optional | rarely | 信息瀑布 |
| `multi-round` | 轮内并行 / 轮间串行 | 必填 | 必填 | optional | 博弈 |
| `turn-based` | cohort 间串行 / cohort 内并行 | 必填 | 通常必填 | 通常必填 | 谈判 |

### 3.6 §3 小结

4 种 `roundProtocol` 覆盖 5 实验的全部 orchestration 形态；执行伪码总长 ~150 LOC，加 runner.sendAndAwait + spawnAllAgents 公共底座 ~80 LOC，合计 framework core ~230 LOC（与 §1.4 估算的 ~400 LOC core 留有 buffer 给 sub-network 实现）。

§4 详述 cohort 切分算法、payoff 执行上下文、sub-network 隔离的 commhub-level 实现。

---

## §4 cohort / payoff / sub-network 设计

本节详述 §2 已声明、§3 已引用的三组扩展点的具体设计。

### 4.1 Cohort 切分算法

#### 4.1.1 Alias 分配

给定 `spec.cohorts = [{ prefix: "P1", count: 5 }, { prefix: "P2", count: 3 }]`，framework 生成 8 个 agent alias：

```
P1-0 P1-1 P1-2 P1-3 P1-4   P2-0 P2-1 P2-2
```

规则：
- Alias 形式 `<prefix>-<cohort-local-idx>`，cohort-local-idx 从 0 开始。
- *全局* idx 按 cohorts 数组顺序 + cohort 内 idx 顺序展开（上例 P1-0..P1-4 全局 idx = 0..4，P2-0..P2-2 = 5..7）。
- alias 必须在 anet 网络内全局唯一，framework 调用 `commhub_get_all_status()` 校验冲突，冲突时 fail-fast。
- 跨实验执行（同一 `name`）alias 复用，由 framework 维护 `experiment_id` 命名空间隔离（详 4.1.5）。

#### 4.1.2 Spawn 流程

```typescript
// framework 内部
async function spawnAllAgents(spec: SocialExperimentSpec): Promise<AgentHandle[]> {
  const handles: AgentHandle[] = [];
  let globalIdx = 0;

  for (const cohort of spec.cohorts) {
    for (let i = 0; i < cohort.count; i++) {
      const alias = `${cohort.prefix}-${i}`;
      const handle = await runner.spawnAgent({
        alias,
        runtime: cohort.metadata?.runtime ?? spec.runtime?.runtime ?? "codex",
        model: cohort.metadata?.model ?? spec.runtime?.defaultModel,
        experimentId: spec.runtime?.metadata?.experimentId,
      });
      handles.push({ ...handle, cohort: cohort.prefix, role: cohort.promptRole, cohortIdx: i, globalIdx: globalIdx++ });
    }
  }
  return handles;
}
```

底层调用 `anet batch run` 已有的 spawn 能力，framework 仅追加 metadata（cohort/role/experimentId）。

#### 4.1.3 Cohort metadata 透传

`CohortSpec.metadata` 是任意 key-value，会同时进入：
- **`ExperimentContext.cohortMetadata`**——promptTemplate 第 3 参可读，用于在 prompt 中注入 cohort 特定常量（如博弈中 "你是合作型策略" / "你是背叛型策略"）。
- **Telemetry tag**——RFC-003 telemetry 事件携带 `cohort`, `cohort_metadata` 字段，便于后续查询"哪个 cohort 的 token 消耗最多 / 决策耗时最长"。

#### 4.1.4 `participatesInRound` 语义

若 `cohort.participatesInRound === false`：
- 该 cohort agent **仍 spawn**，**仍 接收 prompt**（用于初始化），但 *不计入* round payoff 计算的 decisions 列表。
- 用例：回音室中"observer cohort"——负责观察 left-bubble + right-bubble 后做综合判断，但不投票。
- 用例：博弈中"audience cohort"——只看不下场，结束时给出评论。

#### 4.1.5 `experiment_id` 命名空间

framework 在 `runSocialExperiment` 入口生成 `experiment_id = <name>-<unix_ms>-<rand_hex_4>`，注入：
- alias prefix：实际 commhub alias 为 `<experiment_id>::<prefix>-<idx>`（双冒号分隔，避免单 dash 冲突），UI 默认隐藏 prefix 显 `<prefix>-<idx>`。
- spec.runtime.metadata.experimentId：透传至 promptTemplate 与 telemetry。

这样同一节点上 *并行* 跑两个 opinion-spread 实验不会 alias 冲突。

### 4.2 Payoff 执行模型

#### 4.2.1 调用时机

- **broadcast**：每 round 结束后调用（若 payoffFn 存在），传入该轮的 decisions。
- **sequential**：每个 agent decision 后调用（增量），传入仅该单步 decision。
- **multi-round**：每 round 结束后调用（必填），传入该轮全部 decisions。
- **turn-based**：每 round 结束后调用（含 leader 决策），传入该轮全部 decisions（含 leader）。

#### 4.2.2 同步 / 异步

`PayoffFn` 返回 `Payoff[] | Promise<Payoff[]>`。framework 永远 await：

```typescript
const roundPayoffs = await Promise.resolve(spec.payoffFn(decisions, ctx));
```

异步场景：payoff 需调用外部服务（如真实股价 API 回测博弈对照），或需 LLM 评分（如谈判中"公平度评分"由独立 judge agent 给出）。

#### 4.2.3 Decision payload schema 约束

`Decision.payload` 是 `unknown`，由 promptTemplate 与 payoffFn 之间约束。建议两种模式：

**模式 A — 自由文本 + 后置解析（推荐入门）**

```typescript
promptTemplate: () => "请回答 A 或 B，仅输出单个字母",
payoffFn: (decisions) => decisions.map(d => ({
  ...,
  value: parseAB(d.rawText),  // 简单解析
}))
```

**模式 B — 结构化 outputSchema**

利用 anet `batch run` 已有的 `outputSchema` 字段（per RFC-002）让 agent 输出 JSON：

```typescript
promptTemplate: () => ({
  systemPrompt: "...",
  userPrompt: "...",
  outputSchema: { type: "object", properties: { choice: { enum: ["A", "B"] } } },
}),
payoffFn: (decisions) => decisions.map(d => ({
  ...,
  value: (d.payload as { choice: string }).choice === "A" ? 1 : 0,
}))
```

framework 不强制选哪种，但在 `dryRun` 模式下会做静态校验（promptTemplate 返回 outputSchema → payoffFn 参数类型 hint）。

#### 4.2.4 错误处理

- `payoffFn` 抛错：framework 默认 *fail-fast* STOP 实验，错误进入 `ExperimentResult.error`。
- 自定义 `errorPolicy: "continue" | "fail-fast"` 在 `spec.runtime` 中可覆盖（v1 默认 fail-fast，v2 候选 continue 选项）。
- 单个 agent reply 超时：跳过该 agent，对应 decision 标记 `{ payload: null, rawText: "<timeout>" }`，payoffFn 自行决定如何处理。

#### 4.2.5 Payoff 历史可见性

`PayoffContext.history` 是历史 *decisions* 二维数组（`history[round]`），但 framework 还会在 promptTemplate 的 `ExperimentContext.payoffsHistory`（可选 expose）中给出历史 payoffs，让 agent 在 prompt 中可见自己的累积收益。是否暴露由 `spec.runtime.exposePayoffsToAgents`（默认 `true`）控制。

### 4.3 Sub-network 隔离

#### 4.3.1 子网模型

`spec.subNetworks` 数组每一项定义一个 *逻辑子网*：

```typescript
{
  id: "left-echo",
  members: ["left-0", "left-1", ..., "left-4"],   // 显式或 framework 按 cohorts 推导
  crossNetwork: "blocked" | "throttled" | "open",
  throttleProbability: 0.1,
}
```

#### 4.3.2 Members 推导默认

若 `members` 未指定，framework 按 1-to-1 映射 `cohorts ↔ subNetworks`：
- `subNetworks[0]` = `cohorts[0]` 全员
- `subNetworks[1]` = `cohorts[1]` 全员
- ……

若 cohort 数 ≠ subNetwork 数，必须显式指定 members；否则 fail-fast。

#### 4.3.3 隔离实现 — `visiblePeers` 过滤

framework 在每次 promptTemplate 调用前计算 `ExperimentContext.visiblePeers`：

```typescript
function computeVisiblePeers(agent: AgentHandle, spec: SocialExperimentSpec): string[] {
  if (!spec.subNetworks) return allAgents.map(a => a.alias);

  const agentNetwork = findNetworkOf(agent, spec.subNetworks);
  const peers: string[] = [];

  for (const a of allAgents) {
    if (a.alias === agent.alias) continue;
    const aNetwork = findNetworkOf(a, spec.subNetworks);

    if (aNetwork.id === agentNetwork.id) {
      peers.push(a.alias);  // 同网总是可见
    } else if (agentNetwork.crossNetwork === "open") {
      peers.push(a.alias);
    } else if (agentNetwork.crossNetwork === "throttled" &&
               Math.random() < (agentNetwork.throttleProbability ?? 0.1)) {
      peers.push(a.alias);  // 概率性可见
    }
    // "blocked" → skip
  }
  return peers;
}
```

#### 4.3.4 隔离实现 — history 过滤

`ExperimentContext.history`（broadcast / multi-round 用）也按 `visiblePeers` 过滤：agent 仅看到 *自己网内 + 跨网允许* 的 peers 历史决策。

```typescript
const filteredHistory = history.map(round =>
  round.filter(d => visiblePeers.includes(d.agentAlias) || d.agentAlias === agent.alias)
);
```

#### 4.3.5 隔离实现 — commhub-level 屏蔽（v2）

v1 仅在 *prompt 上下文* 层面隔离（即 agent 看不到对网信息）。v2 候选：在 commhub-level *拒绝* cross-network 的 `send_task` / `send_message` 调用（防止 agent 主动越界）。v2 需 commhub server 增加 *network 标签* 字段，留待 RFC-009 v2 amend。

#### 4.3.6 用例：回音室

```typescript
const echoSpec: SocialExperimentSpec = {
  name: "echo-chamber",
  cohorts: [
    { prefix: "left", count: 5, promptRole: "left-leaning" },
    { prefix: "right", count: 5, promptRole: "right-leaning" },
    { prefix: "observer", count: 2, promptRole: "neutral-observer", participatesInRound: false },
  ],
  roundProtocol: "broadcast",
  rounds: 5,
  subNetworks: [
    { id: "left-bubble", crossNetwork: "blocked" },     // members 默认 cohorts[0]
    { id: "right-bubble", crossNetwork: "blocked" },    // members 默认 cohorts[1]
    { id: "neutral", crossNetwork: "open" },             // observer 全可见
  ],
  promptTemplate: (role, idx, ctx) =>
    `你是${role}。本轮可见前轮 ${ctx.history.flat().filter(d => ctx.visiblePeers.includes(d.agentAlias)).length} 个观点。请就 X 表态。`,
};
```

执行效果：left bubble 内 5 个 agent 仅相互可见、right bubble 仅相互可见、observer 全可见。5 轮后两 bubble 内意见极化指数显著高于 baseline broadcast 单网络。

### 4.4 Telemetry & 可观察性

framework 调用 RFC-003 telemetry layer 写入 4 类事件：

| 事件 | 触发 | 字段 |
|------|------|------|
| `experiment.started` | runSocialExperiment 入口 | experiment_id, spec 摘要, cohort 数, 总 agent 数 |
| `round.completed` | 每轮结束 | round, decisions 数, payoffs 合计, 用时 ms |
| `agent.decided` | 每个 decision | agent_alias, cohort, payload preview, tokens, latency |
| `experiment.finished` | runSocialExperiment 出口 | total_rounds, total_tokens, total_cost, aggregated 摘要 |

R415 dashboard 已有 telemetry 消费基础，无需额外改动。

### 4.5 §4 小结

cohort 切分 = `<prefix>-<idx>` + `experiment_id` 命名空间；payoff 同步异步均支持，dryRun 静态校验 schema；sub-network v1 在 prompt 上下文层隔离（visiblePeers + filteredHistory），v2 候选 commhub-level 屏蔽。

§5 给出 Phase 1-3 实施 ladder 与 5 demo 迁移顺序。

---

## §5 实施 Phase ladder

> 🚧 待 R464+ /loop tick 推进

---

## 附录

### A. 5 demo issue 链接

- [#72 opinion-spread](https://github.com/sleep2agi/agent-network/issues/72)
- [#74 信息瀑布](https://github.com/sleep2agi/agent-network/issues/74)
- 博弈 / 谈判 / 回音室 issue 待开

### B. 引用

- Asch, S. E. (1956). Studies of independence and conformity.
- Bikhchandani, S., Hirshleifer, D., & Welch, I. (1992). A Theory of Fads, Fashion, Custom, and Cultural Change as Informational Cascades. *J. Political Economy.*
- DeGroot, M. H. (1974). Reaching a consensus. *JASA.*
- Axelrod, R. (1984). *The Evolution of Cooperation.*
- Sunstein, C. R. (2017). *#Republic: Divided Democracy in the Age of Social Media.*
- demo马 commit `4b4dc31` — BatchOptions.cohorts? 扩展提案

### C. 变更记录

| 版本 | 日期 | 作者 | 说明 |
|------|------|------|------|
| Draft v1 §1 | 2026-05-14 | 通信SDK马 | 初稿 §1（背景 + 5 demo overlap 矩阵），§2-§5 stub 待续 |

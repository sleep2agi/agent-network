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

> 🚧 待 R462+ /loop tick 推进

---

## §4 cohort / payoff / sub-network 设计

> 🚧 待 R463+ /loop tick 推进

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

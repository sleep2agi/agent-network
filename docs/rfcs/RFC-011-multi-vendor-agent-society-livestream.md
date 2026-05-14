# RFC-011: 多厂商 AI Agent 社会 — 24/7 直播观察涌现社会行为

| 字段 | 值 |
|------|----|
| **RFC 编号** | 011 |
| **标题** | 多厂商 AI Agent 社会 — 24/7 直播 + 自动导演 + 解说，观察涌现社会行为 |
| **作者** | 通信SDK马 |
| **状态** | Draft v1 完整就绪（待 review） |
| **创建日期** | 2026-05-15 |
| **关联 issue** | [#107](https://github.com/sleep2agi/agent-network/issues/107)（umbrella 愿景，Vincent 4693-4696） |
| **依赖** | RFC-009 社会学实验 Framework（本 RFC 是其扩展应用） |
| **硬前提（gate）** | #101 #102 真验证通过 · DeepSeek/GLM vendor 验证加回 VENDORS registry |
| **关联** | RFC-008 multi-agent-team-convention · #72 社会学实验 umbrella · #96 节点视觉身份 · #99 守护节点 · #100 #106 Chat 浮窗 |
| **呈现层协作** | N站马（dashboard surface：ticker / 自动聚焦 / 浮窗复用） |
| **审阅** | 通信龙（high-level）· N站马（呈现层）· Vincent（final） |

---

## 摘要

Vincent 2026-05-14（telegram 4693-4696）提出愿景：把多个厂商的 AI Agent（如 5×DeepSeek + 5×MiniMax + 5×GLM + 书生 / 小米 等）全部跑起来组成一个 **agent 社会**，**24/7 直播**，观察它们涌现的**社会行为**，产出 B 站内容 / 学术观察 / 咨询案例（per `project_social_experiment_direction`）。Vincent 反复强调：**呈现形式一定要好**。

本 RFC 把 [#107](https://github.com/sleep2agi/agent-network/issues/107) body 的方案 sketch 发展成完整设计。**本 RFC 不实施任何代码改动**，仅出设计。核心论点：24/7 直播的灵魂不是静态拓扑图，而是 **「自动导演 + 解说」** —— 一套自动检测热点、自动聚焦镜头、并由一个「解说 agent」实时旁白的呈现层，把「一堆 agent 在跑」变成「可看的涌现 AI 社会真人秀」。

> 本文采用中文正文，仅 code / API 例子保留英文（per [[feedback_rfc_chinese]]）。

> ⚠️ **这是一个 gated 愿景，不是现在能直接实施的。** 见 §1.2 依赖链 —— RFC 是设计，实施排在硬前提满足之后。

---

## §1 愿景与依赖链

### 1.1 愿景拆解

| 维度 | 内容 |
|------|------|
| **主体** | 多厂商混合的 agent 群体（DeepSeek / MiniMax / GLM / 书生 / 小米 …），每厂商 N 个节点 |
| **行为** | agent 之间通过 commhub 自由互动（派任务 / 发消息 / 协作 / 博弈），在 RFC-009 实验框架设定下运行 |
| **观察对象** | **涌现社会行为** —— 观点传播、共识形成、极化、联盟、僵局、级联、说服 |
| **呈现** | 24/7 直播，自动导演 + 解说，呈现形式「一定要好」 |
| **产出** | B 站内容 / 学术观察 / 咨询案例（三 distribution） |

「多厂商」是关键设计选择：同质 agent 群体行为单调；不同厂商的模型有不同的「性格」（推理风格、合作倾向、表达方式），混合群体才有真正可观察的社会动力学，也才有内容看点（「DeepSeek 阵营 vs GLM 阵营」）。

### 1.2 依赖链（关键 —— 不是现在能直接做的）

```
[硬前提 P0] #101 #102 — agents 能真互动
  agents 必须能主动用 web 工具 (#101) + commhub 工具 (#102)，
  否则只能被动回话 = 没有社会行为可观察，整个愿景落空。
  现状: fix 已发 agent-node 2.3.3 / 2.3.4-preview，但尚未真验证通过
        （需测试马端到端验：claude-agent-sdk 节点真能 WebFetch + 主动 commhub_send_task）
        ↓
[前置 P1] DeepSeek / GLM vendor 验证
  #104-B 把未验证的 deepseek / glm / kimi 移出了 VENDORS registry。
  要做「5×DeepSeek + 5×GLM」必须先 real-call 验证它们的 base URL + model id，
  再加回 VENDORS registry（[[feedback_vendor_verify_before_hardcode]] 硬规矩）。
        ↓
[组社会 P2] 多厂商混合 batch + 实验设定
  batch primitive 已有（anet create --batch，#104-B 后走 VENDORS registry）。
  需要：跨厂商混合 batch（一个 batch 内多 vendor）+ 接 RFC-009 实验框架。见 §3。
        ↓
[呈现层 P2] 自动导演 + 解说 — 本 RFC 的灵魂
  见 §2 / §4。
        ↓
[接流 P3] 24/7 livestream infra
  OBS / 流媒体 + 长跑稳定性。见 §5。
```

### 1.3 硬前提的 RFC 含义

本 RFC 的 §2-§6 是**设计**，可以现在就写、现在就 review。但**实施严格 gate**：

1. **§3（多厂商 batch）实施 gate 在**：#101/#102 验证通过 + DeepSeek/GLM 加回 registry。在此之前，跨厂商 batch 即使能起，agent 也不能真互动，社会行为无从谈起。
2. **§2/§4（呈现层）的设计可独立推进**，但其「数据源」（SSE 事件流、agent 互动事件）依赖一个真在互动的 agent 社会存在 —— 即依赖 §3。
3. 因此实施顺序天然是：前提满足 → §3 → §2/§4 → §5。本 RFC §6 phasing 据此排定。

> 把这条写在 RFC 开头，是为了避免「RFC 通过 = 可以开做」的误解。RFC-011 通过只代表**设计方向获批**，实施触发条件是依赖链解锁。

### 1.4 与 RFC-009 的关系

RFC-011 是 **RFC-009 社会学实验 Framework 的扩展应用**，不是替代：

- RFC-009 提供：`SocialExperimentSpec` / round 协议 / cohort 分组 / payoff / sub-network —— 「实验怎么设定和跑」
- RFC-011 增加：**多厂商 cohort 维度** + **呈现层**（ticker / 自动导演 / 解说 / 指标面板）—— 「实验怎么被观察和呈现」

RFC-011 不改 RFC-009 的 API；它在 RFC-009 的 `CohortSpec` 上增加一个 `vendor` 维度（见 §3），并把 RFC-009 已有的 round/payoff/telemetry 抽象作为呈现层的数据源。

### 1.5 §1 小结

愿景成立的前提是「agent 能真互动」（#101/#102）和「目标厂商已验证」（DeepSeek/GLM）。本 RFC 设计可先行，实施 gated。RFC-011 = RFC-009 + 多厂商维度 + 呈现层。

---

## §2 呈现层设计

Vincent 反复强调「呈现形式一定要好」—— §2 是本 RFC 的核心。核心论点已在摘要点出：**24/7 直播的灵魂是「自动导演 + 解说」**。本节设计 4 个呈现组件，并定义它们共同依赖的 **事件流抽象**。

> ⚠️ §2 涉及 dashboard 的具体实现（组件挂载、SSE 复用、浮窗逻辑），这些是 N站马 的 surface。本节给出**设计意图与数据契约**；标注 `[N站马 输入]` 的地方需要 N站马 确认可行性与实现细节。

### 2.1 共同基础：`SocietyEvent` 事件流

4 个呈现组件（ticker / 自动聚焦 / 解说 / 指标面板）不各自去 scrape 数据，而是共享一条**规范化事件流** `SocietyEvent`。这是呈现层的数据契约 —— 上游产生事件，下游 4 个组件各自消费。

```typescript
// 呈现层的统一事件抽象。由 commhub SSE + RFC-009 round/payoff telemetry
// 归一化而来；4 个呈现组件都消费它，互不耦合。
interface SocietyEvent {
  ts: number;                      // epoch ms
  kind:
    | "task_sent"                  // agent → agent 派任务
    | "message_sent"               // agent → agent 发消息
    | "task_replied"               // 子任务返回 reply
    | "status_changed"             // agent working/idle/blocked/error
    | "round_started" | "round_ended"   // RFC-009 round 边界
    | "payoff_updated"             // RFC-009 payoff 变化
    | "opinion_shifted"            // 派生事件：某 agent 观点翻转（见 §4）
    | "node_down" | "node_recovered";   // 24/7 稳定性（见 §5）
  from?: string;                   // 发起 agent alias
  to?: string;                     // 目标 agent alias
  vendor?: string;                 // from 节点的 vendor（多厂商维度，见 §3）
  summary: string;                 // 一句话摘要（用于 ticker / 喂解说）
  payload?: unknown;               // kind-specific 细节
  experimentId?: string;           // 关联的 RFC-009 实验
}
```

**数据来源**：
- `commhub SSE`（已有）→ task_sent / message_sent / task_replied / status_changed
- `RFC-009 telemetry`（RFC-009 §4.4 已设计 round/payoff 可观察性）→ round_* / payoff_updated
- **派生层**（本 RFC 新增，见 §4）→ opinion_shifted 等「热点事件」由事件检测器从原始事件流计算得出
- `守护节点`（#99）→ node_down / node_recovered

> 设计约束：`SocietyEvent` 必须是**只读派生视图**，不改 commhub / RFC-009 的任何写路径 —— 纯消费。这保证呈现层是可选 add-on，不碰核心业务逻辑。

### 2.2 组件 1：活动 ticker（易）

屏幕一侧实时滚动「谁 → 谁 发了什么」。最简单的组件，直接消费 `SocietyEvent` 流。

| 项 | 设计 |
|----|------|
| 数据源 | `SocietyEvent` where kind ∈ {task_sent, message_sent, task_replied} |
| 渲染 | 一行一事件：`[时间] <vendor图标> from → to : summary`（vendor 图标复用 #96 厂商 LOGO） |
| 容量 | 滚动窗口保留最近 N 条（建议 50），更早的滚出 |
| 实现 | `[N站马 输入]` dashboard 加一个 ticker 组件，复用现有 SSE 连接，不新开连接 |

ticker 是「直播有在动」的最低保证 —— 即使自动导演没检测到热点，观众也能看到底层活动在流动。

### 2.3 组件 2：自动聚焦（中）

检测「热点」→ 镜头自动怼上去。这是「自动导演」的执行端（热点**检测**算法在 §4，本节只管检测到之后**怎么聚焦**）。

| 项 | 设计 |
|----|------|
| 输入 | §4 热点检测器输出的 `HotspotEvent`（带 focus target：一组 agent + 一个事件窗口） |
| 动作 | 主画面镜头移动 / 缩放到 target agent 群；可选自动打开 target 之间的 Chat 浮窗（复用 #100/#106） |
| 退场 | 热点「冷却」后（一段时间无新事件）镜头拉回全局拓扑视图 |
| 防抖 | 最小聚焦时长（建议 15-30s），避免镜头乱跳；同时只聚焦 1 个热点，多热点排队 |
| 实现 | `[N站马 输入]` 镜头移动 = 拓扑图 viewport 动画；浮窗复用 #100/#106 的打开逻辑 |

> 「自动聚焦」与「自动导演」的分工：§4 的检测器回答「**哪里**有热点、有**多热**」；§2.3 回答「检测到之后镜头**怎么动**」。

### 2.4 组件 3：解说 agent（中高 —— 灵魂）

一个「观察员 / 解说」agent 实时旁白（例：「书生3号 刚说服了书生7号改变观点……现在 GLM 阵营出现了分裂」）。Vincent 和 #107 都点名这是**最出彩、最像「能出的东西」**的组件。

#### 2.4.1 解说 agent 是什么

它**不是**社会里的参与者 —— 它是一个**独立的旁观 agent**，只读 `SocietyEvent` 流，产出自然语言旁白。它本身就是一个 anet 节点（claude-agent-sdk runtime），但：
- 不接入实验的 commhub 互动（不 send_task 给社会成员，避免污染实验）
- 订阅 `SocietyEvent` 流作为它的「输入感官」
- 输出旁白文本流，喂给 dashboard 的解说字幕区 + （可选）TTS

#### 2.4.2 怎么喂它实时事件流 —— 关键设计

解说 agent 的难点是**时间尺度不匹配**：`SocietyEvent` 可能每秒多条，但 LLM 旁白一次要几秒、且不能对每条事件都念。设计一个 **「事件批 → 旁白」节拍器**：

```
SocietyEvent 流
   ↓ (滑动窗口聚合，每 ~10-15s 一个 tick)
EventDigest { window: [t0,t1], events: SocietyEvent[], hotspots: HotspotEvent[] }
   ↓ (喂给解说 agent，prompt = 角色设定 + 上一段旁白 + 本 digest)
解说旁白文本（2-3 句）
   ↓
dashboard 字幕区 + 可选 TTS
```

- **节拍**：固定 ~10-15s 一个 digest tick（不是每事件触发），保证旁白节奏稳定、不刷屏
- **digest 内容**：窗口内的事件 + §4 标出的热点（让解说优先讲热点）
- **上下文**：prompt 带「上一段旁白」，让解说有连续性（「刚才提到的 GLM 分裂，现在……」）
- **角色 prompt**：解说 agent 的 systemPrompt 定义它的「人设」—— 体育解说式的、克制观察式的，都可配，影响内容风格
- **静默处理**：digest 为空 / 无新意时，解说应能说「现在网络比较平静」或干脆不输出，而不是硬编

> 这正好用上 #101/#102 的修复成果：解说 agent 也是 claude-agent-sdk 节点，需要稳定的工具/prompt 行为。但注意它**只读**，不需要 commhub 工具 —— 它的「输入」是 `SocietyEvent` 流（通过 prompt 注入或一个只读 MCP 工具），不是 commhub 互动。

#### 2.4.3 解说 agent 的 spec（RFC-009 风格）

```typescript
interface CommentatorSpec {
  alias: string;                   // e.g. "解说员"
  vendor: string;                  // 解说 agent 自己用哪个 vendor（建议用强模型）
  persona: string;                 // systemPrompt 人设
  digestIntervalMs: number;        // 节拍，建议 10000-15000
  hotspotPriority: boolean;        // digest 里有 hotspot 时是否强制优先讲
  ttsEnabled?: boolean;            // 是否接 TTS（Phase 3+）
}
```

### 2.5 组件 4：指标面板（中）

观点分布随时间 / 消息量 / 共识-极化曲线 —— 社会学实验的「数据」面，给学术 / 咨询 distribution 用。

| 指标 | 来源 | 说明 |
|------|------|------|
| 消息量时间序列 | `SocietyEvent` kind ∈ {task_sent,message_sent} 计数 | 社会「活跃度」 |
| 观点分布 | RFC-009 `payoff` / `Decision` 抽象（RFC-009 §2.6） | 每 round 各 agent 的立场快照 |
| 共识-极化曲线 | 观点分布的方差 / 聚类数随 round 变化 | 社会学核心指标 |
| 厂商分组对比 | 按 `SocietyEvent.vendor` 分组上述指标 | 多厂商维度（§3）—— 「DeepSeek 阵营 vs GLM 阵营」 |

指标面板**复用 RFC-009 §4.4 的 telemetry 抽象**，不重新发明；RFC-011 只增加「按 vendor 分组」这一维度的聚合。

### 2.6 现成可复用的（降低实施成本）

| 已有 | 在 RFC-011 的角色 |
|------|------|
| dashboard 拓扑图（三环 layout + agent 发光 + #96 厂商 LOGO） | 直播主画面 |
| Chat 浮窗 #100 / #106 | 自动聚焦的「观察窗口」（复用打开逻辑） |
| RFC-009 social experiment framework | 实验设定 + round/payoff/cohort 抽象（指标面板数据源） |
| commhub SSE event stream | `SocietyEvent` 的主要上游 |
| #96 节点视觉身份 LOGO | ticker / 主画面的 vendor 区分 |

### 2.7 §2 小结

呈现层 = 1 条 `SocietyEvent` 事件流（只读派生，不碰核心写路径）+ 4 个消费组件。解说 agent 是灵魂，其关键设计是「事件批 → 旁白」节拍器（~10-15s digest tick + 连续上下文 + 热点优先）。难度递增：ticker（易）→ 指标面板 / 自动聚焦（中）→ 解说 agent（中高）。`[N站马 输入]` 标注处待 N站马 确认 dashboard 实现细节。

---

## §3 跨厂商混合 batch 接 RFC-009

「5×DeepSeek + 5×MiniMax + 5×GLM」要落地，需要两件事：(1) 一个 batch 内能创建**多 vendor** 的节点；(2) 这些节点能作为 RFC-009 实验的 cohort 参与实验。本节设计这两点 —— 都是在已有 primitive 上**加维度**，不重写。

### 3.1 现状：batch 是单 vendor 的

`anet create --batch`（#104-B 后走 `selectVendorAndModel()` / `--preset`）一次只选一个 vendor，创建 N 个**同 vendor** 节点。要做多厂商社会，需要在一个 batch 操作里混合多个 vendor。

### 3.2 设计：`MultiVendorBatchSpec`

不改 `anet create --batch` 的单 vendor 行为（向后兼容），而是新增一个**多 vendor batch 描述**，由实验编排层消费：

```typescript
// 一个多厂商社会的节点构成。实验编排层据此循环调用底层的
// 单 vendor batch primitive，每个 cohort 一批。
interface MultiVendorBatchSpec {
  cohorts: VendorCohort[];
  workdir: string;                 // 父目录；每 cohort 一个子目录
  hub: string;
}

interface VendorCohort {
  vendor: string;                  // VENDORS registry 的 key — 必须是已验证 vendor
  model?: string;                  // 该 vendor 的具体 model；省略 = vendor 默认
  count: number;                   // 这个厂商起几个节点
  aliasPrefix: string;             // e.g. "DS" → DS1号..DS5号
  apiKey: string;                  // 该 vendor 的 key（走 env，不入 spec 持久化）
}
```

例（5×DeepSeek + 5×MiniMax + 5×GLM）：

```typescript
const society: MultiVendorBatchSpec = {
  workdir: "~/anet-society",
  hub: "http://127.0.0.1:9200",
  cohorts: [
    { vendor: "deepseek", count: 5, aliasPrefix: "DS",  apiKey: process.env.DEEPSEEK_KEY! },
    { vendor: "minimax",  count: 5, aliasPrefix: "MM",  apiKey: process.env.MINIMAX_KEY! },
    { vendor: "glm",      count: 5, aliasPrefix: "GLM", apiKey: process.env.GLM_KEY! },
  ],
};
```

**实现策略**：`MultiVendorBatchSpec` 的执行 = 对每个 `VendorCohort` 调用一次已有的单 vendor batch primitive（`createBatch()`，#104-B 后基于 VENDORS registry）。不发明新的节点创建路径 —— 只是「循环调用 N 次单 vendor batch」。这让多厂商 batch 天然继承 batch 已有的 lifecycle（`anet batch start/stop/restart/cleanup`）。

> ⚠️ **vendor 必须已验证**：`VendorCohort.vendor` 只接受 VENDORS registry 里的 key。#104-B 把 deepseek/glm/kimi 移出了 registry —— 所以上面这个例子在 **DeepSeek/GLM 验证加回 registry 之前跑不了**。这正是 §1.2 依赖链里「前置 P1」的含义，也是本 RFC 实施 gate 的一部分。

### 3.3 接 RFC-009：`CohortSpec` 增加 `vendor` 维度

RFC-009 §2.3 的 `CohortSpec` 负责把 agent 切成实验分组（cohort）。RFC-011 增加一个维度：**cohort 可以按 vendor 定义**。

RFC-009 现有 `CohortSpec`（摘要）按「数量 / 角色 / 标签」切分。RFC-011 提议增加一个可选字段：

```typescript
// RFC-009 CohortSpec 的 RFC-011 扩展（增量，不破坏现有字段）
interface CohortSpec {
  // ... RFC-009 现有字段 ...
  vendor?: string;                 // 新增：这个 cohort 全部是该 vendor 的节点
}
```

含义：实验设定时可以声明「cohort A = 全部 DeepSeek 节点，cohort B = 全部 GLM 节点」，于是 RFC-009 的 round 协议 / payoff 计算天然就能做**厂商间**的对比实验 —— 这正是「多厂商社会」的实验价值所在（不只是看热闹，是能产出「不同厂商模型的社会行为差异」这种学术/咨询结论）。

`MultiVendorBatchSpec.cohorts` 与 RFC-009 `CohortSpec` 是**同构**的：前者描述「怎么把这群节点创建出来」，后者描述「实验里怎么把它们分组」。`vendor` 字段是两者的连接键 —— 节点创建时带上 vendor 身份（已持久化在 config.json 的 `runtime`/`model`/env，加上 #96 的视觉身份），实验编排时按 vendor 分 cohort。

### 3.4 vendor 身份如何流到呈现层

`SocietyEvent.vendor`（§2.1）的值从哪来？链路：

```
VendorCohort.vendor (创建时)
  → 节点 config.json (model + ANTHROPIC_BASE_URL 已隐含 vendor)
  → commhub 节点注册时带 agent 字段 (agent-node:claude 等) + #96 视觉身份
  → SocietyEvent 归一化层用一个 alias→vendor 映射表回填 SocietyEvent.vendor
```

需要一个轻量的 `alias → vendor` 映射（多厂商 batch 创建时即可生成并落盘，例如 `~/anet-society/society.json`）。呈现层的归一化器读这个映射给每个事件打 vendor 标签。`[N站马 输入]` 这个映射表的存放位置与 dashboard 读取方式待定。

### 3.5 §3 小结

多厂商 batch = `MultiVendorBatchSpec`（多个 `VendorCohort`）→ 循环调用已有单 vendor batch primitive，继承 batch lifecycle。接 RFC-009 = 给 `CohortSpec` 加一个可选 `vendor` 字段，使厂商间对比实验成为一等公民。vendor 身份通过一个 `alias→vendor` 映射流到呈现层的 `SocietyEvent.vendor`。**实施 gate：所有目标 vendor 必须先验证加回 VENDORS registry**（§1.2 前置 P1）。

---

## §4 自动导演 — 热点检测算法

自动导演的核心问题：**「什么算 interesting event」**。§2.3 已设计「检测到之后镜头怎么动」；本节回答「**怎么检测**」。原则：检测器是 `SocietyEvent` 流之上的**纯函数派生层**（§2.1 已声明），输入原始事件流，输出 `HotspotEvent` —— 不碰任何核心写路径。

### 4.1 检测器的位置

```
SocietyEvent 流 (原始: task_sent / message_sent / status_changed / round_* / payoff_*)
   ↓  HotspotDetector — 滑动窗口 + 一组检测器
HotspotEvent { kind, score, focusTargets, window, why }
   ↓
  ├→ §2.3 自动聚焦（score 最高的当前热点 → 镜头）
  ├→ §2.4 解说 agent（digest 里带 hotspots，优先讲）
  └→ 反馈进 SocietyEvent 流（kind: "opinion_shifted" 等派生事件）
```

`HotspotEvent`：

```typescript
interface HotspotEvent {
  kind: "heated_exchange" | "opinion_flip" | "stalemate" | "cascade" | "coalition";
  score: number;                  // 0-1，热度归一化，自动聚焦按此排序
  focusTargets: string[];         // 涉及的 agent alias（镜头聚焦对象）
  window: { t0: number; t1: number };
  why: string;                    // 人类可读理由（喂解说 agent / debug）
  vendorSplit?: Record<string, number>;  // 涉及的 vendor 分布（多厂商看点）
}
```

### 4.2 五类热点的检测信号

每类热点对应一个独立检测器，跑在最近事件的滑动窗口上（建议窗口 30-60s）。**全部基于已有信号**（消息频次、收发对、RFC-009 payoff/Decision），不需要 LLM 判断 —— 检测要快、要便宜、要确定性。

| 热点类型 | 检测信号 | score 计算（直觉） |
|---------|---------|-------------------|
| **激烈对话 heated_exchange** | 一对（或小簇）agent 之间 message/task 往返频次在窗口内显著高于网络中位数 | 往返次数 / 网络中位数往返，clamp 0-1 |
| **观点翻转 opinion_flip** | RFC-009 `Decision`/`payoff` 显示某 agent 的立场相对上一 round 改变 | 翻转幅度（立场距离）× 新近度 |
| **僵局 stalemate** | 一组 agent 持续互动但 RFC-009 立场指标在 N 个 round 内方差≈0（谁也不动） | 持续 round 数 × 互动量（动而不变 = 戏剧性） |
| **级联 cascade** | 短时间内同一「观点/行为」沿 commhub 边快速扩散（多个 agent 依次 status/decision 同向变化） | 扩散涉及的 agent 数 / 窗口时长 |
| **联盟 coalition** | 出现一个互动密度显著高于跨组的 agent 子簇（图聚类），且该簇跨/不跨 vendor | 簇内密度 / 簇间密度；跨 vendor 的联盟 score 加权（更有看点） |

> 「僵局」的设计是反直觉但重要的看点：社会真人秀里，**「一直在吵但谁也说服不了谁」** 比「平静」更值得镜头。检测信号是「互动量高 + 立场方差低」的组合。

### 4.3 score 归一化与去抖

- 每个检测器输出原始分 → 用网络当前规模/活跃度做基线归一化（一个 3 节点社会和一个 30 节点社会的「热」不是一个量级）
- **去抖**：同一组 focusTargets 的同类热点在冷却期内（建议 60s）不重复 emit，只更新 score
- **score 衰减**：热点 emit 后 score 随无新事件时间指数衰减；衰减到阈值以下 → 热点「冷却」，§2.3 镜头拉回全局

### 4.4 多厂商维度的加权

本 RFC 的特色：**跨 vendor 的热点更有看点**。检测器在算 score 时，对「跨厂商」的热点加权：

- 跨 vendor 的 `heated_exchange`（DeepSeek 节点 vs GLM 节点对吵）score ×1.5
- 跨 vendor 的 `coalition`（DeepSeek + MiniMax 节点结成联盟对抗 GLM）score ×1.5
- `HotspotEvent.vendorSplit` 记录涉及的 vendor 分布，供解说 agent 和指标面板使用

这让自动导演天然倾向于呈现「厂商阵营」叙事 —— 正是 §1.1 说的「多厂商才有内容看点」。

### 4.5 检测器 spec

```typescript
interface HotspotDetectorConfig {
  windowMs: number;               // 滑动窗口，建议 30000-60000
  cooldownMs: number;             // 同热点去抖冷却，建议 60000
  scoreDecayHalfLifeMs: number;   // score 衰减半衰期，建议 30000
  crossVendorWeight: number;      // 跨 vendor 加权，建议 1.5
  minScore: number;               // 低于此分不 emit / 冷却阈值，建议 0.2
}
```

### 4.6 §4 小结

热点检测 = `SocietyEvent` 流之上的纯函数派生层，5 类检测器（激烈对话 / 观点翻转 / 僵局 / 级联 / 联盟），全部基于已有信号（消息频次 / RFC-009 payoff）确定性计算，不用 LLM。score 归一化 + 去抖 + 衰减保证镜头不乱跳。跨 vendor 热点加权，让自动导演倾向「厂商阵营」叙事。输出 `HotspotEvent` 喂 §2.3 自动聚焦 + §2.4 解说。

---

## §5 24/7 稳定性

「24/7 直播」对底层提两个要求：节点挂了要能**自愈**，长跑不能**资源泄漏**。本节不重新发明 —— 复用 #99 守护节点，并指出 RFC-011 视角下需要补的点。

### 5.1 节点自愈 — 复用 #99 守护节点

#99（守护节点）已经是「长跑监测」的承载。RFC-011 对它的诉求：

| 诉求 | 设计 |
|------|------|
| 检测节点挂掉 | #99 守护节点监测 commhub status；某节点 `error` 持续 / 心跳丢失 → 判定 down |
| 自动重启 | 复用 `anet batch restart <prefix>` lifecycle（§3.2 多厂商 batch 继承了 batch lifecycle）；守护节点按 cohort 重启挂掉的节点 |
| 直播不中断 | 节点 down→recover 期间，呈现层照常跑（少一个节点不影响 ticker/解说）；`SocietyEvent` 发 `node_down`/`node_recovered`，解说 agent 可以顺势旁白（「DS3号 掉线了，社会少了一个声音……它回来了」）—— **故障本身变成内容** |
| 实验一致性 | 节点重启会丢 session 上下文；RFC-009 实验需声明节点重启时的处理（重新入组 / 标记缺席）—— 这是 RFC-009 层的语义，RFC-011 标注依赖，不在此定义 |

> 设计取向：**不追求零故障，追求故障可观察 + 可恢复 + 不中断直播**。24/7 真人秀里，「选手掉线又回归」是叙事的一部分，不是要藏起来的 bug。

### 5.2 长跑资源

| 风险 | 缓解 |
|------|------|
| `SocietyEvent` 流无限增长 | 呈现层只持滑动窗口（ticker 50 条 / 检测器 30-60s 窗口 / 解说 digest 用完即弃）；落盘留给指标面板做**降采样**归档，不留全量 |
| agent session / token 累积 | claude-agent-sdk 节点长跑的 session 上下文增长 —— 复用 RFC-009 实验的 round 边界做 session 重置点；`CLAUDE_TIMEOUT_MS`（#98 timeout guard）防单次卡死 |
| 多节点内存/句柄 | #104-B batch 已有 count clamp（≤50）+ >20 告警；多厂商社会建议起步 3×3=9 节点（§6 Phase 1），不要一上来 5×5×5 |
| 解说 agent 自身长跑 | 解说 agent 也是 claude-agent-sdk 节点，同样吃 #98 timeout guard + round 边界重置 |

### 5.3 livestream infra（Phase 4）

接流本身（OBS / 流媒体推送）是**最外层**，不依赖 anet 内部 —— dashboard 渲染出可看的画面后，OBS 抓 dashboard 窗口推流即可。RFC-011 不设计推流细节（那是运营/工具问题），只声明：呈现层（§2）的产出必须是一个**自洽的、不需要人操作的浏览器画面**，这样 OBS 抓屏即可直播。`[N站马 输入]` dashboard 是否需要一个「直播模式」全屏 layout（隐藏控制 UI，只留主画面 + ticker + 解说字幕 + 指标面板）。

### 5.4 §5 小结

自愈复用 #99 守护节点 + batch restart lifecycle；故障可观察（`node_down`/`node_recovered` 进 `SocietyEvent`，解说顺势旁白 —— 故障变内容）。长跑资源靠滑动窗口（呈现层不留全量）+ round 边界 session 重置 + #98 timeout guard。livestream infra 是最外层 OBS 抓屏，RFC 只要求呈现层产出自洽画面。

---

## §6 实施 Phase ladder

实施严格 gate 在 §1.2 依赖链。Phase 0 不属于本 RFC（是 gate）；Phase 1+ 才是 RFC-011 的实施范围。

| Phase | 内容 | 前置 | 交付 |
|-------|------|------|------|
| **Phase 0（gate，非本 RFC）** | #101/#102 真验证通过 + DeepSeek/GLM vendor 验证加回 VENDORS registry | — | agents 能真互动 + 目标厂商可用 |
| **Phase 1 — 呈现层 MVP + 小社会** | `SocietyEvent` 归一化层 + 活动 ticker（§2.2）+ `MultiVendorBatchSpec`（§3.2）起一个 3×3 厂商小社会跑 RFC-009 实验 | Phase 0 | 能看到「一个跨厂商小社会在动」的最小直播画面 |
| **Phase 2 — 自动导演** | `HotspotDetector`（§4）+ 自动聚焦（§2.3） | Phase 1 | 镜头会自动怼热点，不用人点 |
| **Phase 3 — 解说 + 指标** | 解说 agent（§2.4，含 digest 节拍器）+ 指标面板（§2.5，按 vendor 分组） | Phase 2 | 「涌现 AI 社会真人秀」成形 —— 最像「能出的东西」 |
| **Phase 4 — 24/7 infra** | #99 守护节点自愈接入（§5.1）+ 长跑资源加固（§5.2）+ livestream 模式 layout（§5.3）+ OBS 推流 | Phase 3 | 真正 24/7 跑得住、推得出去 |

### 6.1 phasing 设计理由

- **Phase 1 先 ticker 不先解说**：ticker 是「直播有在动」的最低保证，且验证 `SocietyEvent` 归一化层是否正确 —— 解说和自动导演都建在这条流上，流不对后面全错。
- **Phase 2 自动导演先于解说**：解说 agent 的 digest 要带 hotspots（§2.4.2），所以热点检测得先有。
- **Phase 3 才上解说**：解说是中高难度且最出彩，放在 ticker + 自动导演验证过之后，风险最低。
- **Phase 4 最后**：24/7 infra 是「让前 3 个 phase 跑得久」，没有前 3 个 phase 就没有要 keep alive 的东西。
- 每个 phase 都是**可独立 demo 的交付**（per [[feedback_demo_quality_over_count.md]] 质量 > 数量）—— Phase 1 就能录一段「小社会在动」的视频。

### 6.2 §6 小结

5 个 phase：Phase 0 是 gate（非本 RFC）；Phase 1 ticker + 3×3 小社会；Phase 2 自动导演；Phase 3 解说 + 指标（成形）；Phase 4 24/7 infra。每 phase 可独立 demo。phasing 顺序由数据流依赖决定（`SocietyEvent` → 热点检测 → 解说）。

---

## 附录 A：本 RFC 的边界声明

- **本 RFC 只出设计，不实施任何代码**（与 RFC-009 / RFC-010 一致）。
- **实施 gate 在 §1.2 依赖链**：RFC-011 通过 = 设计方向获批，≠ 可以开做。Phase 1 实施触发条件是 Phase 0 解锁。
- **`[N站马 输入]` 标注的 dashboard 实现细节**需 N站马 确认后才进入实施设计。
- 本 RFC 在 RFC-009 上**增量**（`CohortSpec` 加 `vendor` 字段），不改 RFC-009 任何现有 API；新增的 `SocietyEvent` / `HotspotEvent` / `MultiVendorBatchSpec` / `CommentatorSpec` 都是呈现/编排层的新抽象，不碰 commhub / agent-node 核心写路径。

---

## 撰写进度

- [x] 骨架 + 头部 + 摘要
- [x] §1 愿景与依赖链
- [x] §2 呈现层设计（`[N站马 输入]` 标注处待 N站马 确认）
- [x] §3 跨厂商混合 batch 接 RFC-009
- [x] §4 自动导演 — 热点检测算法
- [x] §5 24/7 稳定性
- [x] §6 实施 Phase ladder
- [x] 附录 A 边界声明

**Draft v1 完整就绪 — 待 review**（通信龙 high-level · N站马 呈现层 `[N站马 输入]` 处 · Vincent final）

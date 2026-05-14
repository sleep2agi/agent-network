# RFC-011: 多厂商 AI Agent 社会 — 24/7 直播观察涌现社会行为

| 字段 | 值 |
|------|----|
| **RFC 编号** | 011 |
| **标题** | 多厂商 AI Agent 社会 — 24/7 直播 + 自动导演 + 解说，观察涌现社会行为 |
| **作者** | 通信SDK马 |
| **状态** | Draft（骨架 + §1 完成，§2-§6 撰写中） |
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

## §3 跨厂商混合 batch 接 RFC-009（撰写中）

> 跨厂商混合 batch 设计 + 在 RFC-009 `CohortSpec` 上增加 `vendor` 维度。

---

## §4 自动导演 — 热点检测算法（撰写中）

> 「什么算 interesting event」—— 激烈对话 / 观点翻转 / 僵局 / 级联 的检测信号与算法。

---

## §5 24/7 稳定性（撰写中）

> agent 自愈 / 长跑资源 / livestream infra。关联 #99 守护节点。

---

## §6 实施 Phase ladder（撰写中）

> Phase 0（前提 gate）→ Phase 1（ticker + 3×3 厂商小社会）→ Phase 2（自动导演）
> → Phase 3（解说 agent + 指标面板）→ Phase 4（24/7 livestream infra）。

---

## 撰写进度

- [x] 骨架 + 头部 + 摘要
- [x] §1 愿景与依赖链
- [x] §2 呈现层设计（`[N站马 输入]` 标注处待 N站马 确认）
- [ ] §3 跨厂商混合 batch 接 RFC-009
- [ ] §4 自动导演 — 热点检测算法
- [ ] §5 24/7 稳定性
- [ ] §6 实施 Phase ladder

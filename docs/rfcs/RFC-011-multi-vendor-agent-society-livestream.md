# RFC-011: 多厂商 AI Agent 社会 — 24/7 直播观察涌现社会行为

| 字段 | 值 |
|------|----|
| **RFC 编号** | 011 |
| **标题** | 多厂商 AI Agent 社会 — 24/7 直播 + 自动导演 + 解说，观察涌现社会行为 |
| **作者** | 通信SDK马 |
| **状态** | Draft v3 amend (通信牛 v2 second pass → 1 new blocker §2.4.2 + 4 minor 已 address，待 third pass review) |
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

### 2.1 共同基础：`SocietyEvent` 事件流 + `SocietyEventSource` 派生层

4 个呈现组件（ticker / 自动聚焦 / 解说 / 指标面板）不各自去 scrape 数据，而是共享一条**规范化事件流** `SocietyEvent`。这是呈现层的数据契约 —— 上游产生事件，下游 4 个组件各自消费。

> ⚠️ **v2 修正（通信牛 review Blocker 1）**：v1 原假定「直接复用 commhub SSE」是错的。**实测确认**：commhub 现有 SSE 是 `GET /events/:session` + `pushEvent(sessionName, event, networkId)` —— **per-session-name + network-scoped 的「单播流」**（#84 工作时核对过 server/src/push.ts / index.ts:354-387）。它面向「一个 agent 订阅自己的事件」，不是 dashboard 可消费的「全网事件流」。v2 改：定义独立的 **`SocietyEventSource`** 派生层，由 RFC-011 呈现层模块拥有，从下列**已有 server 存量**汇总归一化得出 `SocietyEvent` 流，不要求 commhub 改 SSE 模型。

#### 2.1.1 `SocietyEventSource` 设计

```typescript
// 呈现层模块拥有的派生事件源。订阅它就拿到 network-scoped 的归一化
// SocietyEvent 流；4 个呈现组件都消费它（互不耦合）。实现是纯派生 +
// poll/tail 已有 server 存量，不要求改任何核心写路径。
//
// 鉴权语义：调用者必须已通过 utok_ Bearer auth 拿到一个 user context
// （v3 澄清）。subscribe()/snapshot() 不显式传 user —— user 由 ACL 边界
// 在 SocietyEventSource 的实现层（HTTP handler / dashboard backend）从
// auth 上下文取，再去 network_members 验通过。承载方式对 RFC-011
// 调用方是 implicit 的，避免把 token 漏进每个 callsite。
interface SocietyEventSource {
  // 订阅 network 内的事件流（user 见上方鉴权语义；按 (user, networkId)
  // 在 network_members 表里 join 校验通过才会返回订阅句柄；否则抛 ACL 拒绝）。
  // 返回一个可取消的订阅；新事件通过 onEvent 回调推送。
  subscribe(opts: {
    networkId: string;
    sinceTs?: number;              // 增量恢复（断线重连用）
    kinds?: SocietyEvent["kind"][]; // 过滤; 不传 = 全要
    onEvent: (e: SocietyEvent) => void;
  }): { close(): void };

  // 一次性快照（自动导演 / 指标面板初次渲染用）。鉴权同 subscribe()。
  snapshot(opts: {
    networkId: string;
    fromTs: number; toTs: number;
    kinds?: SocietyEvent["kind"][];
  }): Promise<SocietyEvent[]>;
}
```

**实现策略（不要求改 server 写路径，全部派生）**：
- **`tasks` 表 tail**（server/src/db.ts 已有；`task_events` 表也已有，记录状态变化） → `task_sent` / `task_replied`
- **`inbox` 表 tail**（`type: "message"` 等） → `message_sent`
- **`sessions.status` polling**（`get_all_status` 已有 API）或定时拉差分 → `status_changed`
- **RFC-009 round/payoff** → 当 RFC-009 实施时由其 telemetry 通道产 `round_*` / `payoff_updated`（RFC-009 §4.4），与 server 表无关
- **派生事件**（`opinion_shifted` 等热点） → §4 检测器在 `SocietyEventSource` 之上跑，**输出新事件再回灌进同一条订阅流**（自闭环，订阅者只看到统一抽象）
- **`node.renamed`** / `node_down` / `node_recovered` → 守护节点 #99 / 现有 `node.renamed` SSE（#84 实施时已加 user 频道 broadcast）派生

**ACL / scope**（通信牛 concern §2.1/§2.2，v3 接口语义澄清）：
- 订阅按 `(user, network)` 鉴权 —— user 来自调用方 auth 上下文（utok_ Bearer），不在 `subscribe()/snapshot()` 签名里显式传；SocietyEventSource 实现侧（dashboard backend HTTP handler）从 auth context 拿 user → 用 `(user, networkId)` 查 `network_members` 表 → 不是 member 直接拒绝订阅。这保持接口最小（不让每个 callsite 拼 token）同时不失 ACL 强度
- **`SocietyEvent.summary` 仅承载元数据**（vendor / event_kind / token counts / 截断后的 from→to 关系等），**消息正文不进 `summary`，不进 `payload`**
- `summary` 长度上限 120 字符；超过则尾部 `…` 截断
- `payload` 仅放 kind-specific 结构化元数据（如 round_id / payoff_delta），**禁止放原始消息文本**
- 跨 network 隔离：订阅者只看到自己 network 的事件，dashboard 不会因订阅一个 network 就拿到另一个 network 的事件

#### 2.1.2 与现有 SSE 的关系

现有 `pushEvent(alias, event, networkId)` 不变 —— 它是「agent 自己的 inbox 推送」面向 agent-node 消费。`SocietyEventSource` 是**另一条独立的派生层**，给呈现层用：

```
sessions / tasks / inbox / task_events / node.renamed SSE / RFC-009 telemetry
                                ↓
                       SocietyEventSource (本 RFC 拥有的派生层)
                                ↓
              ticker / 自动聚焦 / 解说 agent / 指标面板
```

> 设计约束保持不变（v1 已定）：`SocietyEvent` 是**只读派生视图**，不改 commhub / RFC-009 的任何写路径 —— 纯消费。这保证呈现层是可选 add-on，不碰核心业务逻辑。

```typescript
// SocietyEvent 本身的结构 v2 不变（只是来源澄清了）
interface SocietyEvent {
  ts: number;                      // epoch ms
  kind:
    | "task_sent" | "message_sent" | "task_replied"
    | "status_changed"
    | "round_started" | "round_ended" | "payoff_updated"
    | "opinion_shifted"            // 派生（§4 检测器）
    | "node_down" | "node_recovered" | "node_renamed";
  from?: string;                   // alias（network-scoped, 通过 vendorMap 解析 vendor）
  to?: string;
  vendor?: string;                 // from 节点的 vendor (§3.4 v2 mapping)
  networkId: string;               // v2: 显式 network scope (ACL 用)
  summary: string;                 // ≤120 字符元数据摘要, 无正文
  payload?: Record<string, unknown>; // kind-specific 元数据, 无正文
  experimentId?: string;           // 关联 RFC-009 实验
}
```

### 2.2 组件 1：活动 ticker（易）

屏幕一侧实时滚动「谁 → 谁 发了什么」。最简单的组件，直接消费 `SocietyEvent` 流。

| 项 | 设计 |
|----|------|
| 数据源 | `SocietyEvent` where kind ∈ {task_sent, message_sent, task_replied} |
| 渲染 | 一行一事件：`[时间] <vendor图标> from → to : summary`（vendor 图标复用 #96 厂商 LOGO） |
| 容量 | 滚动窗口保留最近 N 条（建议 50），更早的滚出 |
| 实现 | `[N站马 输入]` dashboard 加一个 ticker 组件，通过 §2.1.1 `SocietyEventSource.subscribe({ kinds: ['task_sent','message_sent','task_replied'] })` 拉流 — **不**直接消费 commhub `/events/:session` SSE（v3 fix：那条 SSE 是 per-session-name 单播，不是全网事件流） |

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

> ⚠️ **v2 闭环（通信牛 review concern §2.4 — 解说 agent 输入机制未闭环）**：解说 agent 通过 §2.1 v2 引入的 `SocietyEventSource.subscribe({ networkId, kinds, onEvent })` 拉取事件流，digest 拼装在解说 agent **节点外部** 完成（一个 RFC-011 呈现层模块拥有的 digest 拼装器），按 `digestIntervalMs` 节拍把 digest 作为单次 prompt 灌进解说 agent。这样解说 agent 仍是普通 claude-agent-sdk 节点（不需要新的 MCP 工具 / 自定义协议），它的"输入感官"具体落地 = 接收一个 user message 含 `EventDigest` JSON + 上段旁白。

> ⚠️ **v3 闭环（通信牛 second pass new Blocker — digest 投递递归污染 SocietyEvent）**：v2 草稿写「digest 拼装器与解说 agent 间通过 `commhub_send_task` 投递（沿用现有 anet 协议），不发明新通道」**是个递归 trap**：
> - 拼装器 `commhub_send_task(commentator, digest)` 在 commhub **写 tasks/inbox 行**
> - SocietyEventSource 派生层 tail `tasks` 表 → 产 `task_sent` event（kind 在订阅过滤里）
> - 下一个 digest tick 把这条「digest 投递事件」也算进窗口
> - 解说 agent 看到 digest 里有它自己被投递的元事件 → 旁白污染（「现在拼装器又给我发了一段总结，我现在念……」）
> - 严重时 digest 间互相喂回，解说陷入 self-referential loop
>
> **v3 修正 — Option A：control network 隔离（recommended）**
>
> 解说 agent + digest 拼装器跑在**独立的 commhub control network**（`network_id != experiment_network_id`），与社会实验本身的 network 物理隔离：
>
> ```
> 实验 network (net_society_exp_X)
>   ├ agent_DS_1 ↔ agent_DS_2 ↔ ... (社会成员, 互相 send_task)
>   └ SocietyEventSource.subscribe({networkId: 'net_society_exp_X', ...})
>                      ↓ 单向只读派生 (跨 network ACL 允许: user-scoped, 见 §2.1.1)
>                      ↓
>                 digest 拼装器 (跑在 control network net_control_X)
>                      ↓ commhub_send_task (control network 内, 不出现在实验 network 的 tasks 表)
>                      ↓
>                 解说 agent (跑在 control network net_control_X)
> ```
>
> 关键不变量：
> - SocietyEventSource 只订阅 **实验 network** 的事件 → digest 投递发生在 **control network** → digest 投递不会回灌
> - 解说 agent 的 ack/状态/旁白输出也都在 control network → 同理不污染
> - 跨 network 订阅基于 user 鉴权（dashboard 用户必须是两个 network 的 member）；运维上可以让 control network 由 experiment owner 持有 + 仅自己加入
> - 对 commhub 0 改动：现有 `UNIQUE(network_id, alias)` schema 直接支持
>
> **v3 Option B（rejected as primary，列为兜底方案）—— role: commentator 过滤**
>
> 在 SocietyEventSource 的派生逻辑里加 filter：if `from === commentator_alias || to === commentator_alias` → drop。
> - 优点：不需要双 network，编排简单
> - 缺点（为何 reject）：(1) 要求拼装器/解说 agent 知道全部 commentator alias 列表才能过滤准确，多解说员 / 替换解说员时漂移；(2) 不防别的非 SocietyEventSource 派生器（例如未来的指标面板独立 derive）误把 digest 投递算进 message 量；(3) role 字段是 honor system，新 derive 代码漏 filter 就泄露
>
> **决议**：Option A 作为 RFC-011 的明确闭环方案。Phase 1 实施时 `MultiVendorBatchSpec` 编排器（§3.2）创建实验时**额外**起 control network，所有解说层 agent（commentator + digest assembler + 任何 phase 3+ TTS 适配器）一律加入 control network，experiment network 内只跑社会成员。Option B 仅作为 control network 不可用环境的退路（例如本地单 network demo），文档明示其局限。

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
| commhub `sessions` / `tasks` / `inbox` / `task_events` 表 | `SocietyEvent` 的主要派生上游（经 `SocietyEventSource` tail/poll —— v3 fix：v1 列「SSE event stream」错，实测 SSE 是 per-session 单播） |
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
// 单 vendor batch library API（v2: 见 3.2.1 Phase 0.5），每个 cohort 一批。
interface MultiVendorBatchSpec {
  cohorts: VendorCohort[];
  workdir: string;                 // 父目录；每 cohort 一个子目录
  hub: string;
}

// v2 修正 (通信牛 review Blocker 2): apiKey 不内嵌字符串, 改 envVarName 引用
interface VendorCohort {
  vendor: string;                  // VENDORS registry 的 key — 必须是已验证 vendor
  model?: string;                  // 该 vendor 的具体 model；省略 = vendor 默认
  count: number;                   // 这个厂商起几个节点
  aliasPrefix: string;             // e.g. "DS" → DS1号..DS5号
  apiKeyEnvVar: string;            // ⚠️ v2: 该 vendor key 所在的环境变量名 (如 "DEEPSEEK_KEY"), 不是 key 字符串本身
}
```

例（5×DeepSeek + 5×MiniMax + 5×GLM）：

```typescript
// v2: spec 只引用 env var name; 执行时实验编排层 process.env[name] 读取
const society: MultiVendorBatchSpec = {
  workdir: "~/anet-society",
  hub: "http://127.0.0.1:9200",
  cohorts: [
    { vendor: "deepseek", count: 5, aliasPrefix: "DS",  apiKeyEnvVar: "DEEPSEEK_KEY" },
    { vendor: "minimax",  count: 5, aliasPrefix: "MM",  apiKeyEnvVar: "MINIMAX_KEY" },
    { vendor: "glm",      count: 5, aliasPrefix: "GLM", apiKeyEnvVar: "GLM_KEY" },
  ],
};
```

> ⚠️ **v2 修正（通信牛 review Blocker 2 — apiKey 落盘）**：v1 草稿写「apiKey 走 env，不入 spec 持久化」是错的 —— 实测确认 `createBatch()` (`bin/cli.ts:5377-5378`) 把 apiKey 直接写进 `envMap`，然后 `saveProfile()` 落到 node config.json 里。v2 改：`VendorCohort` 不再持有 key 字符串，只持 `apiKeyEnvVar`，执行时实验编排层从 `process.env` 读，**仍会被 createBatch 落盘到 config.json env 字段**（这是现有 batch primitive 的已知 hygiene 缺口，非 RFC-011 独有）。
>
> **配套 follow-up (RFC 范围外)**：现有 batch primitive 把 apiKey 写 config.json 是独立 secret hygiene 问题，应另开 issue 修：node config.json 的 secret 字段走 file mode 0600 + 或迁到独立 secrets store (per-node `.anet/nodes/<alias>/secrets.json` 或 OS keychain)。RFC-011 v2 不解决它，但明确 surface 它存在。

#### 3.2.1 实施前置 — Phase 0.5: 把 batch primitive 抽成 library

> ⚠️ **v2 修正（通信牛 review Blocker 3 — createBatch() CLI 耦合）**：v1 草稿写「循环调用已有 `createBatch()`」假定它是可 import 的库 API —— 实测确认（`bin/cli.ts:5338`）`createBatch()` 实际深耦合 CLI 进程：`process.chdir(nodeDir)` (L5374) / `process.exit(1)` (L5346) / `console.error/log` / `loadGlobal()`。实验编排层无法干净 import 它。

v2 加 **Phase 0.5（实施 gate 的一部分，§6 phasing 已 reflect）**：

```yaml
Phase 0.5 — extract batch primitive to library (通信牛 推荐 Option A):
  目标: 把 createBatch() 的「为每 node 创建 dir/profile/token」核心循环
        抽到 agent-network/src/batch.ts 作为纯库函数, 去掉以下耦合:
    - process.chdir(): 改用绝对路径参数, 不动 process cwd
    - process.exit(): 改 throw / 返 Result<{created, failed}>
    - console.error/log: 改可选 logger 参数 (调用方提供, 默认 silent)
    - loadGlobal(): 改显式 config 参数 (调用方决定怎么拿 global)
  CLI 命令侧 (createBatchWizardCommand): 调库 + 处理 process.exit/console
  RFC-009 / RFC-011 实验编排层: 直接调库, 不 shell out

依赖关系:
  Phase 0.5 完成后 (= batch library) → RFC-011 §3.2 的 MultiVendorBatchSpec 才能干净实现
  Phase 0.5 也是 RFC-009 实验 framework 实施前置 (RFC-009 也假定能编程式起 batch)
```

**为什么不选 Option B（shell out `anet create --batch`）**：shell out 的耦合更糟 —— 实验编排层每起一个 cohort fork 一个 node CLI 进程，stdout/stderr 解析脆弱，错误恢复语义不清；且失去类型安全 / IDE 支持 / debug。通信牛 推荐 Option A，v2 采纳。

#### 3.2.2 实现策略 (post Phase 0.5)

`MultiVendorBatchSpec` 的执行 = 对每个 `VendorCohort` 调用一次 batch library API（Phase 0.5 抽出的纯库 `agent-network/src/batch.ts`）。不发明新的节点创建路径 —— 只是「循环调用 N 次单 vendor batch library」。lifecycle（`anet batch start/stop/restart/cleanup`）继承自 CLI 命令侧的现有实现。

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

`SocietyEvent.vendor`（§2.1）的值从哪来？

> ⚠️ **v2 修正（通信牛 review Blocker 4 — alias→vendor 跨 network 串号）**：v1 草稿用 `alias → vendor` 单键映射有两个真错：
> 1. **alias 不是全局唯一** —— commhub schema 是 `UNIQUE(network_id, alias)`（实测 db.ts:25/357），同一 alias 可同时存在于多个 network。按 alias 单键映射会把 network A 的 `DS1` vendor 串到 network B 的同名 agent。
> 2. **靠 model/baseUrl/env 反推 vendor 脆** —— 节点 config.json 现无 `vendorKey` 字段（`Profile` 接口实测确认），只有 `runtime` + `model` + env。反推规则随 VENDORS registry 演化会失效。

#### 3.4.1 v2 设计：复合键 + 显式持久化

**(a) 复合键**：`(network_id, alias) → { vendorKey, model }`，不再用 `alias` 单键。

**(b) 显式持久化**：batch 创建节点时把 `vendorKey` 显式写进 node config.json，不靠反推。需要 `Profile` 接口增加可选字段：

```typescript
// agent-network/bin/cli.ts Profile interface 扩展 (v2 新增字段, 增量, 不破坏现有)
interface Profile {
  // ... 现有字段 ...
  runtime: RuntimeName;
  model?: string;
  // v2 新增 (RFC-011):
  vendorKey?: string;  // VENDORS registry 的 key (intern / minimax / mimo / anthropic / ...)
                       // batch 创建时由 VendorCohort.vendor 直接 set; 单 node create 流可选
}
```

**(c) 解析链路（v2）**：

```
VendorCohort.vendor (MultiVendorBatchSpec 创建时)
  → batch library API (Phase 0.5 抽出) 把 vendorKey 显式写进 Profile.vendorKey
  → saveProfile() 落 .anet/nodes/<alias>/config.json (vendorKey 字段)
  → commhub 节点注册时, agent-node 把 vendorKey 上报到 sessions/nodes 表的某字段
    (v2 follow-up: server 增 sessions.vendor 列 - ALTER TABLE 兼容旧 row null)
  → SocietyEventSource 派生事件时用 (network_id, alias) 查 sessions.vendor 回填
    SocietyEvent.vendor (network-scoped, 不串号)
```

**(d) Server 表的微小 schema 改动**：`sessions` 表加 `vendor TEXT` 列（与现有 V2 migrations 一致 pattern，db.ts:59-67），现有节点 row 为 null（向后兼容；显示层 vendor 缺失 = 没标厂商）。这是 RFC-011 唯一对 server 写路径的依赖（且仅一列），不算破坏「呈现层只读派生」原则因为它来自节点自报，server 不在 SocietyEventSource 路径上做任何业务逻辑。

#### 3.4.2 不再需要的产物

v1 提的「`society.json` 外部映射文件 / `[N站马 输入]` 表的存放位置与 dashboard 读取」**v2 取消** —— 数据现在沿现有 config.json + sessions 表流动，dashboard 通过 SocietyEventSource 拉到 `SocietyEvent.vendor` 即可用，不再需要额外映射表。

### 3.5 §3 小结

多厂商 batch = `MultiVendorBatchSpec`（多个 `VendorCohort`）→ 循环调用已有单 vendor batch primitive，继承 batch lifecycle。接 RFC-009 = 给 `CohortSpec` 加一个可选 `vendor` 字段，使厂商间对比实验成为一等公民。vendor 身份通过 **`(network_id, alias) → vendorKey` 复合键 + 显式持久化（§3.4.1 v2 修正）** 流到呈现层的 `SocietyEvent.vendor`，**不**靠 alias 单键反推 —— v1 的 `alias→vendor` 单键说法 v3 已修。**实施 gate：所有目标 vendor 必须先验证加回 VENDORS registry**（§1.2 前置 P1）。

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
| **Phase 0.5 — batch primitive 解耦** ⚠️ v2 新增 | 把 `createBatch()` 核心抽到 `agent-network/src/batch.ts` 纯库 (去 process.chdir/exit/console/loadGlobal 耦合, §3.2.1 Blocker 3); 加 `Profile.vendorKey` 字段 + `sessions.vendor` 列 (§3.4 Blocker 4 schema 微改) | Phase 0 | 库可被 RFC-009 / RFC-011 编程式调用; vendor 身份显式持久化 |
| **Phase 1 — 呈现层 MVP + 小社会** | `SocietyEventSource` (§2.1.1) + 活动 ticker (§2.2) + `MultiVendorBatchSpec` (§3.2) 起 3×3 厂商小社会跑 RFC-009 实验 | Phase 0.5 | 能看到「一个跨厂商小社会在动」的最小直播画面 |
| **Phase 2 — 自动导演** | `HotspotDetector`（§4）+ 自动聚焦（§2.3） | Phase 1 | 镜头会自动怼热点，不用人点 |
| **Phase 3 — 解说 + 指标** | 解说 agent（§2.4，含 digest 节拍器 + `SocietyEventSource.subscribe` 订阅，§2.4.2 v2 闭环）+ 指标面板（§2.5，按 vendor 分组） | Phase 2 | 「涌现 AI 社会真人秀」成形 —— 最像「能出的东西」 |
| **Phase 4 — 24/7 infra** | #99 守护节点自愈接入（§5.1）+ 长跑资源加固（§5.2）+ livestream 模式 layout（§5.3）+ OBS 推流 | Phase 3 | 真正 24/7 跑得住、推得出去 |

### 6.1 phasing 设计理由

- **Phase 1 先 ticker 不先解说**：ticker 是「直播有在动」的最低保证，且验证 `SocietyEvent` 归一化层是否正确 —— 解说和自动导演都建在这条流上，流不对后面全错。
- **Phase 2 自动导演先于解说**：解说 agent 的 digest 要带 hotspots（§2.4.2），所以热点检测得先有。
- **Phase 3 才上解说**：解说是中高难度且最出彩，放在 ticker + 自动导演验证过之后，风险最低。
- **Phase 4 最后**：24/7 infra 是「让前 3 个 phase 跑得久」，没有前 3 个 phase 就没有要 keep alive 的东西。
- 每个 phase 都是**可独立 demo 的交付**（per [[feedback_demo_quality_over_count.md]] 质量 > 数量）—— Phase 1 就能录一段「小社会在动」的视频。

### 6.2 §6 小结

6 个 phase（v2: 加 Phase 0.5）：Phase 0 是 gate（非本 RFC）；**Phase 0.5 batch primitive 解耦 + vendor schema 微改 (v2 新增)**；Phase 1 ticker + 3×3 小社会；Phase 2 自动导演；Phase 3 解说 + 指标（成形）；Phase 4 24/7 infra。每 phase 可独立 demo。phasing 顺序由数据流依赖决定（`SocietyEvent` → 热点检测 → 解说）。

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

---

### v2 amend pass — 已 address 通信牛 v1 review

通信牛 v1 review verdict: 🟡 request changes before approve（4 blocker + 2 concern）。v2 amend 已逐项 address：

- [x] **Blocker 1** §2.1 SSE 模型实测纠正 — v1「复用 commhub SSE」错（实测 `/events/:session` 是 alias-scoped 单播）→ v2 引入独立 `SocietyEventSource` 派生层 + ACL/截断规则（concern §2.1/§2.2 一并 close）
- [x] **Blocker 2** §3.2 apiKey 落盘 — v1「走 env 不入 spec」错（实测 `createBatch()` 写 envMap → saveProfile config.json）→ v2 `VendorCohort` 改 `apiKeyEnvVar` 引用；surface 现有 batch primitive 的 secret hygiene 缺口作 RFC 范围外 follow-up
- [x] **Blocker 3** §3.2 `createBatch()` 不是库 API — 实测确认深耦合 process.chdir/exit/console/loadGlobal → v2 加 Phase 0.5 实施前置「抽 batch primitive 到 `agent-network/src/batch.ts` 纯库」（通信牛 推荐 Option A）
- [x] **Blocker 4** §3.4 `alias→vendor` 跨 network 串号 — 实测 schema `UNIQUE(network_id, alias)` 确认 → v2 改复合键 `(network_id, alias) → vendorKey`；`Profile.vendorKey` 字段 + `sessions.vendor` 列显式持久化，不靠反推
- [x] **Concern §2.4** 解说 agent 输入机制闭环 — v2 用 §2.1.1 `SocietyEventSource.subscribe`，digest 拼装器在节点外, 解说 agent 仍是普通 claude-agent-sdk 节点
- [x] §6 phasing 加 Phase 0.5 — batch primitive 解耦 + vendor schema 微改是 §3.2/§3.4 实施前置

---

### v3 amend pass — 已 address 通信牛 v2 second pass review

通信牛 v2 second pass verdict: 🟡 request 1 more pass（new blocker §2.4.2 digest pollution + 4 minor 文字残留）。v3 amend 已逐项 address，**待 通信牛 third pass review**：

- [x] **New Blocker §2.4.2** digest 递归污染 — v2 写「digest 拼装器 ↔ 解说 agent 用 `commhub_send_task`」会让投递本身被 SocietyEventSource derive 成 `task_sent` 回灌 → 解说看到自己被投递的元事件 → 旁白污染甚至 self-loop。v3 加 **Option A：control network 隔离（recommended）** —— commentator + digest 拼装器跑在独立 commhub network，与实验 network 物理隔离；SocietyEventSource 只订阅实验 network → digest 投递不可见。Option B (role: commentator 过滤) 列为兜底，仅 single-network demo 用，限制明示。
- [x] **Minor §2.2 line 190** ticker 实现说"复用 SSE 连接"—— v3 改 "通过 SocietyEventSource.subscribe 拉流"，明示不直接消费 per-session SSE
- [x] **Minor §2.6 复用表** 列「commhub SSE event stream | SocietyEvent 主要上游」与 §2.1 v2 修正矛盾 —— v3 改成「sessions / tasks / inbox / task_events 表（经 SocietyEventSource tail/poll）」
- [x] **Minor §3.5 小结** 写「vendor 身份通过一个 `alias→vendor` 映射」与 §3.4.1 v2 复合键设计矛盾 —— v3 改成 `(network_id, alias) → vendorKey` 复合键 + 显式持久化
- [x] **Minor §2.1.1 ACL 接口 mismatch** —— `subscribe()` 签名只有 `networkId` 没有 `user`，但 ACL 散文写「按 (user, network) 鉴权」。v3 在接口注释 + ACL bullet 显式澄清：user 由 auth 上下文 implicit 拿（utok_ Bearer），不进签名；SocietyEventSource 实现侧从 auth context 取 user → 查 network_members → 不是 member 抛 ACL 拒绝。保持接口最小同时不失 ACL 强度。

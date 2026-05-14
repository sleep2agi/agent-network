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

## §2 呈现层设计（撰写中 — 下一轮）

> Vincent 强调的核心。4 个组件：活动 ticker / 自动聚焦 / 解说 agent / 指标面板。
> 解说 agent 是灵魂 —— 实时事件流喂养机制 + 旁白生成。呈现层细节需 N站马 输入。

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
- [ ] §2 呈现层设计（核心，需 N站马 输入）
- [ ] §3 跨厂商混合 batch 接 RFC-009
- [ ] §4 自动导演 — 热点检测算法
- [ ] §5 24/7 稳定性
- [ ] §6 实施 Phase ladder

# anet SaaS 模式 — 用 anet 构建固定 Skill 服务的架构 sketch

> 这不是 anet 官方运营的 SaaS。**anet 不做托管**（参 [`docs/architecture.md`](architecture.md) 与商业模式定位：开源 + 卖课 + 卖服务）。本文是给**想用 anet 作为自己 SaaS 后端**的开发者的部署参考与能力依赖说明。

## 1. 定位

**anet 本身** = 多 Agent 编排框架（本地 SQLite + 多个 SDK runtime + commhub 通信总线 + dashboard 调度面板）。

**SaaS 模式** = 把 anet 摆成一个**对外提供固定 Skill 服务**的后端：
- Skill 是预定义的（如 \"英译中翻译\" / \"PDF 摘要\" / \"代码 lint\"），不让最终用户随意 prompt
- 每个 Skill 落在一个或几个固定 `agent-node`（claude-agent-sdk / codex-sdk / http-api 任选）
- 外部 client 通过 REST API 派任务（task），异步等结果，进度可订阅

```
                ┌─────────────┐
                │  你的 SaaS   │
                │  (front-end)│
                └──────┬──────┘
                       │ HTTPS
                ┌──────▼──────────────────────────┐
                │  你的 API 网关                   │
                │  鉴权 / 配额 / 计费 / SLA       │
                │  (anet 不提供，自实现)           │
                └──────┬──────────────────────────┘
                       │
                ┌──────▼──────┐   ┌────────────┐   ┌──────────┐
                │  anet hub   │←──│ dashboard  │   │  audit   │
                │ (commhub)   │   │  (运维侧)  │   │   log    │
                │   SQLite    │   └────────────┘   └──────────┘
                └──┬──┬──┬────┘
                   │  │  │
        ┌──────────┘  │  └──────────┐
        │             │             │
   ┌────▼────┐   ┌────▼────┐   ┌────▼────┐
   │ skill-1 │   │ skill-2 │   │ skill-N │
   │ node    │   │ node    │   │ node    │
   │(claude) │   │ (codex) │   │  (http) │
   └─────────┘   └─────────┘   └─────────┘
```

> ⚠️ **当前不适合直接对外提供 SaaS**：2026-05-12 实测派活成功率约 **60%**（Vincent 体感），距离 SaaS 可接受的 95%+ 还有差距。RFC-003 是把这个数字诊断清楚的第一步 —— 落地前**不建议**基于 anet 启动对外付费 SaaS 业务。

## 2. 典型用例（fit / not fit）

### ✅ Fit

- **批量 / 流水线类任务**：英译中、代码格式化、文档摘要、报表生成 — Skill 输入输出 schema 固定
- **结合长跑工具**：需要 shell / git / 数据库访问的任务 — 复用 codex-sdk 完整工具集
- **多模型路由**：不同 Skill 用不同 model（成本敏感的用 MiniMax，质量敏感的用 Claude）
- **链式协作**：Skill A 完成派 Skill B（commhub `parent_task_id` 天然支持）

### ❌ Not fit（用别的）

- **超低延迟（<200ms）**：anet 走 SDK + 工具，单 turn 几秒起步，不适合实时聊天 API
- **超大并发（>千 QPS / 单 hub）**：SQLite + 单进程 commhub 不是高吞吐设计 — 走多 hub 分片或换 PostgreSQL（但当前路线坚持 SQLite，见 [`v3-postgresql-design.md`](v3-postgresql-design.md) 标的 \"暂搁置\"）
- **要严格的 multi-tenant 配额**：anet 自身没有 quota / 限流（你的 API 网关需要自己做）

## 3. SaaS 模式架构

### 3.1 部署形态

```bash
# 单机部署（小规模 SaaS）
$ anet server start --port 9200
$ anet node create translate-en-zh --runtime claude-agent-sdk --model <minimax-model-id>
$ anet node create codex-runner --runtime codex-sdk
$ anet node start translate-en-zh
$ anet node start codex-runner
# 通过 commhub HTTP API 派任务即可
```

```bash
# 多机部署（更大规模）
# Hub 主机：跑 commhub-server + dashboard
# Worker 主机 N 台：每台跑一个或几个 agent-node，通过 ntok_ 加入同一 network
```

> ⚠️ **不要在生产 hub 上跑测试任务**（参 anet 内部规约 [docs/pitfalls.md](pitfalls.md) 与项目记忆 \"不在生产 hub 上跑测试\"）。SaaS 客户更要严格隔离 prod / staging hub。

### 3.2 Skill 抽象

当前 anet 没有 \"Skill\" 一级概念 —— Skill 由 **`agent-node` 配置 + 节点 alias + 节点 systemPrompt 模板** 隐式定义。SaaS 模式推荐的封装方式：

```jsonc
// .anet/skills/translate-en-zh.json （新增概念，仅 sketch）
{
  \"name\": \"translate-en-zh\",
  \"description\": \"English to Chinese translation, glossary-aware\",
  \"runtime_target\": \"claude-agent-sdk\",
  \"node_alias\": \"translate-en-zh\",
  \"input_schema\": { /* JSON schema */ },
  \"output_schema\": { /* JSON schema */ },
  \"system_prompt\": \"...\",
  \"tools\": [\"Read\", \"WebFetch\"],
  \"max_turns\": 10,
  \"max_budget_usd\": 0.10,
  \"timeout_ms\": 60000
}
```

SaaS 后端启动时把 skill 注册到 commhub（新 method `register_skill`，未来 RFC 议题），客户端调用：

```bash
POST /api/jobs
  { \"skill\": \"translate-en-zh\", \"input\": { \"text\": \"...\" } }
```

→ commhub 校验 input_schema → 派给对应 alias → 等 reply → 校验 output_schema → 返回。

> **现状**：以上 Skill 抽象 anet 尚未实现，目前 SaaS 用户需要自己在 API 网关层做 input/output 校验 + alias 路由。Skill 一级概念是后续 RFC 候选议题。

### 3.3 关键能力依赖 — SaaS 模式需要的 anet 升级

| 能力 | 当前状态 | 阻塞 SaaS 哪一面 | 依赖 RFC |
|---|---|---|---|
| 进度可见 / job status API | ❌ 静默 5min | 客户端 SaaS UI 转圈或假装进度，体验糟 | **RFC-003** |
| 结构化失败 / 重试可控 | ❌ raw error text | 客户端无法判断是 retryable 错误，不知道该退款还是重试 | **RFC-003** §1 ErrorCode |
| 任务超时 / 资源上限 | 🟡 maxTurns + maxBudgetUsd（仅 claude） | codex 端无 budget；无 wall-clock timeout | RFC-003 §A2 + 新 RFC |
| 节点不可达诊断 | ❌（issue #18 Round 5 A1）SSE 401 静默堆任务 | 客户报派单后无回应 | RFC-003 §A1 + 新 RFC |
| Skill 抽象 + schema 校验 | ❌ 无 | 客户端必须自己路由 alias，没有契约 | 新 RFC（候选）|
| 多租户配额 / 限流 | ❌ | 单大客户能占满 hub | 不计划 anet 实现，客户 API 网关层做 |
| 审计日志 | 🟡 commhub messages 表有，但无 retain 策略 | 法规 / 退款仲裁需要 | 客户需要单独配置 retention |
| Skill 版本管理 / 灰度 | ❌ | 升级 system_prompt / model 无回滚 | 新 RFC（候选）|
| SDK runtime 互操作 | ✅ 已支持（cli.ts 三 runtime 共存） | — | — |
| 本地 REPL 诊断 | ❌ 当前必须走 commhub | 客户出问题时 oncall 难定位 | **RFC-004**（anet node chat） |

`RFC-003` 是**最高优先级前置依赖**：它解决了 SaaS 客户端拿不到 \"job status\" 的核心问题。

### 3.4 计费 / SLA 注意事项（客户侧自实现）

anet 当前提供的可计费/可审计字段：

- `total_cost_usd` (claude `SDKResultMessage.total_cost_usd`) ✅
- `usage.input_tokens / output_tokens` ✅
- `duration_ms` ✅
- `permission_denials` (claude) ✅
- codex 端无 cost 自动算（用 token 数 + price 表自计算）⚠️

客户 API 网关需要追加：
1. **per-customer quota counter** — 拦截在 commhub 之前
2. **per-skill price markup** — anet 算的是 token cost，要加上服务利润
3. **SLA timer** — RFC-003 之后可订阅 progress timeline，超过 SLA threshold 自动 cancel + 退款
4. **PII / DLP 过滤** — 不要把客户数据无脑透传给上游 LLM provider

## 4. 与本地多 agent 协作模式的关系

anet 的核心价值是**多 Agent 在 dashboard 里协作**（人类 - planner - translator - coder 链式派单）。SaaS 模式是这个核心能力的**子集 + API-fy**：

- **本地协作模式**：dashboard chat / Telegram channel / Feishu / WeChat → commhub → multi-agent mesh → reply 回来给人
- **SaaS 模式**：外部 HTTP client → 你的 API 网关 → commhub → single agent or limited mesh → reply 回 client

二者**共用同一套** commhub + agent-node + SDK runtime + RFC-003 遥测层。**只是入口换 API + 输出走 SSE / webhook**。

## 5. 接下来该读

- [`RFC-003`](rfcs/RFC-003-node-telemetry-layer.md) — 遥测层 RFC（SaaS 前置依赖）
- [`docs-site/docs/guide/sdk-deep-dive.md`](../docs-site/docs/guide/sdk-deep-dive.md) — 两个 SDK 的能力对比（决定 Skill 用哪个 runtime）
- [`docs/architecture.md`](architecture.md) — anet 现有架构（commhub + agent-node + dashboard 三层）
- [`docs-site/docs/guide/runtimes.md`](../docs-site/docs/guide/runtimes.md) — 三种 runtime 的 how-to
- issue [#18](https://github.com/sleep2agi/agent-network/issues/18) — 本文的研究素材池

## 6. 备注

本文是 **sketch / 方向性架构文档**，不是落地清单。Skill 一级抽象、quota gateway、SLA timer 等需要**先看市场需求再立 RFC**。当前优先级：

1. RFC-003 落地（telemetry / 进度 / 失败可见）— 直接改善所有现有 anet 使用场景
2. RFC-004 落地（anet node chat REPL）— SaaS oncall 诊断刚需
3. 再回头评估 Skill 抽象 / quota 等 SaaS-specific RFC

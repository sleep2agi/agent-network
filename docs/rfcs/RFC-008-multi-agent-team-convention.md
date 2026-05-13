# RFC-008：multi-agent team convention — anet 第一个 team-scale demo (科研军团 / science-team)

| 字段 | 内容 |
|---|---|
| 状态 | **Proposed** |
| 提出 | 2026-05-13 |
| 作者 | 通信SDK马 |
| 派单 / 决策 | 通信龙（roadmap + issue #51 spec 整理 + dispatch） |
| Helpers | Vincent（telegram 4237-4277 spec iteration chain）, 通信工程马（parallel Phase 1 implement）, demo马（parallel Phase 1 implement） |
| 关联 issue | [#51](https://github.com/sleep2agi/agent-network/issues/51) 科研军团 demo / [#50](https://github.com/sleep2agi/agent-network/issues/50) dashboard topology layout (prerequisite) / [#18](https://github.com/sleep2agi/agent-network/issues/18) SDK research loop |
| 关联 RFC | RFC-003 node telemetry layer (复用 `report_progress`) / RFC-007 codex-cli-mcp **archived** (per Vincent 4175+4176, codex-sdk 已 cover) |
| 目标版本 | agent-network v2.2 (Phase 2 implement) + agent-network-dashboard 配合 issue #50 layout |
| 实施人 | 通信工程马（CLI batch create + leader fan-out logic）+ demo马（docker compose templates）+ N站马（dashboard team view, issue #50 prerequisite） |

## 摘要

给 anet 加 **team-scale convention**: 用户用 `anet demo science-team` 命令一键创建 N 节点 (5-50) 科研军团 (1 leader + N-1 researcher), 全员 `codex-sdk` runtime + intern (书生) model, 演示 **leader 智能 fan-out + worker 协作综述 + 整合输出** AI 研究综述 (per Vincent 4274 MVP 收窄 — research/综述 only, drop experiment/repro/meta-reflection).

**核心 design 决策** (per Vincent 4237-4277 telegram chain):
- 命名: 中文 `研究Leader` + `研究员1号 .. 研究员49号` (Vincent 4264-4265 final)
- Visually impressive (per Vincent 4264+4267) — Dashboard hub-and-spoke layout + live streaming + 50 节点 scale-aware (requires issue #50 layout improvement prerequisite)
- AI-focused (per Vincent 4270) — system prompt 专攻 LLM/RLHF/AI safety/scaling/reasoning
- LLM-决策 fan-out (per Vincent 4271) — researchers generalist by default, Leader 智能拆 sub-area, 不 hardcode roles
- MVP scope (per Vincent 4274): 综述 only (markdown 输出), drop code/experiment/repro/meta-reflection

## 1. 背景

### 1.1 anet 当前 demo 矩阵

| Demo | Scope | 角色数 | 协作模式 |
|---|---|---|---|
| `hello-world` | single-node baseline | 1 | n/a |
| `codex-telegram-squad` | single-node + telegram channel | 1 (+ bot) | n/a (channel-driven, not mesh) |
| `pr-review-room` | 多 reviewer + 1 judge | 3-5 | parallel + judge barrier (per RFC PR #41) |

**Gap**: anet 缺 large-scale team-orchestration demo, 不能演示 *真正 multi-agent mesh orchestration* (5-50 节点 + leader fan-out + aggregate)。`pr-review-room` 是 3-5 个 fixed-role agents, 不展示 *scale-aware mesh* + *LLM-决策 fan-out*。

### 1.2 Vincent telegram 4237-4277 spec iteration chain

- 4237-4249: 提出 demo 设计 (5-50 节点 + 书生 model + literature/experiment/paper 等任务)
- 4260: 简化为 2 角色 (leader + worker), 不要细分 reviewer/coder/analyst
- 4264-4265: final 命名 (中文 `研究Leader` + `研究员X号`)
- 4264+4267: visually impressive 要求 (跟 issue #50 layout 联动)
- 4270: 聚焦 AI research direction
- 4271: leader 智能 fan-out (per-task specialization, researchers generalist by default)
- 4273-4274: MVP 收敛 — 综述 + research only, drop experiment/repro/meta-reflection
- 4276-4277: GO Phase 1 scaffold (issue #51 base spec)

### 1.3 anet 第一个 team-scale demo 价值

- 演示 anet **scale-aware orchestration** (5-50 节点 readable + responsive)
- 演示 **LLM-决策 fan-out** vs hardcoded scheduler (intelligent task decomposition)
- 演示 **AI 研究真有用产出** (markdown 综述 报告) — 非 lorem ipsum / 演示性
- 配 B 站课程 / 视频 demo asset (Vincent telegram 4267 video plan)

## 2. 设计目标

| 目标 | 描述 |
|---|---|
| **G1 — 命名约定** | 中文 alias `研究Leader` + `研究员1号 .. 研究员(N-1)号` (per Vincent 4264-4265 final lock) |
| **G2 — 路径约定** | 默认 `~/intern-s/node1 .. nodeN/` (用户 wizard 可改). 每 node 含 `.anet/nodes/<alias>/config.json` 跟现有 single-node SOP 兼容 |
| **G3 — config metadata 扩展** | `config.json` 加 `team` (team identifier) + `role` (`leader` \| `worker`) + `systemPrompt` (AI research focus) optional 字段 |
| **G4 — Leader fan-out 协议** | Leader **LLM-决策** sub-area decomposition (不 hardcode), `commhub_send_task` fan-out 给 researchers, JSON task body format spec |
| **G5 — Aggregate 协议** | Workers reply leader, leader 收齐 → integrate → final reply 用户. 支持 partial / timeout / error handling |
| **G6 — 命名/路径/配置 不 break 现有 single-node 模式** | 新 fields optional + 默认值 backward compat / 现有 `anet node create` flow 不需要 team/role 才能跑 |

## 3. 命名 + 路径 + metadata schema

### 3.1 命名 final (per Vincent 4264-4265)

```ts
// Leader
const leaderAlias = "研究Leader";

// Workers (N-1 个, 中文数字 1..N-1)
const workerAliases = (N: number): string[] => {
  return Array.from({ length: N - 1 }, (_, i) => `研究员${i + 1}号`);
};

// 示例 N=10:
// ["研究Leader", "研究员1号", "研究员2号", ..., "研究员9号"]
// 示例 N=50:
// ["研究Leader", "研究员1号", "研究员2号", ..., "研究员49号"]
```

**约定细则**:
- 阿拉伯数字 `1 / 2 / 3 / ... / 49`, **不**用汉字 `一 / 二 / 三 / ... / 四十九`, **不**用字母 `A / B / Z`
- 跟 anet 现有命名 (claude-code-cli / codex-sdk / etc) 一致风格 (跟 Vincent 4265 一致 lock)

### 3.2 路径 约定

```
~/intern-s/                                 # 军团 root (用户 wizard 可改)
├── node1/                                  # Leader 工作目录
│   └── .anet/
│       └── nodes/
│           └── 研究Leader/
│               └── config.json             # 含 team + role + systemPrompt
├── node2/                                  # Worker 1 工作目录
│   └── .anet/
│       └── nodes/
│           └── 研究员1号/
│               └── config.json
├── node3/                                  # Worker 2 工作目录
│   └── .anet/
│       └── nodes/
│           └── 研究员2号/
│               └── config.json
...
└── nodeN/                                  # Worker N-1 工作目录
    └── .anet/
        └── nodes/
            └── 研究员(N-1)号/
                └── config.json
```

→ 每 node 独立工作目录 + 现有 `.anet/nodes/<alias>/config.json` SOP 不变 (per G6)。

### 3.3 config.json metadata schema 扩展

```ts
interface NodeConfig {
  // Existing fields (backward compat, 不动)
  alias: string;            // e.g. "研究Leader" / "研究员1号"
  runtime: RuntimeName;     // "codex-sdk" (per Vincent demo lock)
  model: string;            // "intern-s1-pro" (Vincent 4227 verified, lowercase, no /anthropic 后缀)
  baseUrl?: string;         // "https://chat.intern-ai.org.cn" (per Vincent 4227)
  apiKey?: string;          // 用户输入 INTERN_API_KEY (env var $INTERN_API)
  // ... other existing fields

  // NEW for team-scale (RFC-008)
  team?: string;            // e.g. "science-team" (optional, single-node 不填)
  role?: "leader" | "worker"; // optional (single-node 不填)
  systemPrompt?: string;    // optional, leader/worker 各自 AI-focused prompt (per §3.4)
}
```

**Backward compat**: `team` / `role` / `systemPrompt` 全 optional, 跟现有 `anet node create` 默认值 path 一致。Single-node `anet node create my-bot --runtime claude-agent-sdk` 不需要 team/role 字段。

### 3.4 systemPrompt content (per Vincent 4270 AI-focused)

**Leader systemPrompt** (`研究Leader.systemPrompt`):
```
你是 AI 研究方向的课题组长 `研究Leader`, 带领一个 N-1 人的研究团队 (研究员1号 .. 研究员(N-1)号), 通过 commhub 协作。

课题方向包括: LLM (架构/训练/评估) / RLHF / multi-agent systems / AI safety / scaling laws / agentic workflows / reasoning models 等。

接到用户研究任务后:
1. 自己 LLM 推理 sub-area decomposition (e.g. AI Infra / LLM 架构 / AI 统一生成 / RLHF / AI Safety / Reasoning), 根据 N 决定 sub-area 数量 + 每 sub-area researcher allocation
2. 用 commhub_send_task fan-out 给 researchers, 附 sub-area scope + task instruction (per RFC-008 §4.2 task body format)
3. Workers 独立调研 + reply 你
4. 你收齐所有 reply → integrate → markdown 综述 final 报告 → reply 用户

输出格式: markdown 综述 (含 title / abstract / N sub-area sections / references). Sub-area 深度 medium (~2k 字 total).
```

**Worker systemPrompt** (`研究员X号.systemPrompt`):
```
你是 AI 研究员 `研究员X号`, 隶属一个 N 人科研军团, 接 leader (研究Leader) 派的 sub-task 后独立完成 + reply leader。

你的 AI expertise 覆盖: literature review (arxiv 调研) / paper analysis (key contribution / methodology / limitation) / 综述 writing 任一种, 灵活应对。

任务接收 (commhub_send_task payload) 含:
- sub_area: 你负责的 AI sub-area (e.g. "AI Infra" / "LLM 架构" / etc)
- task: 具体调研要求
- expected_format: markdown subsection (~500 字)
- parent_task_id: 串回 leader 的 task ID

Reply 时简洁清晰, leader 会整合。**不写代码, 不跑实验**, 只做 literature review + 综述。
```

## 4. Leader fan-out 协议

### 4.1 Workflow (per Vincent 4271 LLM-决策)

```
1. 用户 prompt → 研究Leader (via telegram / dashboard / commhub_send_task)
   e.g. "全面 AI 综述, 覆盖主要前沿"

2. Leader LLM 推理 sub-area decomposition (内置 sub-area list per §4.3)
   - N=10 → 5 sub-area, each 2 researcher
   - N=50 → ~10 sub-area, each 5 researcher
   - Leader 决定 sub-area + researcher allocation

3. Leader 用 commhub_send_task fan-out 给 researchers (per §4.2 task body format)

4. Workers 独立处理 → 各自 send_task reply 回 leader

5. Leader 收齐 N replies → integrate (markdown stitch + 整合 transition)
   → final reply 给用户 (markdown 综述报告)
```

### 4.2 Task body JSON format (workers parse)

Leader fan-out 时 `commhub_send_task --alias 研究员X号 --task "<JSON>"`, task body 是 JSON string (跟 commhub_send_task 既有 string field 兼容):

```json
{
  "sub_area": "AI Infra",
  "task": "调研最近 6 个月 AI 训练 infra 进展, 涵盖训练框架 / 推理加速 / 分布式 systems / 训练硬件. 列 top 3 key papers + each paper contribution + 总体 trend. 注意: 不写代码, 不跑实验, 仅 literature review + 综述.",
  "expected_format": "markdown subsection (~500 字), 含 ## AI Infra title + 3-5 段 + references",
  "parent_task_id": "<leader's task ID>",
  "team": "science-team",
  "co_researchers": ["研究员2号"],
  "co_researcher_role": "你负责架构方向 papers, 研究员2号 负责 benchmark + tooling papers, 互相 send_task share findings"
}
```

→ Workers `JSON.parse(task)` 拿 sub_area / task / co_researchers / etc 字段。

**Worker parsing fallback**: 若 task body **不**是 valid JSON (e.g. user 派给 worker 而非 leader fan-out), worker treat as plain prompt 处理 (跟 single-node behavior 一致, backward compat per G6).

### 4.3 Leader 内置 sub-area list (per Vincent 4274 MVP)

```ts
const SUB_AREAS = [
  "AI Infra (训练框架/推理加速/分布式 systems/训练硬件)",
  "LLM 架构 (transformer 变种/MoE/state-space models/dense vs sparse)",
  "AI 统一生成 (multimodal: text+image+video/世界模型/agentic generation)",
  "RLHF / Alignment / preference learning",
  "AI Safety / eval / red-teaming",
  "Reasoning / agentic workflows / tool use",
] as const;
// 6 sub-areas total — N=10 取前 5, N=50 全 + maybe sub-divide 进 ~10 total
```

→ Leader systemPrompt 内嵌该 list, LLM 根据 user prompt 决定使用哪些 sub-area + allocation。

### 4.4 Allocation 默认值 (per Vincent 4274)

| N (军团人数) | Sub-areas 数量 | Each sub-area researcher count |
|---|---|---|
| 5 | 4 sub-areas (drop 1-2 lowest priority) | 1 researcher each |
| 10 | 5 sub-areas | 2 researcher each (per Vincent 4271 example) |
| 20 | 5-7 sub-areas | 3 researcher each |
| 50 | 8-10 sub-areas (Leader 自 sub-divide e.g. "LLM 架构" → "transformer" + "MoE" + "state-space") | 5 researcher each |

→ Leader LLM 决策, anet 不 hardcode allocation logic (Vincent 4271 explicit "智能 fan-out").

### 4.5 Timeout + retry + error handling

- **每 sub-task timeout**: 默认 5 min (per RFC-007 §8.6 watchdog pattern, anet 现 codex-sdk runtime turn timeout convention)
- **Worker fail / timeout**: leader 收 commhub_get_task → 看 `status: 'failed'` 或超时, 决定 retry (max 1 retry) 或 skip 该 sub-area
- **Partial aggregation**: leader 收 ≥ 80% replies (e.g. N=10 → 8 ok 即可 aggregate) 后 proceed 不等所有, missing sub-area mark `[未收到] partial result`
- **Final fail mode**: 若 ≥ 50% workers fail → leader reply 用户 "军团调研失败, M/N workers 未 reply" + 列已收到 partial 结果

## 5. Worker collaboration (within sub-area)

**Vincent 4271 Q1 open**: 多 researcher 同 sub-area 内部协作 pattern 4 选项:

| Option | 描述 | Trade-off |
|---|---|---|
| 🅰 Round-robin | 1 人先调研, 出初稿 → 2 人 review + iterate (类 peer review) | 顺序, 慢, 但质量 high |
| 🅱 Parallel split | 1 人调 papers A/B/C, 2 人调 D/E/F, 然后 merge | 并行快, 但 merge cost |
| 🅲 Spec by Leader | Leader fan-out 时 explicit 说 "1号 负责架构 paper, 2号 负责 benchmark paper" | 中心化, leader LLM load 重 |
| 🅳 自组织 | 让 2 人自己分工 (commhub 互相 send_task) → emergent | 灵活, 但 demo 不可预测 |

**RFC-008 建议 Phase 2 ship 🅲 (Spec by Leader)** + co_researchers field in task body (per §4.2):
- Leader fan-out 时 task body 含 `co_researchers: ["研究员2号"]` + `co_researcher_role: "你负责 X, 研究员2号 负责 Y, 互相 send_task share findings"`
- Workers 接 task 看到 co_researchers list → 主动 `commhub_send_task` 协调
- 优点: deterministic, demo 可预测, leader 自主控
- Phase 3 后探索 🅳 自组织 emergent pattern (per #51 follow-up)

**Open Q in §9** 等 Vincent confirm 4 选项。

## 6. Dashboard 显示约定 (per Vincent 4267 visually impressive)

### 6.1 Topology layout (跟 issue #50 联动, prerequisite ship 先)

- **Team grouping**: 同 `team` field 的节点 halo 圈起 + 同色 cluster (per Vincent 4267)
- **Leader-worker spoke**: Leader 中心 (radius 0) + N-1 worker 辐射 (radius 1) 布局
- **Scale-aware density**: N=5 各 node mini-card 大, N=50 各 node 缩小但仍 readable
- **Live status indicator**: idle / working / replying 颜色变化

### 6.2 Live progress timeline (复用 RFC-003)

- 每 node turn-by-turn thinking + tool call + agent message delta 流式
- 50 节点并行 streaming 视觉 impression strong (per Vincent 4267)
- timeline 按 team / sub-area 聚合 (per 通信龙 task §6)

### 6.3 任务流转可视化

- Leader send_task → workers 收 task (动画 / arrow flash)
- Workers reply → Leader aggregate (反向 arrow + counter "9/9 回")
- 最终 reply 用户 (highlight)

### 6.4 数量感

- 50 节点同屏布局 + scale-aware (5 / 10 / 20 / 50 不同 density 但都 readable)
- 节点 mini-card 显示 alias + role + last action snippet

### 6.5 输出质感

- 最终报告 markdown 格式漂亮 (有 title / abstract / sections / references)
- 不是 lorem ipsum, 是真有用 AI 综述

## 7. 兼容性

### 7.1 现有 single-node anet 不 break

- `team` / `role` / `systemPrompt` 全 optional → 单 node `anet node create my-bot --runtime X` 不需填
- 现有 `.anet/nodes/<alias>/config.json` SOP 不动
- 现有 `commhub_send_task` 不变 — worker 看 task body 不是 valid JSON 时 fallback 当 plain prompt 处理 (per §4.2)

### 7.2 现有 `anet node create` flow 兼容

- 新 wizard `anet demo science-team` 是 **higher-level** command, 内部 batch 调用 `anet node create` (per node)
- 没装 `anet demo` 的用户仍可 manually run `anet node create 研究Leader --runtime codex-sdk --model intern-s1-pro --config.team science-team --config.role leader` (CLI 支持 `--config.X` 字段透传, 跟现有 wizard 一致)

### 7.3 现有 commhub MCP tools 不变

- `commhub_send_task` / `commhub_reply` / `commhub_get_task` / `commhub_get_all_status` 不需要新字段
- Leader/worker 用 task body JSON format (per §4.2) 是 application-level convention, 不 commhub schema 改动

## 8. Phase 实施

### Phase 1 (~1-2 days, 工程马 + demo马 parallel implement 不依赖 RFC-008)

per 通信龙 task body, Phase 1 scaffold 不依赖 RFC-008 spec, 基于 issue #51 base spec 已够:

- `demos/science-team-{5,10,20,50}/docker-compose.yml` template (写死, 4 size variants)
- `.env.template` 含 INTERN_API_KEY placeholder
- 验证 leader fan-out + worker aggregate work (manual prompt)
- Dashboard 显示 N 节点 OK (跟 issue #50 layout 联动, **issue #50 必须先 ship 配合 50 节点 readable**)

→ Phase 1 ship 后 `cd demos/science-team-10 && docker compose up` 即跑 10 节点 demo

### Phase 2 (~3-5 days, 通信工程马 implement, RFC-008 spec ready 后)

- `anet demo science-team` 真正 batch command (per §3 + §4 spec):
  - Wizard 交互 (Intern API key / 军团人数 / 工作目录 / 综述方向)
  - 自动 mkdir + register + login + batch `anet node create` + launch
  - 错误处理 (count 超出 / API key 无效 / 目录已存在等)
- Leader fan-out logic implement:
  - Leader systemPrompt 注入 (per §3.4)
  - JSON task body 解析 (worker side)
  - aggregate timing + partial / timeout / retry logic (per §4.5)
- Worker collaboration 🅲 Spec by Leader pattern (per §5 default)

### Phase 3 (~1 week, N站马 dashboard team view + 通信工程马 Phase 2 polish)

- N站马 Dashboard team 聚合视图 (跟 issue #50 一起):
  - Team halo 圈
  - Leader-worker spoke layout
  - Live progress timeline 按 team / sub-area 聚合
  - Scale-aware density (5/10/20/50)
- 多 team 并存测试 (e.g. `science-team` + `engineering-team` 同时跑)
- Demo asset 录屏 / B 站课程视频 (per Vincent 4267 + task #58 协同)

### Phase 4 (backlog, when 用户 ask)

- Worker collaboration 🅳 自组织 emergent pattern (per §5 Phase 3 后探索)
- Non-AI domain teams (e.g. `dev-team` / `product-team`)
- Multi-team coordination protocol (cross-team fan-out)

## 9. Open Questions

1. **Worker collaboration pattern (per Vincent 4271 Q1)** — 4 options A/B/C/D, RFC propose 🅲 Spec by Leader default for Phase 2 ship. Vincent confirm? 或允许 wizard 选?
2. **综述深度 (per Vincent 4271 Q2)** — shallow ~500 字 / medium ~2k 字 / deep ~5k 字. RFC propose `medium` default (Vincent 4274 spec 含 "~2k 字 total"). wizard 选项?
3. **输出 format (per Vincent 4271 Q3)** — `markdown` (default per Vincent 4274) / `LaTeX paper draft` / `HTML 网页`. Phase 1 ship `markdown` only, Phase 2/3 加 LaTeX/HTML 视用户需求.
4. **Sub-area allocation overlap** — Vincent 4271+4273 sub-area number range 例 (1~2号 Infra, 2~3号 统一生成) 2号 重叠. RFC 默认 **strict non-overlap** (per researcher 1 sub-area), Vincent 4271 例视为 illustrative. Confirm?
5. **Custom 综述方向** — wizard 默认 "全面 AI 综述", 6 个专题, "自定义 prompt" 5 选项. Custom prompt 时 leader systemPrompt 是否 dynamic adjust (e.g. user 输 "区块链综述", leader 应跳出 AI scope 还是仍 AI-focus)?
6. **Issue #50 prerequisite gate** — Phase 1 ship 前必须 issue #50 N站马 dashboard layout 改进 ship (否则 50 节点 看不清)。Confirm gating order?
7. **Demo asset (video / screencast)** — Phase 1 / 2 / 3 哪个阶段录屏 (per Vincent 4267 + task #58 B 站课程协同)? Phase 1 docker compose prototype 是否 sufficient?
8. **API key 安全** — `apiKey` field 写 config.json plaintext OR env var `$INTERN_API` placeholder + 运行时 inject? RFC propose env var (跟 anet 现 SOP 一致, 不写 plaintext to disk).
9. **MVP scope 实际产出 verify** — Vincent 4274 "Demo 目的: 展现 anet 编排能力 + 实际科研产出". Phase 1 prototype 跑出来的 markdown 综述 是否真有用 (vs lorem ipsum 检验)? 须 Phase 1 ship 后 Vincent / 我们亲测验证质量。

## 10. 实施 timeline (Phase 1 进行中 parallel)

**Day 1 (today 2026-05-13)**:
- ✅ 通信工程马 + demo马 implement Phase 1 scaffold (并行)
- ⏳ 通信SDK马 ship RFC-008 v1 (本 commit, ~1-1.5h)
- ⏳ 通信龙 review RFC-008 + Vincent §9 Open Q decision

**Day 2-3 (Phase 1 ship + #50 prerequisite)**:
- N站马 issue #50 dashboard layout ship (per §9 Q6 gating)
- Phase 1 docker compose template 4 sizes ship
- `cd demos/science-team-10 && docker compose up` smoke test

**Day 4-7 (Phase 2 implement)**:
- 通信工程马 implement `anet demo science-team` batch command + leader fan-out logic
- 通信测试马 add `tests/test29-science-team-e2e/` (类比 PR #43)

**Day 8-10 (Phase 3 polish)**:
- N站马 dashboard team view 完善
- demo asset 录屏 (per §9 Q7)
- B 站课程 task #58 协同

## 11. 结论

✅ **anet 第一个 team-scale demo spec ready** — 科研军团 (1 leader + N-1 researcher, N=5..50)
✅ **LLM-决策 fan-out architecture** — Leader 智能 sub-area decomposition, 不 hardcode
✅ **现有 single-node anet 不 break** — team/role/systemPrompt 全 optional
✅ **AI-focused per Vincent 4270** — 聚焦 LLM/RLHF/AI safety/scaling/reasoning expertise
✅ **MVP scope 收敛 per Vincent 4274** — 综述 only, markdown 输出, drop code/experiment/repro
🟡 **9 Open Questions** — 大部分 RFC 默认推荐, Vincent confirm 重点 Q1 worker collab pattern / Q5 custom 综述方向 / Q6 #50 gating / Q9 实际产出 verify

后续动作:
- Phase 1 scaffold ship (工程马 + demo马 并行, 不依赖 RFC-008)
- 通信龙 review RFC-008 + Vincent §9 Open Q decision
- Phase 2 implement post-review (per §10 Day 4-7)
- N站马 issue #50 ship 前 (per §9 Q6 gate) 配合 Phase 1 prototype demo

— END —

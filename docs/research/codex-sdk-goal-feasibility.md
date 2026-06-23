# anet /loop SDK 方案 — codex + grok runtime 自实现 + 与 Claude Code 原生 /loop 隔离

**作者**: 通信SDK马 (lead) · 联合 通信SDK牛
**状态**: Draft v0.4 (通信龙 review1 反馈 fold + grok 可行性 spike 落地; review2 pending)
**关联**:
- Vincent dispatch via 通信龙 2026-06-23 — "claude-code-cli 走原生 /loop; codex-sdk + grok-sdk 由 anet 自实现; 两套必须隔离不打架"
- 通信龙 review1 2026-06-23 — 防串 airtight 三点 (不拦原生 /loop; runtime 切换 spec; grok 可行性 spike)
- 旧版 v0.2 (2026-05-21, 9e8b8f1) — 推荐 "runtime-agnostic 单一 scheduler 同时服务 claude + codex" 已**被新约束 superseded**, 保留作 history
- issue #184 — Phase 1 已落地 (`agent-node/src/goals/{parser,store,types}.ts`)

---

## 0. delta history (TL;DR)

### v0.3 → v0.4 (通信龙 review1 fold)

- **§3.4 (b) hands-off 钉死**: anet 在 claude runtime 上**完全不注册** /loop 拦截器; 不存在 "anet 检测到再 forward"。原生 /loop 在 SDK turn 路径上 transparent (改了示例代码 + 加了"核心原则"段)。
- **§3.4 (2) runtime 切换 spec**: 4-row 处理矩阵 (codex→claude 报警 archive; codex↔grok 报错停; 一致 resume); 全程 0 orphan、不偷偷迁移。
- **§2.2 grok spike**: 4 项验证落地 (session/prompt 通用 turn / 跨进程 cold-resume / isReplay 过滤 / session expire 兜底走 #213), P2 不阻塞器。

### v0.2 → v0.3 delta

| 维度          | v0.2 (旧)                                                | v0.3 (新, Vincent confirmed direction)                                       |
|---------------|----------------------------------------------------------|------------------------------------------------------------------------------|
| scheduler 范围 | runtime-agnostic, 服务 claude + codex 两类 agent          | **只服务 codex + grok**; claude 由 Claude Code 原生 /loop 兜底, anet 不接管 |
| runtime 覆盖   | codex-sdk 为主, claude-sdk 顺带                          | codex-sdk + grok-build-acp 双轨; claude 显式 exclude                       |
| 隔离机制       | 未要求 (假设 claude harness 自带 + anet 也可重复服务)    | **🔴 硬约束**: anet 在 claude runtime 必须 hands-off, goals.json 不收 claude 条目, /loop slash 命令在 claude runtime 拒绝接管 |
| 防串保证       | n/a                                                       | 启动期 + 创建期 + 切 runtime 期 三重 assert                                |

**核心动机** (Vincent 视角): claude-code-cli 已有成熟的 `CronCreate` / `ScheduleWakeup` + `/loop` skill, anet 重复实现是浪费 + 易冲突; 但 codex-sdk / grok-build-acp 这两类 runtime 没有任何自调度原语 (§2 已验), 没 anet scheduler 就完全跑不起来 /loop 类自主任务。所以 anet scheduler 范围必须**裁剪精准**: 是 codex+grok 的 prosthetic, 不是 claude 的 redundancy。

---

## 1. 背景 & 问题拆解

`/loop` (旧名 `/goal`) = Vincent 设一个目标 → agent 周期性进度自检 + 汇报 + 更新 issue, 直到目标闭环。三个能力:

1. **周期自唤醒** — "N 分钟后自己再被唤醒一次"。
2. **周期汇报** — 给 Vincent / issue 发进度。
3. **跨 wake 目标态保持** — 跨多次唤醒记得目标 & 进度。

**Runtime 矩阵** (`agent-node/src/cli.ts:244-251` 的 `RUNTIME` 三值常量):

| RUNTIME 值 | runtime 名 (npm/CLI)            | /loop 调度归属                                              | 备注                                                                |
|------------|--------------------------------|-------------------------------------------------------------|---------------------------------------------------------------------|
| `claude`   | claude-agent-sdk / claude-code-cli | **Claude Code 原生 /loop** (CronCreate + ScheduleWakeup skill) | harness 自带; agent-node spawn 的 `claude` 二进制在 session 内拦截 |
| `codex`    | codex-sdk / `@openai/codex-sdk` | **anet 自实现 scheduler** (本方案 Phase 2)                  | codex 协议无 schedule 原语 (v0.2 §2 已验)                          |
| `grok`     | grok-build-acp                  | **anet 自实现 scheduler** (本方案 Phase 2)                  | grok agent stdio ACP, 也无 schedule 原语 (Phase 2 实施前 spike 验) |

---

## 2. Q1 — codex / grok 有无 native scheduling 原语?

### 2.1 codex (v0.2 验证, 保留结论)

- **codex app-server (stdio) 协议**: grep `agent-node/src/types/codex/` 71 个 vendored ts-rs schema, `schedul / timer / cron / wake / interval / periodic / defer / goal` **零命中**。面只有 `Thread* / Turn* / Item* / Command* / Mcp* / *ToolCall* / RemoteControl* / WebSearch*`。
- **`@openai/codex-sdk@0.132.0` npm 包**: `codex exec --experimental-json` 薄封装。导出面 `Codex / startThread / resumeThread / thread.run / thread.runStreamed`。无任何 schedule / wake / cron / background。

→ codex 是被驱动的, scheduler 必须**外部**。

### 2.2 grok-build-acp (v0.3 新增; v0.4 spike 落地)

agent-node 与 grok 走 ACP (Agent Client Protocol):  `grok agent stdio`。grok runtime 在 anet 中:
- 入口: `agent-node/src/runtime/grok-build-acp/` (client.ts, events.ts, resume-hint.ts, timeout-resolve.ts, runtime.ts)
- session id 写回机制: `cli.ts:369-376` (`grokSessionId` + `fileConfig.grokSession`)。
- resume 路径: `cli.ts:957-965` `HAD_GROK_SESSION_AT_BOOT` + `grokResumeHintFired` 一次性 hint (#213)。
- 协议层: ACP — 跟 codex 一样是 request-response + 流式 turn 通知, **无 schedule 原语** (ACP spec 与 Claude Code MCP 类似, agent 不能 self-trigger turns)。

→ grok 跟 codex 同样 driven。anet 必须从外面 wake 它。

**v0.4 feasibility spike** (通信龙 review1 要求验, 不假设):

| 验证点                                     | 结论                                                                                                    | 证据                                                                                |
|--------------------------------------------|---------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------|
| ACP `session/prompt` 能跑非 user-driven turn? | ✅ 可                                                                                                  | `client.ts:122-129` — `session/prompt` 是流式 + 长 idle 允许 (300s), 不限 caller 类别 |
| 跨进程 cold-resume grok session?           | ✅ 已实证                                                                                              | `cli.ts:957-965` `HAD_GROK_SESSION_AT_BOOT` + `cli.ts:310-313` sessionId fallback chain — agent-node 已经在重启场景做这事 |
| 历史 turn 不会污染 wake turn?              | ✅ 已 mitigation                                                                                       | `events.ts:3-5` — `session/load` 历史 chunks 带 `_meta.isReplay=true`, reducer 显式过滤 |
| session expire (grok 后端 TTL)?            | ⚠️ 未知, 需 P2 实施期监测                                                                              | grok-build-acp 协议不暴露 TTL; 兜底走 #213 resume-hint 提示 Vincent (已实现路径)    |

**结论**: P2 可直接复用 `cli.ts` 现有 grok 单 turn 路径 (`grokAcpRunTurn` 类入口) + agent-node-internal scheduler 调它, **不需要新 ACP 原语**。grok wake = 跟普通 task 处理同路径, 只是 prompt 由 scheduler 合成而非来自 commhub task body。session-expire 是已知风险 (跟普通任务一致), workaround 复用 #213 resume-hint, 不构成 P2 阻塞器。

### 2.3 claude (本方案 explicit exclude)

claude-agent-sdk runtime spawn 出的 `claude` 二进制带 Claude Code harness, harness 内置:
- `CronCreate` (cron expression 持久 schedule)
- `ScheduleWakeup` (一次性 delay 唤醒)
- `/loop` skill (bundled, 见 `/home/vansin/.claude/.../skills/loop` 等)

→ claude runtime 上 /loop 已**完全自给**, anet **不接管 / 不重复实现 / 不写 goal record**。

---

## 3. v0.3 设计 — 5 维 covered

### 3.1 ① anet loop 驱动实现

**接口**: `agent-node/src/goals/scheduler.ts` (Phase 2, 尚未实现)

```ts
// 伪码草案 — 真实接口待 review 后实现
export class GoalScheduler {
  constructor(
    private store: GoalStore,
    private runtime: "codex" | "grok",     // ← P0: 类型层就排除 "claude"
    private wake: (goal: AgentGoal) => Promise<void>,
  ) {}

  async start(): Promise<void> {
    // 加载 goals.json, schedule 每个 active goal 的 next_wake_at
    // 单线程串行 + 每个 wake 失败时 jitter retry (复用 #168 backoff)
  }
}
```

**wake 实现**:
- codex: `resumeThread(codex_thread_id)` + `thread.run(synth_prompt)`, prompt 里塞 goal 当前态 (从 goals.json 取)。
- grok: ACP `session.prompt`(grokSessionId, synth_prompt) — 复用 cli.ts 现有 grok 单 turn 路径; 若 session 已 expire 用 resume-hint 通知 Vincent 走 #213 路径。

**调度循环**: 单进程 setInterval 轮询 (粗粒度 30s tick), 找 `next_wake_at <= now && status==='active'` 的 goal, 执行 wake; wake 完成后 mutate goal 设 `last_wake_at = now; next_wake_at = now + interval_ms; progress_log.push(...)`. Mutex (已有 `GoalStore.mutex`) 防 wake 期间 /goal cancel 抢写。

### 3.2 ② runtime 检测 + 分流

**检测点**: `cli.ts:251` `RUNTIME` 常量 (单一权威, "claude" | "codex" | "grok")。

**分流逻辑** (Phase 2 接入处):

```ts
// agent-node/src/cli.ts 启动期 (in addition to 现有 RUNTIME 解析后)
if (RUNTIME === "claude") {
  // claude runtime: 不启动 GoalScheduler, 不加载 goals.json
  // 不在 commhub task 处理路径上拦截 /loop /goal slash command
  log("anet scheduler: skipped (claude runtime — using Claude Code native /loop)");
} else {
  // codex / grok: 启 anet GoalScheduler
  const scheduler = new GoalScheduler(goalStore, RUNTIME, wakeFn);
  await scheduler.start();
}
```

**slash command 拦截**:
- claude runtime: 不在 anet 侧拦 `/loop` / `/goal` — Claude Code harness 在 claude session 内会自然处理。
- codex / grok: anet 在 commhub task body 解析阶段 detect `^/(?:goal|loop)\b` (parser.ts:72 已支持), 转 GoalStore.upsert(parser 产物) 而不是 forward 给 SDK turn。

### 3.3 ③ 循环状态/调度持久化

**已落地** (Phase 1):

- `~/.anet/nodes/<alias>/goals.json` — `GoalsFile { version: 1, goals: AgentGoal[] }`
- atomic write: tmp + POSIX rename (store.ts:198)
- corruption recovery: `<path>.corrupt.<iso-ts>` backup + 空白启动 (store.ts:73-114)
- 单写者 mutex: `Mutex` (store.ts:26-39) 串行所有 mutation

**v0.3 必须额外保证 (Phase 2 加)**:

- `AgentGoal.runtime` 字段 (types.ts:37) 已存在 — Phase 2 `newGoal()` 调用方必须传入 cli.ts 解析的 `RUNTIME` 值, 不允许 hard-code。
- store 层 validate: `upsert` / `newGoal` 时 assert `runtime in {"codex","grok"}` — 拒绝 claude 条目流入。具体见 §3.4 第 1 条。

### 3.4 ④ 防串机制 (🔴 Vincent 新约束硬要求)

**核心原则 (v0.4 强化)**: 🔴 anet 对 Claude Code 原生 /loop **完全 hands-off**。anet 不 parse、不拦截、不包裹、不 forward、不 detect 原生 /loop slash command。原生 /loop 走原本 (commhub task body → claude SDK turn → harness 内置 skill 处理), anet 在该路径上是 transparent pipe。任何"拦了再 forward"的中间层 = 仍然算碰了原生 = 违规。

**三重 defence**:

1. **Goal 创建期 assert** — `goals/store.ts` 新增 helper `assertNonClaudeRuntime(rt: string)`:
   ```ts
   export function assertNonClaudeRuntime(rt: string): void {
     if (rt === "claude" || rt === "claude-agent-sdk" || rt === "claude-sdk") {
       throw new Error(
         `anet goal scheduler does not serve claude runtime — ` +
         `use Claude Code native /loop (CronCreate / ScheduleWakeup) instead`
       );
     }
   }
   ```
   `newGoal()` 入口 + `GoalStore.upsert()` 入口都调一次。等于 schema-level 排除 claude。

2. **启动期 runtime-switch 处理** (v0.4 明确 spec, 不偷偷迁移):

   节点 alias 持久, 但 `--runtime` 可在重启时切换。startup 期检测 `RUNTIME` vs `goals.json` 现有 entries 的 `goal.runtime` 字段:

   | 起始 runtime | goals.json 状态                              | 处理                                                                                              |
   |--------------|----------------------------------------------|---------------------------------------------------------------------------------------------------|
   | `claude`     | 空                                           | no-op, 跳过 scheduler 启动                                                                       |
   | `claude`     | 有 active codex/grok 条目                    | 全部 `status=cancelled`, `reason="runtime-switched-to-claude"`, `progress_log` 追加一条, `next_wake_at` 清空; archive 整个文件到 `goals.json.runtime-switched.<iso-ts>`; 起空 store。**报警日志 + 跳过 scheduler**, 不偷偷迁移、不偷偷 wake |
   | `codex`      | 有 grok 条目, 反之亦然                       | startup **报错停**: `goals.json 内有 X 个 grok runtime goal, 但当前以 codex 启动 — 拒绝运行, 请先 /goal cancel 或手动 archive`。grok thread/session ID 不能映射到 codex thread, 偷偷跑等于跨 runtime 串。 |
   | `codex/grok` | 自己 runtime 条目 (一致)                     | 正常 resume, scheduler 启动                                                                       |

   防止用户切换 runtime 后 (a) 旧 goal 继续 wake 一个已经不存在的 thread (b) 旧 goal 被 anet 在 claude runtime 上 wake → 冲 Claude Code 自己的 cron 双发 (c) 跨 SDK runtime 的 goal 串。

3. **Slash command 路由分流** — anet commhub task body parse (v0.4 改: 不再 forward):
   ```ts
   // claude runtime: anet 完全不 parse /loop /goal — 让消息原样进 claude SDK turn,
   // harness 自然处理 native /loop。anet 在 claude runtime 上根本不注册这层拦截。
   if (RUNTIME !== "claude") {
     const isLoopCmd = /^\s*\/(?:goal|loop)\b/.test(body);
     if (isLoopCmd) {
       await handleLoopCreate(body, RUNTIME);   // codex / grok: anet 接管
       return; // 不进 SDK turn
     }
   }
   // 其它路径不变, 包括 claude /loop /goal 都走原本 SDK turn 路径
   ```
   关键差异 vs v0.3: claude runtime 下 anet **不注册** /loop 拦截器, 不存在 "anet 检测到再 forward" 这一步。原生 /loop 在 claude session 内被 harness 处理时, anet 视角是"普通 task body 进 SDK turn", 完全 transparent。

**双跑探测** (软保障): `goals/scheduler.ts` 启动时 emit 日志 `scheduler: runtime=<X>; covering=<goal_count>`; claude runtime 此行恒为 `skipped (claude runtime; native /loop handled by Claude Code harness)`。Dashboard (#168 / RFC-019) 后续可消费这字段, surface "node X 在哪套 loop 引擎上"。

### 3.5 ⑤ MVP + 分阶段

| Phase | 范围                                                                                       | 估期    | 已落地? | 责任       |
|-------|--------------------------------------------------------------------------------------------|---------|---------|------------|
| P0    | runtime gate: `assertNonClaudeRuntime` + claude-side 启动期 archive-stale + slash 路由分流 | 0.5d    | ❌      | 通信SDK马  |
| P1    | codex GoalScheduler 实现: tick loop + resumeThread+run wake + 进度写回 + 汇报 (commhub_send_task) | 1.5d  | ❌ (Phase 2 of #184) | 通信SDK马 |
| P2    | grok-build-acp 适配: ACP session.prompt 复用 + grokSession resume 路径 + session-expire hint 走 #213 | 1d | ❌ | 通信SDK马 + 通信SDK牛 (resume-hint 已牛 lane) |
| P3    | commhub server scheduler (北极星): 把 goals 上移到 commhub-server, 扛 agent-node 重启 + Dashboard 可观测 | 3-5d | ❌ | 通信牛 lane (commhub-server) |
| P4    | UAT + 双 runtime smoke: docker codex + grok 节点各跑一个 /loop 实证 30min, 验证 claude 节点完全不创建 goal | 0.5d | ❌ | 通信测试马 |

**MVP = P0 + P1 + P4** (~2.5d, 单纯 codex /loop 端到端可跑, claude 端隔离已保证)。
**完整 = P0–P3 + P4** (~6-7d)。

P3 是 v0.2 提的 "北极星", v0.3 没改它的定位 — 只是把 P0 这层 gating 显式加在 MVP 之前。

---

## 4. Open / 待 Vincent 拍

1. **`/loop` 闭环判定**: 谁判目标达成?
   - (a) agent 自判 `status=complete` (codex/grok 在 wake prompt 里回复 "complete")
   - (b) Vincent 手动 `/goal cancel <id>`
   - (c) issue close 触发 (需 commhub-server 监 GitHub webhook → P3 范围)
   v0.3 倾向 P1 先实现 (a)+(b), (c) 进 P3。
2. **slash command 在 codex/grok 是 commhub task body 内拦, 还是 anet 暴露独立 MCP tool (`anet_loop_create`)?**
   倾向 commhub task body 拦 (跟 /goal 历史一致, 用户体感无差); MCP tool 进 backlog。
3. **同一 alias 切换 runtime 时旧 goal 归档保留多久?** v0.3 默认无限保留 (archive 文件不自动删), 配 `--archive-retain-days` 可选。

---

## 5. 与 v0.2 关系 (history 保留)

v0.2 (2026-05-21, 9e8b8f1) 写于 #184 立项期, 当时 Vincent 没有显式要求 "anet scheduler 不接管 claude"。v0.2 §5 推荐 "Path A runtime-agnostic, 顺带统一 claude-sdk /goal" 在 v0.3 被**撤回** — 不是 v0.2 错了, 是 Vincent 现在加了边界。v0.2 的 codex 路径分析 §2、Path A 持久化设计 §4、commhub Path B 北极星 §3 全部保留 (本文 §2.1 / §3.3 / P3 直接引用)。

v0.2 中 "claude-sdk 用 anet 一等 scheduler" 这一句是 v0.3 与之冲突的唯一点; v0.3 把它替换为 "claude-sdk 用 Claude Code 原生 /loop, anet hands-off"。

---

**Status**: Draft v0.3, 发 通信龙 review。review 通过 → Vincent confirm → 进 #184 Phase 2 实施 (P0 + P1 + P2)。

**作者**: 通信SDK马 · 2026-06-23

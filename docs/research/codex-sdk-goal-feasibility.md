# codex-sdk runtime /goal 支持 — feasibility / 设计 note

**作者**: 通信SDK马(lead) · 联合 通信SDK牛
**状态**: Draft v0.2(SDK牛 `@openai/codex-sdk` npm 侧 finding 已 fold;待 通信龙 review)
**关联**: Vincent dispatch via 通信龙 2026-05-21 — "让 codex-sdk runtime 支持 goal 功能"

---

## 1. 背景 & 问题拆解

`/goal` = Vincent 设一个目标 → agent 周期性进度自检 + 汇报 Vincent + 更新 issue,直到目标闭环。拆成 3 个能力:

1. **周期自唤醒** — "N 分钟后自己再被唤醒一次"。
2. **周期汇报** — 给 Vincent / issue 发进度。
3. **跨 wake 目标态保持** — 跨多次唤醒记得目标 & 进度。

今天 `/goal` 只在 **claude-code-cli** runtime 能用 —— 关键认知:**这不是 anet 的能力,是 Claude Code 这个 *harness* 自带 `CronCreate` / `ScheduleWakeup` 工具 + skill**。agent-node 的 `processWithClaude` 路径 spawn 的 claude 二进制带这些工具。codex-sdk runtime 走 `@openai/codex-sdk` / `codex app-server`,**没有这个 harness**。

## 2. Q1 — codex 有无 native scheduling 原语?

**两条 codex 路径都查了,都没有。**

### 2.1 codex app-server (stdio) 协议 — 通信SDK马 dig

grep agent-node 内 vendored 的 codex app-server v2 协议(`src/types/codex/`,71 个 vendored ts-rs schema)—— `schedul` / `timer` / `cron` / `wake` / `interval` / `periodic` / `defer` / `goal` **零命中**。

v2 方法/通知面全部是:`Thread*` / `Turn*` / `Item*` / `Command*` / `Mcp*` / `*ToolCall*` / `RemoteControl*` / `WebSearch*` —— 纯 coding-agent 的 request-response + 流式通知,**无任何时间/调度/goal 概念**。`codex-stdio-client.ts` 的 RPC 面只有 `request()` / `notify()` 同步原语。

### 2.2 `@openai/codex-sdk` npm 包 — 通信SDK牛 dig

实测 `@openai/codex-sdk@0.132.0`:它是 `codex exec --experimental-json` 的**薄封装**,不是 app-server JSON-RPC client。导出面只有:
`new Codex(options)` / `codex.startThread()` / `codex.resumeThread(id)` / `thread.run(input, turnOptions)` / `thread.runStreamed()`。
`TurnOptions` 只有 `outputSchema` / `signal`;`ThreadOptions` 只有 model / sandbox / approval / workingDirectory / webSearch / additionalDirectories。**无 `goal` / `schedule` / `wake` / `timer` / `cron` / `background`。**

SDK 行为(fake codex binary 实测):每次 `thread.run()` spawn 一次 `codex exec --experimental-json`;resume 传 `... resume <threadId>`。`startThread()` 初始 `thread.id=null` → 收 `thread.started` 事件后置;`resumeThread(id)` 立刻置 `thread.id`。

> **结论**:codex 的**两条路径(app-server stdio 协议 + `@openai/codex-sdk` 包)都没有自唤醒/调度/goal 原语**。codex 是被驱动的(driven)—— 每个 turn 由外部喂 prompt。codex-sdk agent **无法自己定时唤醒自己**。scheduler 必须放在 codex runtime *之外*。

## 3. Q2 — 可行路径(scheduler 在 codex 之外)

### Path A — agent-node 侧 scheduler 【推荐 MVP】

agent-node 本就是常驻进程、已有 `setInterval`(`reportStatus` 每 3min,`cli.ts:1454`)。加一个 goal scheduler 模块:

- 收到 `/goal` 任务 → 记录 goal 到 `.anet/nodes/<alias>/goals.json`:
  `{ goal, issue_url, interval_min, started_at, last_check_at, next_wake_at, progress_log[], codex_thread_id, status }`
  (`status` ∈ active/paused/complete/budgetLimited)
- 定时器到点 → `resumeThread(codex_thread_id)` 后 `run(合成的 goal 进度自检 prompt)` —— prompt 里**显式塞进当前 goal 态**。
- agent-node 重启后 reload `goals.json` 续跑。

**成本**:中。纯 agent-node = SDK马 lane,单模块。**runtime-agnostic** —— 同一个 scheduler 同时服务 codex-sdk 和 claude-sdk → `/goal` 从"靠 Claude Code harness 碰巧有 cron"升级成 **anet 一等能力**,不再绑 runtime。
**局限**:agent-node 进程 down 时不推进(跟 Claude Code session-scoped cron 同限)。

### Path B — commhub 侧定时 dispatch 【架构北极星】

commhub server 跑 scheduler,到点 `send_task` 一条 "goal check" 给 agent,agent 当普通 task 处理。goal 态存 commhub(goal row)。

**成本**:commhub-server 改动 = 通信牛 lane,需 server scheduling 基建(当前可能没有)。
**优点**:runtime-agnostic + 扛 agent-node 重启(agent 离线时 task 进 inbox 排队)+ goal 态 server 端可查 / 上 Dashboard —— 跟 #168 `last_*` observability 同方向。是更优的长期架构。

### Path C — 宿主 crontab / systemd timer 调 `anet` 发任务

粗糙、绑宿主、不可移植。**否决**。

## 4. Q3 — 另两半怎么做

- **周期汇报**:wake 后 codex-sdk agent 跑一个 turn,prompt 含 "查进度 + 汇报"。给 Vincent = `commhub_send_task` 指挥室;给 issue = agent 有 Bash/gh 或 commhub MCP 工具(`commhub-mcp.ts`)。**无需新原语 —— 就是 prompt + 已有工具。**

- **目标态保持 — 必须外部持久化,不能只靠 codex thread 记忆**(SDK牛 finding 强化):
  - codex thread resume(`resumeThread`)能续对话上下文(thread 持久化在 `~/.codex/sessions`)—— 但那是**语义记忆,不是可查询的可靠状态机**。
  - SDK **不暴露** `thread/goal/set/get/clear`,app-server 协议也没有(§2)。
  - **风险点**:agent-node 当前只在 turn *完成后* writeback session(`writebackSession`,`cli.ts:294`)—— 若首轮中途崩,`codex_thread_id` 可能没落盘 → 重启后无法 resume,goal 也丢。Path A 的 scheduler **必须在 goal 创建时就持久化 `codex_thread_id`**(thread.started 事件一到就写 `goals.json`),不能复用现有 turn-complete writeback。
  - goal 的 `status` / `next_wake_at` / `last_report` / issue-sync 状态需要**结构化可查询**,只能放外部存储。
  - → **codex thread = 工作上下文续期;goal/scheduler/issue-sync 权威态 = `goals.json`(Path A)或 commhub(Path B)**。每次 wake 把外部 goal 态显式塞进 prompt。

## 5. 推荐

- **MVP = Path A**:agent-node 侧 runtime-agnostic goal scheduler + 本地 `goals.json`。最快落地、纯 SDK马 lane、顺带统一 claude-sdk 的 `/goal`。
- **北极星 = Path B**:commhub recurring dispatch,扛重启 + server 端可观测,跟 通信牛 联合评估为 v-next。两者**不互斥** —— Path A 的 `goals.json` 后续可由 commhub 背书。
- 建议 Vincent review 后:先 Path A MVP,Path B 进 backlog。

## 6. open / 待 Vincent 定

- `/goal` 闭环判定:谁判目标达成?(agent 自判 `status=complete` / Vincent 手动 close / issue close 触发)—— 需 Vincent 定义。
- Path A scheduler 与 #168 retry-queue、RFC-013 hot-reload 的模块协同 —— 都在 agent-node 加常驻状态 / `.anet/nodes/<alias>/` 持久化,可共用一套约定。
- 若未来要 codex 端原生 goal 态(而非外部 `goals.json`):`@openai/codex-sdk` 薄封装做不到,要走 direct stdio app-server client(#141 已 vendored)—— 但 app-server 协议本身也无 goal 原语(§2),所以这条目前没有捷径,Path A/B 外部存储是唯一解。

**Status**: Draft v0.2,SDK马 + SDK牛 finding 已合,发 通信龙 review。

**作者**: 通信SDK马 · 2026-05-21

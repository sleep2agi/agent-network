# RFC-011 implementation plan — v0 (从 v3 approve 起)

| 项 | 值 |
|----|----|
| **Author** | 通信SDK马 |
| **状态** | Draft v0 — pure plan, **不实施任何代码** (per `feedback_delegate_dont_self_investigate` + `feedback_confirm_before_push_on_vincent_arch_decisions`) |
| **触发** | RFC-011 v3 通信牛 third pass approve (2026-05-15) + 通信龙 dispatch [task 895b9b4a] 建议 #120 调研后启 implementation |
| **关联** | RFC-011 v3 (commit 03979a4); RFC-009 social experiment framework (shared 前置: batch library extract) |
| **目标** | 评估 通信牛 5 checklist 工作量 + 依赖图 + 推荐 owner 分工，**不直接派单不直接 ship**，等 Vincent + 通信龙 align 后真启动 |

---

## §1 通信牛 third pass 5 checklist 还原 (v3 approve verdict)

1. **Phase 0.5 先抽 batch library** — RFC-009 / RFC-011 共享前置
2. 创建 experiment 时同时创建/选择 control network，记录 `{ experiment_network_id, control_network_id }`
3. `SocietyEventSource` 默认只订阅 experiment network，不能自动 include control network
4. commentator / digest assembler 必须拿 control-network-scoped ntok，不要 experiment network token
5. **E2E 必须覆盖** — digest task 写入 control network 后, experiment network ticker/hotspot 事件数不增加 (递归污染回归测试)

---

## §2 工作量分解 (粗估)

### Phase 0.5 — batch library extract (前置 P0)

**Why first**: RFC-011 §3.2.1 + RFC-009 都依赖一个**纯库形态**的 batch primitive。现 `createBatch()` 实测耦合 `process.chdir / process.exit / console / loadGlobal` (RFC-011 v2 Blocker 3 实测确认)。

| Task | 工作量 | Owner | 依赖 |
|------|--------|-------|------|
| 0.5-A 解读 cli.ts:createBatch 当前耦合面 | 0.5 day | 通信工程马 | (无, 直接 grep) |
| 0.5-B 设计 `agent-network/src/batch.ts` 纯库 API surface | 0.5 day | 通信工程马 draft → 通信牛 review | 0.5-A |
| 0.5-C 抽 createBatch 到 batch.ts (副作用全 inject) | 1 day | 通信工程马 → 通信测试马 unit test | 0.5-B |
| 0.5-D cli.ts wrapper 重接, 验证 `anet create --batch` 现有行为不变 (向后兼容) | 0.5 day | 通信工程马 | 0.5-C |
| 0.5-E ship `agent-network@X.Y.Z-preview.N+1` + 等 30min 验证窗 | 0.5 day | 通信工程马 (release ops owner) | 0.5-D |

**ETA**: ~3 day (assuming 通信工程马 顺手, no surprise)

### Phase 1 — 创建 experiment 时同步起 control network (RFC-011 §2.4.2 Option A)

| Task | 工作量 | Owner | 依赖 |
|------|--------|-------|------|
| 1-A `MultiVendorBatchSpec` 加 `control_network_id` 字段 (RFC-011 §3.2 增量) | 0.5 day | 通信工程马 draft → 通信牛 review | Phase 0.5 done |
| 1-B 实验编排器创建 experiment 时自动 (a) 创 experiment net (b) 创 control net (c) 记录两个 id 到 experiment metadata | 1 day | 通信工程马 | 1-A |
| 1-C commhub `networks` 表 schema 不需要改 (UNIQUE(network_id, alias) 已支持 multi-network, RFC-011 v3 §2.4.2 确认), 仅需 commhub admin API 支持单调用建两个 net | 0.5 day | 通信牛 (commhub-server owner) | (commhub side) |

**ETA**: ~2 day

### Phase 2 — `SocietyEventSource` ACL + control network 隔离

| Task | 工作量 | Owner | 依赖 |
|------|--------|-------|------|
| 2-A `SocietyEventSource.subscribe()` 实现严格 ACL — 只接受 experiment_network_id, 拒绝 control_network_id | 1 day | 通信工程马 | Phase 1 done |
| 2-B `network_members` 表 join 验证 (RFC-011 v3 §2.1.1 ACL bullet) | 0.5 day | 通信牛 (commhub-server) | 2-A |
| 2-C unit test `subscribe({networkId: control_network_id}) → throw ACL denied` | 0.5 day | 通信测试马 | 2-A |

**ETA**: ~2 day

### Phase 3 — commentator + digest assembler 在 control network 跑 (control-network-scoped ntok)

| Task | 工作量 | Owner | 依赖 |
|------|--------|-------|------|
| 3-A commentator agent CommentatorSpec (RFC-011 §2.4.3) 实例化逻辑: 用 control_network_id 注册 + control-network ntok | 1 day | 通信工程马 | Phase 1 done |
| 3-B digest assembler 模块 (RFC-011 §2.4.2 节拍器) 跑在 control network namespace, 通过 `commhub_send_task` 投递给 commentator (control 内, 不出现在 experiment network 的 tasks 表) | 1 day | 通信工程马 | 3-A |
| 3-C 解说 agent 接收 digest user message + 上段旁白 → 产出旁白文本流给 dashboard 字幕区 (`[N站马 输入]`) | 1 day | N站马 (dashboard surface) | 3-B |

**ETA**: ~3 day (N站马 step 3-C 可跟 3-B 并行)

### Phase 4 — E2E 递归污染回归测试 (通信牛 强制 checklist 第 5 项)

| Task | 工作量 | Owner | 依赖 |
|------|--------|-------|------|
| 4-A 写 e2e test: 起 experiment net + control net + N 个 agents + commentator/digest assembler → 跑 X 个 digest tick → 断言 experiment net `tasks/inbox/task_events` count 跟 baseline 一致 (无 digest 投递回灌) | 1.5 day | 通信测试马 | Phase 3 done |
| 4-B 故意 misconfigure (digest assembler 注入 experiment ntok) 验证测试能 catch (negative test) | 0.5 day | 通信测试马 | 4-A |
| 4-C Docker 化 + CI integration (anet 测试规则: docker only) | 1 day | 通信测试马 | 4-A |

**ETA**: ~3 day

### Phase 5 — Phase 1-4 集成 ship + RFC-011 mark "approved + implemented"

| Task | 工作量 | Owner |
|------|--------|-------|
| 5-A 把 Phase 1-4 改动按 RFC-011 v3 章节 cross-reference 到 commit msg / PR body | 0.5 day | 通信工程马 |
| 5-B 通信牛 final pass review (合并前) | 0.5 day | 通信牛 |
| 5-C ship 一个独立 preview (e.g. `agent-network@X.Y.Z-preview.M`) | 0.5 day | 通信工程马 |
| 5-D Vincent 验收 (实际跑一个跨 vendor demo, 比如 5x intern + 5x MiniMax + 5x GLM 投票实验) | 1 day | Vincent + 通信龙 |

**ETA**: ~2 day (gate 在 Vincent demo, 不计入 critical path)

---

## §3 依赖图

```
                    ┌──────────────────────────────────────┐
                    │  Phase 0.5 — batch library extract   │
                    │  (RFC-011 + RFC-009 shared 前置)      │
                    │  ETA ~3d, owner 通信工程马           │
                    └────────────┬─────────────────────────┘
                                 │
                  ┌──────────────┴──────────────┐
                  ▼                              ▼
         ┌────────────────────┐         ┌─────────────────────┐
         │   RFC-011 Phase 1  │         │   RFC-009 Phase 0   │
         │   experiment +     │         │   (社会学实验框架)   │
         │   control network  │         │   实施起点          │
         │   ~2d              │         │   (本 plan 不覆盖)   │
         └─────────┬──────────┘         └─────────────────────┘
                   │
       ┌───────────┴──────────────┐
       ▼                          ▼
  ┌────────────────┐    ┌──────────────────────┐
  │  Phase 2       │    │  Phase 3              │
  │  SocietyEventSource│  commentator +          │
  │  ACL 严格隔离   │    │  digest assembler     │
  │  ~2d           │    │  ~3d (3-C N站马 并行) │
  └────┬───────────┘    └──────┬───────────────┘
       │                       │
       └────────────┬──────────┘
                    ▼
            ┌────────────────────┐
            │   Phase 4          │
            │   E2E 递归污染回归  │
            │   ~3d, 通信测试马   │
            └────────┬───────────┘
                     ▼
            ┌────────────────────┐
            │   Phase 5          │
            │   集成 ship + 验收  │
            │   ~2d              │
            └────────────────────┘
```

**Critical path** (最长): Phase 0.5 (3d) → Phase 1 (2d) → Phase 3 (3d) → Phase 4 (3d) → Phase 5 (2d) = **~13 day** (单一 owner 串行)。

并行优化: Phase 2 跟 Phase 3 可并行 (依赖都是 Phase 1); 3-C 跟 3-A/3-B 可并行 → **可缩到 ~11 day**。

---

## §4 RFC-009 共享前置 — 协同建议

Phase 0.5 batch library extract **同时是 RFC-009 (social experiment framework) 实施前置**。两条 RFC 互不冲突, 共享一个 batch.ts 库:

- RFC-011 用 batch.ts 创建 multi-vendor cohort (5x intern + 5x MiniMax + ...)
- RFC-009 用 batch.ts 创建 experiment cohort + round/payoff (CohortSpec 沿用)
- **Phase 0.5 完成后 RFC-009 / RFC-011 都能独立启动 Phase 1**

建议: **Phase 0.5 出口 = `agent-network@X.Y.Z-preview.N` ship + 30min 验证窗**, 之后 RFC-009 + RFC-011 implementation 可同时启动。

---

## §5 Owner 分工建议

| 角色 | 责任面 |
|------|--------|
| **通信工程马** | release ops owner (per `project_release_ops_owner`) — Phase 0.5/1/2/3/5 实施 |
| **通信牛** | commhub-server side schema/ACL 改动 (Phase 1-C, Phase 2-B) + 5-B final pass review |
| **通信测试马** | unit test (2-C) + Phase 4 E2E (4-A/4-B/4-C) |
| **N站马** | dashboard 解说字幕区 surface (Phase 3-C, 跟 3-B 并行) |
| **通信SDK马 (我)** | 本 plan doc 维护 + monitor `[N站马 输入]` 标注处 dashboard 设计 + RFC-006/007 addendum 起草 (依赖 RFC-011 ship 后 anet codex runtime 配套 design) |
| **通信龙 (lead)** | dispatch + 优先级 + 进度 surface Vincent |
| **Vincent** | final approve + Phase 5-D 验收 demo |

---

## §6 Risk + 不确定性

| Risk | 评估 | 缓解 |
|------|------|------|
| Phase 0.5 batch library 抽离引出 createBatch 历史副作用比预想多 | 中 | 0.5-A grep+dry-run 先, ETA buffer 0.5d |
| commhub `networks` table 创建 control network 的 admin API 已存在? 不存在? | 低 (per CLAUDE.md 13 表确认 networks 表已有) | 通信牛 1-C 实测 commhub 现有 API surface, 不足则加 |
| RFC-009 跟 RFC-011 并行启动 Phase 1 后 batch.ts 出现 race | 中 | Phase 0.5 出口要做完整 unit test (0.5-C) 保证 batch.ts 线程安全 |
| Vincent 拍板「先 ship 一个 demo」绕开 Phase 0.5 抽库 | 高 | 本 plan 推荐 Phase 0.5 不可绕过, 否则双 RFC 各自 hack 副作用最后无法合 |
| 解说 agent (commentator) 的 vendor 选型 (RFC-011 §2.4.3 vendor 字段) | 低 | 推荐用 claude-sonnet-4-6 (anet 内最强 model, 解说质量直接影响 livestream 卖点) |

---

## §7 不做什么 (explicit out-of-scope)

本 plan **不**:
- 实施任何 phase (我是 plan owner 不是 implementer)
- 替代 RFC-009 implementation plan (RFC-009 单独写 plan)
- 设计 RFC-011 §4 (热点检测算法) 实施细节 (Phase 1-5 之后做)
- 设计 RFC-011 §6 Phase ladder 之外的扩展 (TTS / 24/7 stability / livestream infra Phase 4)

本 plan **会** (Round 10 起后续 iteration):
- 跟 通信龙 align owner 分工后细化每 phase sub-task
- Phase 0.5 grep dry-run 结果回灌 (0.5-A 由通信工程马 dig 完后更新)
- 通信牛 review 后 v0 → v1 (类比 RFC-011 v1 → v2 → v3 节奏)

---

## §8 立即下一步 (Round 10 ship 后)

1. 通信龙 align owner 分工 (§5) — 我等你 ack
2. 派 0.5-A grep dry-run 给 通信工程马 — 我建议你直接派, 我不抢
3. RFC-006/007 addendum (跟 anet codex runtime / `goals` reconcile, Round 9 dig 出来) 等 RFC-011 / RFC-009 implementation 启动后再起草

---

## 撰写依据

- RFC-011 v3 final amend (commit 03979a4)
- 通信牛 third pass approve dispatch (task 895b9b4a) 5 checklist
- 通信龙 priority guidance (#120 先 1-2 轮 dig 然后 RFC-011 implementation)
- `feedback_module_by_module` (前一模块 ack 后才推下一模块)
- `feedback_delegate_dont_self_investigate` (我不直接写代码)
- `project_release_ops_owner` (通信工程马 是 release ops 主 owner)

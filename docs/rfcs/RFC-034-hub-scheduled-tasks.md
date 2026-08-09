# RFC-034 — Hub 级定时任务

状态：实现候选

## 1. 结论

定时任务由 CommHub 持有和执行。Dashboard 与官方 App 是同一组 Hub API 的管理客户端；agent-node、TUI、MCP bridge 不保存计划，也不负责计时。每次触发最终生成一条普通 `inbox` + `tasks` 任务，因此节点侧无需新增协议，离线节点沿用既有排队语义。

`/aloop` 和节点本地 `goals.json` 是兼容能力，不是本 RFC 的数据源、执行器或容灾副本。两套语义不得互相同步，以免形成双调度 owner。

## 2. 用户能力

- 从 Dashboard 或 App 选择同一 network 中的稳定 `node_id`。
- 建立单次、固定间隔、每日、每周计划。
- 每日/每周计划显式记录 IANA timezone；单次时间保存为 UTC ISO 8601。
- 查看下次/上次执行、暂停、恢复、立即执行、取消和运行历史。
- 目标节点改名后仍按 `node_id` 解析当前 alias。
- 默认 `overlap_policy=skip`：上一轮普通 task 尚未终态时，本轮记 `skipped`，不重复压入节点。

## 3. 数据模型

`scheduled_tasks` 是计划真相：network、创建人、稳定目标、任务正文、计划规格、状态、next/last time 与 optimistic `revision`。

`scheduled_task_runs` 是每个 occurrence 的不可混淆记录。`UNIQUE(schedule_id, scheduled_for)` 是多 Hub 进程竞争时的幂等 claim。run 只引用普通 `task_id`，不复制 task lifecycle。

历史取消不物理删除：计划标记 `cancelled`，run history 保留。

## 4. 调度和故障语义

1. `startHub()` 启动 scheduler；单纯 import 或 `bootServer()` 不启动后台 timer。
2. tick 读取 `active AND next_run_at <= now`，默认 10 秒，可通过 `COMMHUB_SCHEDULER_TICK_MS` 调整。
3. occurrence claim、run row、inbox row、task row及 next occurrence 推进处于同一个数据库 transaction。
4. commit 后才发送 SSE doorbell。SSE 失败不回滚已持久化任务；节点仍会通过 inbox 拉取。
5. Hub 长时间停机后，每个到期计划只补一次；下一次从恢复时刻以后计算，禁止补发所有错过的 tick 形成风暴。
6. 单次计划无论成功投递或因目标失效而失败，均进入 `completed`，不永久自旋。
7. 目标处于 stop/delete lifecycle 时 fail closed，run 记录失败；普通 offline 仍排队。

SQLite transaction 是当前生产原子边界。仓库现有 PostgreSQL adapter 已明确不提供真实跨语句 transaction；在该 adapter 修复前，不得把 PostgreSQL 宣称为 scheduler 的 production-safe 后端。

## 5. 身份与租户边界

- 只有 `utok_` 用户可管理计划；`ntok_` 无论签发者是谁都拒绝，避免节点给自己植入永久执行循环。
- viewer 可读、不可写；member/admin/owner 依既有 `canRestWriteNetwork` 写门。
- `network_id` 取 token-bound scope 或经成员校验的显式值，不信任客户端自报身份。
- 目标必须由 `nodes(network_id,node_id)` 命中；禁止跨 network alias/node_id 拼接。
- 列表、详情与 runs 均使用相同 network scope；找不到与无权读取都返回 `schedule_not_found`，不泄漏外网元数据。
- 创建人取认证 user id，客户端不可覆写。

## 6. REST API

- `GET/POST /api/scheduled-tasks`
- `GET/PATCH/DELETE /api/scheduled-tasks/:schedule_id`
- `GET /api/scheduled-tasks/:schedule_id/runs`
- `POST /api/scheduled-tasks/:schedule_id/run-now`

PATCH 必须携带当前 `revision`；陈旧客户端得到 `409 revision_conflict`，不得覆盖另一设备的新状态。

## 7. 发布与回滚

发布顺序必须是 Hub → Dashboard → App。旧 Dashboard/App 对新增表和 API 无感；新客户端连旧 Hub 应明确显示 API 不可用，不得伪装为空计划。

回滚 UI 不删除数据。回滚 Hub binary 后新增表由旧 binary 忽略；再次升级后 scheduler 根据持久状态收敛。回滚期间不会由节点本地补跑。

## 8. 验收门

分层 Docker 门：schema/时间计算 → 认证与 network isolation → 单次真实投递 → recurrence/重启/幂等/non-overlap/rename → Dashboard/App contract → 安全 mutation。报告必须区分“设计/契约通过”和“真实 Hub 触发普通 task 通过”。

# CommHub v0.9.0-preview.114

本版带上 `0.9.0-preview.113`（发版合并 `8962ee4c`，#2492）之后合入的 Hub 改动。`git log 8962ee4c..<发版提交> -- server/` 列出：

| 提交 | PR | 内容 |
|---|---|---|
| 8e7403e5 | #2488 | board #710：超时任务的迟到回复被保留（追加迟到回执，不改原任务的终态）；校验在 `handleReply`，上下文不对时报 `late_reply_context_invalid` |
| 6cc0aeca | #2494 | board #733：Agent 通过 7 个仅节点可见的 MCP 工具管理 Hub 定时任务；`scheduled_tasks` 新增可空列 `created_by_node_id` 和一个索引 |
| b807d29d | #2480 | Codex 大会话恢复（agent-network / agent-node 侧）；`server/` 下只改了一个测试文件 `server/src/shared/reserved-env-drift.test.ts`，Hub 行为不变 |

## 🔴 上线约束

- .111 的上线约束继续有效：所有签发令牌的进程一起升级，不和旧版 Hub 混跑，不回滚到 `.111` 或更早的签发器。
- **可以回滚到 `.113`**：本版的表结构改动都是加法（`scheduled_tasks.created_by_node_id` 可空列 + `(network_id, created_by_node_id)` 索引；新表 `task_late_replies`），`.113` 不读这一列和这张表，在新库上能照常启动和读写。回滚后的已知差异：
  - 🔴 **Agent 创建的定时任务在 `.113` 上失去来源信息**：`.113` 不认 `created_by_node_id`，这些任务按普通定时任务运行——不再在每次运行前按创建节点的当前状态重新校验（节点被删 / 改只读 / 失去派活权限时不会再拒绝运行），运行不再带 `[scheduled by agent …]` 前缀和 `meta.scheduled_by_*`，回复会进主人的未读。
  - `.113` 没有 `schedule_*` 工具，Agent 在回滚期间不能管理定时任务。
  - 迟到回复（#2488）在 `.113` 上按旧行为处理；已存的迟到回执留在 `task_late_replies` 里，`.113` 的任务详情不显示，升回本版后照常可见。
  - 回滚期间列值不会被清掉，重新升回本版后来源信息和重新校验恢复。

## 你会看到的变化

- **Agent 管理定时任务（#2494）。**
  - 7 个工具：`schedule_list` / `schedule_get` / `schedule_create` / `schedule_update` / `schedule_cancel` / `schedule_run_now` / `schedule_runs`，受众 `node`（用户令牌不列，调用返回 `network_token_required`）。
  - 节点只能看到本网络里指向自己或自己创建的定时任务；改目标、改、暂停、取消、立即运行只限自己创建的；指向别的节点时要能当场 `send_task` 给它。每个创建节点最多 20 个开着的定时任务（`COMMHUB_AGENT_SCHEDULE_QUOTA`）。
  - REST `/api/scheduled-tasks` 行为不变，节点令牌仍是 `403 user_token_required`。
- **迟到回复（#2488）。** 任务超时后执行方的回复以迟到回执追加，原任务的状态、结果、事件不变；同一 task/thread/turn 至多一条，重试幂等，载荷不同报冲突。`send_reply` / `send_peer_reply` 多两个可选参数 `thread_id`、`turn_id`。

## 数据库与设置

- `scheduled_tasks` 新增 `created_by_node_id TEXT`（可空，旧行为 NULL）和索引 `(network_id, created_by_node_id)`，用 db.ts 现有的 `ALTER TABLE … ADD COLUMN` 方式，SQLite 与 PostgreSQL 一致。
- 新表 `task_late_replies`（#2488，`CREATE TABLE IF NOT EXISTS`，带 `(task_id, thread_id, turn_id)` 唯一约束和两个索引），原 `tasks` 行不改。
- 新的可选环境变量 `COMMHUB_AGENT_SCHEDULE_QUOTA`（默认 20），`hub.env` 不用动。

## 检查

- **`tests/hub-release-compat`**（Docker `--cpus=2`，一次性 Hub）：候选为 main `b807d29d` + 本版本号（dirty_files=2），基线 npm 上的 `0.9.0-preview.113`，App desktop-v0.2.220 / .221 / .222，`SCHED_BASELINE=counted CHECK_BYTES=1 EXPECT_BACKFILL=0 OLD_LABEL=.113 NEW_LABEL=.114`。
  - A1、A2：steps=62，unexpected=0，check_failures=0，候选没有 5xx。
  - `mcp.tools_list`（节点令牌带 `X-Anet-Tools: all` ∪ 用户令牌）78 → 85：新增 7 个 `schedule_*`（受众 `node`，用户令牌列表不含），`send_reply` / `send_peer_reply` 新增可选参数 `thread_id`、`turn_id`；判为 additive，没有删改。
  - B 升级 → 回滚到 `.113` → 再升级（同一个数据库）：upgrade_check_failures=0；回滚后 `.113` 的列表与原 `.113` 响应逐字节相同，再升级后与第一次 `.114` 响应逐字节相同。
  - 注：`.113` 专用的 `CHECK_ABANDONED=1` 这次不开——它断言「基线拒绝 abandoned」，`.113` 已经支持 abandoned，此项按设计会红（实测 A1/A2 各 1 条，仅此一条）。
- **已发布节点二进制回放**（一次性 Hub，Docker `--cpus=2`，与 .113 同一脚本，只换版本）：agent-node `2.5.0-preview.121` / `.122` / `.123` / `.124` 作为客户端，每个版本都分别以未绑定旧令牌（同名多行）和绑定令牌身份当发送方、接收方，覆盖注册、心跳、收发任务和 SSE，以及注册 `network_token` 的 REST `/api/task` 署名。
  - 8 轮：checks=84，failures=0。
  - 反证：同样两处判定改坏后 failures=9、退出码 1。
- #2488：test710（SQLite / PostgreSQL 各 4 tests / 46 assertions，含见红变异）。
- #2494：`server/src/schedule-agent-mcp-http.test.ts`（14 pass，M1–M8 变异全红），`tool-audience-http.test.ts` 字节上限不变。

本说明不代表已发布。只通过 release.yml、用包含这些改动的 main 完整 SHA 发布：
包 `@sleep2agi/commhub-server`，版本 `0.9.0-preview.114`，渠道 preview。

promote 时的 `must_contain`（npm 上 `.113` 的 tarball 里都是 0 处）：
- `created_by_node_id`（#2494，`server/src/schedule-agent.ts`）
- `late_reply_context_invalid`（#2488，`server/src/tools.ts`）

## Install

在允许安装的隔离环境里（Hub 需要 Bun）装确切版本：

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.114
```

安装命令本身不会切换任何生产进程。

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.114
```

升级前先备份数据库。按上线约束，同一个数据库上的所有签发进程要一起升级。

## 回滚

可以回滚到 `0.9.0-preview.113`（表结构改动是加法）：

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.113
```

🔴 回滚后 Agent 创建的定时任务失去来源信息和创建者的运行前重新校验（照常按时运行，回复进主人未读），Agent 不能再管理定时任务；升回本版后恢复。**不支持回滚到 `.111` 或更早的版本**（.111 的签发器约束）。

不要覆盖已发布的包。包内不含任何已有数据、用户、网络成员或密钥。

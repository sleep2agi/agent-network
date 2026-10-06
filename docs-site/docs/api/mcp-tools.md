# MCP Tools 参考

CommHub Server 注册 **74 个** MCP Tools，全部经 `POST /mcp`（Streamable HTTP）调用。下表是完整索引；其中 17 个 agent 日常协作工具在本页有参数与返回值的详细说明，点名字直达。

## 谁的 tools/list 里有哪些工具

`tools/list` 按调用者给，只列这个令牌真能用的工具。工具照旧全部注册，`tools/call` 不变：调一个没列出来的工具，回的仍是它原来那个错误。

| 调用者 | 不列的工具 | 原因 |
|---|---|---|
| 节点令牌（Agent） | `projects_create`、`projects_update`、`list_node_files`、`read_node_file`、`tail_node_logs` | 节点令牌调这些一律被拒（`user_token_required` / `node_token_cannot_*`） |
| 节点令牌（Agent） | 协议工具：`get_*_request` / `ack_*_request`（配置、规则文件、建 / 停 / 起节点、探测）、`get_config_update`、`ack_config_update`、`list_my_pending_*`、`list_my_children`、`mark_tasks_*` | agent-node / daemon 按名字直接调，模型不需要。请求头带 `X-Anet-Tools: all`（或 `/mcp?tools=all`）时照列 |
| 节点令牌，只读 / 受限模式 | 再加 `broadcast`、管节点 / 技能 / 探测的写工具、只有人能做的工具 | 这两种模式下这些一律被拒 |
| 节点令牌，`COMMHUB_NODE_PERMISSIONS=enforce` | 再加只有人能做的工具（`upsert_provider`、`update_provider`、`upsert_network_secret`、`review_skill`） | 开关打开后一律被拒；默认 `log` 下它们调得通，所以照列 |
| 用户令牌（人） | `report_status` 和全部协议工具 | 用户令牌调这些一律 `network_token_required` / `caller_not_a_daemon` |

只藏「不看参数就一定被拒」的工具。要看参数才决定的（派活给谁、在哪个网络）一律照列；只看授权 Agent 的受限成员也不按这个藏，因为他换一个网络就可能调得通。每个工具归哪一类在 `server/src/tool-audience.ts`，新工具必须归类，否则测试不过。

实测（74 个工具）：全部 71,559 B；节点 52 个 57,632 B（−19%）；用户 56 个 54,780 B（−23%）。

## 完整工具索引

**协作（本页有详细说明）** · 17 个

| 工具 | 说明 |
|------|------|
| [`report_status`](#report_status) | 上报状态，返回 inbox_count |
| [`report_completion`](#report_completion) | 上报任务完成与产物 |
| [`get_inbox`](#get_inbox) | 取本会话待处理命令 |
| [`ack_inbox`](#ack_inbox) | 确认已收到命令 |
| [`send_task`](#send_task) | 按 alias 投任务进对方 inbox |
| [`send_message`](#send_message) | 发消息，不建任务生命周期 |
| [`send_reply`](#send_reply) | 回复 Dashboard 发起的任务；也是 agent 间任务的终结腿 |
| [`send_ack`](#send_ack) | 确认收到任务，不进 inbox |
| [`retry_task`](#retry_task) | 重试失败/过期/取消的任务 |
| [`cancel_task`](#cancel_task) | 取消 delivered/acked/running 的任务 |
| [`reassign_task`](#reassign_task) | 把任务转给另一个 agent |
| [`get_task`](#get_task) | 按 task_id 查详情、状态、结果 |
| [`list_tasks`](#list_tasks) | 带过滤条件列任务 |
| [`get_all_status`](#get_all_status) | 列全部会话状态（Hub 巡检用） |
| [`get_session_status`](#get_session_status) | 按 alias 查单个会话详情 |
| [`get_completions`](#get_completions) | 查近期任务完成记录 |
| [`broadcast`](#broadcast) | 群发消息给多个会话 |

**桌面与用户消息** · 1 个

| 工具 | 说明 |
|------|------|
| `send_desktop_message` | 向桌面用户 inbox 写一条可推送消息 |

::: tip send_desktop_message —— 收件人是**用户身份**，不是节点 alias
这是本工具唯一容易搞错的地方，也是它和 `send_task` 的根本区别：

- `send_task(alias=…)` 发给一个**会话/节点**（名册里能查到的那种）；
- `send_desktop_message(to_user_id=… | to_username=…)` 发给一个**登录用户**，
  推到他当前活跃的桌面端 / Web 客户端。

**一个登录用户不一定有对应的会话 alias。** 拿 alias 去当收件人，或者反过来，
都会发给错误的对象 —— 而两种情况**接口都会返回成功**，因为参数在各自的语义下都是合法的。

```jsonc
// 最小可用调用：二选一给 to_user_id 或 to_username
{
  "to_username": "alice",          // 或 "to_user_id": "u_9f2c1b7ae4d0"
  "title": "构建完成",              // 可选，≤200
  "message": "v0.9.0-preview.43 已发布到 npm。",   // 必填，1–10000
  "severity": "success",           // info | success | warning | error，默认 info
  "kind": "agent_message"          // 默认 agent_message，用于客户端分类
}
```

`to_user_id` 和 `to_username` **至少给一个**；两个都给时会做一致性校验，对不上会被拒。
`network_id` 通常不用传（单网络的 user token 会自动解析；`ntok` 恒定绑在它自己的网络上）。
:::

**SkillHub** · 4 个

| 工具 | 说明 |
|------|------|
| `submit_skill` | 向本网络 SkillHub 提交一版不可变 SKILL.md |
| `list_skills` | 列本网络已发布技能（owner/admin 可含待审） |
| `get_skill` | 读一份 SKILL.md（待审内容仅 owner/admin 可见） |
| `review_skill` | 发布或驳回待审技能（owner/admin） |

**节点生命周期（`anet` CLI / Dashboard 调用）** · 6 个

| 工具 | 说明 |
|------|------|
| `create_node` | 在 host-daemon 上创建并启动节点 |
| `delete_node` | 停子进程 + 吊销 ntok + 删 hub 行（默认备份配置） |
| `stop_node` | 停 agent-node 子进程，保留配置目录 |
| `start_node` | 通过 host-daemon 启动已停止的子节点 |
| `restart_node` | 不改配置直接重启节点 |
| `update_node_config` | 设置节点目标配置（model + flags）并推门铃 |

**主机 daemon 协议（内部，节点与 daemon 自动调用）** · 12 个

| 工具 | 说明 |
|------|------|
| `get_config_update` | 节点拉取待应用的配置更新 |
| `ack_config_update` | 节点回报配置更新结果 |
| `read_node_rules_file` | 请节点回传其工作目录下的规则文件（claude → CLAUDE.md，其余 → AGENTS.md）；无路径参数，结果用 `get_rules_file_result` 轮询（app#225） |
| `write_node_rules_file` | 请节点用 `content` 覆盖其规则文件；无路径参数，256 KB 上限（app#225） |
| `list_node_skills` | 请节点列出它的运行时实际加载的技能（`{name, scope, path_rel, description}`，只读）；目录由节点按运行时决定，无路径参数，结果用 `get_rules_file_result` 轮询 |
| `read_node_skill` | 请节点回传某个技能的 SKILL.md（只读，256 KB 上限）；唯一入参是技能名 `name`（`[A-Za-z0-9._-]{1,64}`），不接受路径 |
| `list_node_files` | 请节点列出其工作目录下某一层目录（项目文件夹，只读）：`path` 相对工作目录（缺省为根），拒绝绝对路径与 `..`；每项 `{name, type, size, mtime}`，凭据类文件只给名字（`hidden_reason: "secret"`），`node_modules` / `.git` 不进入，上限 1000 项。仅用户登录可调用 |
| `read_node_file` | 请节点回传工作目录下一个文本文件（只读，256 KB 上限；二进制 / 超限只回大小；`.env`、密钥、`auth.json` 等凭据文件不回内容）；节点侧 realpath 收在工作目录内，软链接逃不出去。结果仅发起请求的那个 token 可读 |
| `tail_node_logs` | 请节点回传它自己 agent-node 运行日志的末尾（只读）：`lines`（默认 500，最多 2000）、可选 `level`（`info`/`warn`/`error`，按级别精确匹配）、`grep`（不分大小写，在脱敏之后匹配）、`since_ts`（实时跟随用）。没有路径参数 —— 节点只读自己的日志目录，回传前遮住 token、`Bearer`/`Authorization` 的值和凭据类键名的赋值。仅用户登录可调用，且只限节点所有者或网络 owner/admin。结果只交给发起请求的那个 token 一次，读后即删（没人读的 5 分钟后删）。节点上报 `logs_capable` |
| `get_rules_file_result` | 轮询规则文件请求结果：pending / in_progress / done / failed / timeout（60 s 无回应自动 timeout）。文件内容只短暂保留：首次读到终态后 60 s 清除，或请求 24 h 后无论读没读都清除；之后再轮询返回状态与元数据加 `content_purged: true`，不再带 `content`。整行 30 天后删除 |
| `get_rules_file_request` | 节点拉取待处理的规则文件请求（网络 token + alias） |
| `ack_rules_file_request` | 节点回报规则文件请求结果（读时带内容） |
| `list_my_pending_create_requests` | daemon 在 SSE 重连后补偿拉取待处理建节点请求 |
| `list_my_pending_lifecycle_requests` | daemon 在 SSE 重连后补偿拉取待处理停/删/启动请求 |
| `get_create_request` | daemon 拉取待处理的建节点请求 |
| `ack_create_request` | daemon 回报 fork 后的启动结果 |
| `get_stop_request` | daemon 拉取待处理的停/删请求 |
| `ack_stop_request` | daemon 回报停/删完成或失败 |
| `get_start_request` | daemon 拉取待处理的启动请求 |
| `ack_start_request` | daemon 回报启动完成或失败 |
| `list_host_supervisors` | 列本网络的 host_supervisor daemon（含在线状态） |
| `list_my_children` | daemon 拉取自己派生的子节点清单 |
| `request_adopt_node` | 用户申请收编手动节点：`node_id`、`daemon_node_id`、`workdir`；须有网络写权限，且是节点主人或网络 owner/admin。daemon 必须在线、同网同主机，并声明 `daemon_capabilities.adopt_capable`。只建 pending 绑定，不停止进程 |
| `get_adopt_request` | 仅目标 daemon 的节点令牌拉取 pending 申请；本地路径与进程验证由 daemon 完成 |
| `ack_adopt_request` | 目标 daemon 回报 `adopted` / `refused`（可附 `error`）；确认后绑定 active。已撤销的申请不能复活 |
| `unadopt_node` | 主人或网络 owner/admin 撤销 pending/active 绑定，不停止节点；stop/start 在途时拒绝，完成后再撤销 |

**Provider 与密钥金库（owner/admin）** · 9 个

| 工具 | 说明 |
|------|------|
| `list_providers` | 列本网络 provider 与模型（从不返回密钥值） |
| `upsert_provider` | 新建或更新 provider |
| `update_provider` | 改已有 provider 的名称 / base_url / 模型 / 启停（至少一项；vendor、密钥、网络不可改），admin 以上 |
| `list_network_secrets` | 列金库密钥**名**（从不返回值），RFC-028 |
| `upsert_network_secret` | 写入或替换金库密钥值（AES-GCM 加密） |
| `probe_provider_model` | 向 daemon 派连通性探测 |
| `get_probe_request` | daemon 拉取待处理的探测请求 |
| `ack_probe_request` | daemon 回报探测结果（严格白名单：只收 4 个字段，多一个就 `-32602`） |
| `get_probe_results` | 查探测历史（可按 provider/model/daemon 过滤） |

**内部信号（agent-node 自动调用）** · 3 个

| 工具 | 说明 |
|------|------|
| `send_peer_reply` | 原子地终结一个节点任务并投一条无需回执的结果 |
| `mark_tasks_consumed` | agent-node 内部信号：标记本轮实际消费的任务 |
| `mark_tasks_runtime_submitted` | agent-node 内部信号：标记已提交给运行时的任务 |


**需求池 / 任务看板（Agent 可用，详见[下文](#需求池-任务看板)）** · 12 个

| 工具 | 说明 |
|------|------|
| `requirements_list` | 列本网络的任务，从新到旧；按 status / project_id / owner / agent_owner / `tag`（精确、区分大小写）/ updated_since / external_ref / parent_id / top_level / `q` 过滤，默认不含已归档。**MCP 默认 `view: "summary"` + 每页 50 张**（summary 不带描述与检查项正文，每张约 0.5–0.8 KB，一页通常 30–40 KB）；**默认不带 `last_event`**，要每行最新一条动态（含评论）传 `include_last_event: true`（每张多约 150 B）；`has_more` + `next_cursor` 翻页（传 `cursor`），`limit` ≤ 1000。要全文：单张用 `requirements_get`，或传 `view: "full"`（每张几 KB，`limit` 要小）。**参数严格**：不认识的参数（如把 `tag` 写成 `tags`）直接报错 `-32602`，错误里列出全部可用参数，不会再静默回整张表。`changes: true` + `updated_since` 只回之后改过的（含归档）+ `deleted` + `server_time`（Hub ≥ preview.75）；同时传 `include_last_event: true` 时，之后有新动态（如评论）的任务也回。REST `GET /api/requirements` 的默认不变（full、500 张） |
| `requirements_people` | 查本网络的人和他们名下的 Agent，用来填任务的人员字段：每行 `user_id`、`username`、`display_name`（没设为 `""`）、`role`、`department`（`{id, name}` 或 `null`）、`agents: [{node_id, alias}]`；没有主人的 Agent 在 `agents_without_owner`（只在第一页）。`q` 按用户名 / 显示名 / 部门 / Agent 别名筛（不区分大小写的子串）；每页 50 人（`limit` ≤ 200），`has_more` + `next_offset` 翻页（传 `offset`）。受限成员看不见的 Agent 不出现。参数严格（不认识的参数 → `-32602`） |
| `requirements_get` | 按 id 取一条任务（含描述、子任务、负责人、项目、external_ref） |
| `requirements_create` | 新建任务；状态用 `column`（`pool` / `doing` / `done`），也收别名 `status`（两个都给且不同 → 400 `status_conflicts_with_column`）；同网络重复的 `external_ref` 返回 409 `external_ref_exists` + `existing_id` |
| `requirements_update` | 修改任务，省略的字段保留；`status` 同 `column`（同上）。**`participants` 是整体替换**（没写进去的人会被删掉，`[]` 清空）；只想加 / 减几个人用 `participants_add` / `participants_remove`：在当前列表上增减、不动别人，加已有的 / 减不在的都是不变；和 `participants` 不能同时用（400 `participants_conflict`），同一个人既加又减 → 400 `participants_add_remove_overlap`；`archived: true` 归档（Agent 不能删除） |
| `requirements_checklist_toggle` | 把一个子任务设为完成 / 未完成，只写这一项 |
| `requirements_upsert_by_external_ref` | 按 `external_ref`（如 `github:owner/repo#123`）幂等同步：没有就建，有就改；也收 `status` 别名 |
| `projects_list` | 列本网络的项目（id、名字、颜色、排序、是否归档）。节点令牌（Agent）**只能读项目** |
| `projects_create` | 新建项目（名字 1–40 字、网络内不重名；可带颜色 / 排序），同 app「管理项目 → 新建」；要人的令牌：节点令牌（Agent）只能读项目，调这个 → 403 `user_token_required`；仅相关任务的成员和 viewer 也 403 |
| `projects_update` | 改项目的名字 / 颜色 / 排序，或 `archived: true / false` 归档 / 取消归档；只改传了的字段，权限同上 |
| `requirements_events` | 读任务的动态（字段级改动流水：谁、何时、旧值 → 新值；以及评论 `kind: "comment"`，正文在 `new.text`，从新到旧）；`requirement_id`（`req_…` 或 `"#N"`）只看一条（`limit` 默认 200）；**不带 `requirement_id` 是全网动态，MCP 默认每页 50 条**，`next_cursor` 传 `cursor` 翻更早的（`limit` ≤ 500；REST 的默认仍是 200）；`since` 只要之后的；可见范围同 `requirements_list`；参数严格（不认识的参数 → `-32602`） |
| `requirements_comment` | 给任务发一条评论 / 进展（`{id, text}`，markdown 1–4000 字）：**只追加**，不改描述，出现在动态里（`kind: "comment"`），署名是调用者（人或 Agent）。看得见这张任务、且在这个网络里不是只读角色的都能发；看不见 → 404，viewer → 403。Hub ≥ preview.90 |

---

## Agent 端工具

### report_status

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) —— 搜 `"report_status"`（注册点在 `server/src/tools.ts`，全仓唯一）

上报 Agent 状态。同时用作心跳（建议每 3 分钟调用一次）。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `resume_id` | string | &check; | Session 唯一标识（最大 200 字符） |
| `alias` | string | &check; | 显示名称（最大 200 字符） |
| `status` | enum | &check; | `working` / `idle` / `blocked` / `error` / `waiting_input` / `offline` |
| `task` | string | | 当前任务描述（最大 10000 字符） |
| `output` | string | | 最近输出（最大 50000 字符，存储截断到 4000） |
| `score` | number | | 自评分 **0-10**（doc 之前写 1-10，schema 实际 `.min(0).max(10)`） |
| `progress` | number | | 进度 0-100 |
| `server` | string | | 服务器标识 |
| `hostname` | string | | 主机名 |
| `agent` | string | | Agent 类型（自填字符串，便于审计；agent-node 实际发 `agent-node:<runtime>`，如 `agent-node:claude-agent-sdk` / `agent-node:codex-sdk` / `agent-node:claude-code-cli`；Claude Code MCP wrapper 发 `claude-code`；其他客户端自由填） |
| `project_dir` | string | | 工作目录 |
| `version` | string | | Agent 版本 |
| `tmux_name` | string | | tmux session 名 |
| `node_id` | string | | 节点稳定标识。**注意**：传了 `node_id` 才会把 `model` / `node_name` / `runtime`（从 `agent` 字段拆）upsert 到 `nodes` 表（[`tools.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) 搜 `upsertNodeWithSec1Guard`（`report_status` 段内 `if (node_id)` 之下的调用点，以及 registerTools 之后的同名 helper））。`model` 参数本身**不依赖 `node_id`** —— `report_status` 的 `sessions` upsert 无条件写 `sessions.model = COALESCE(model, 旧值)`（[`tools.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) 在 `report_status` 段搜 `INSERT INTO sessions`（写这几列的是 `report_status`，不是本节这个 tool） 与 `model = COALESCE(?20, sessions.model)`）；只有 `node_name` 没有 `sessions` 列、必须靠 `node_id` 走 `nodes` 表 |
| `session_id` | string | | 运行时 session/thread ID |
| `config_path` | string | | 配置文件路径 |
| `channels` | string | | Channel 列表（JSON 数组字符串） |
| `model` | string | | AI 模型名称（仅当 `node_id` 也传时写入 `nodes.model`） |
| `node_name` | string | | 节点显示名（仅当 `node_id` 也传时写入 `nodes.node_name`） |
| `network_id` | string | | 所属网络 ID |

**返回值**：

```json
{
  "ok": true,
  "resume_id": "sdk-n_a1b2c3d4",
  "alias": "代码1号",
  "inbox_count": 3
}
```

**示例**：

```typescript
report_status({
  resume_id: "sdk-n_a1b2c3d4",
  alias: "代码1号",
  status: "working",
  task: "写排序算法",
  progress: 50,
  model: "your-model-id",
  agent: "agent-node:codex"
})
```

::: warning 认证要求
该 tool 只接受 **`ntok_`（network-scoped）token**。用 `utok_`（user-scoped）调用会返回 `{ok: false, error: "network_token_required"}`（[`tools.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) 搜 `"network_token_required"`（全仓 3 处））。这是 v0.8 RFC-001 之后的硬约束 — agent 心跳必须绑定 network。

副作用：除了写 `sessions` 表，还会:
- 自动**删除同 network、同 alias、不同 resume_id** 的旧 session row（[`tools.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) 搜 `DELETE FROM sessions WHERE alias = ?1 AND resume_id != ?2`；用于 agent 重启时清理孤儿）
- 当 `status="working"` 且有 `task` 时，触发 `tasks` 表 `delivered/acked → running` 状态切换（[`tools.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) 搜 `UPDATE tasks SET status = 'running'`；详见 [Task 生命周期](/concepts/task-lifecycle#状态机)）
- 当 `node_id` 传入时 upsert `nodes` 表（含 `model` / `node_name` / `runtime`，详见 `node_id` 参数行）
:::

---

### report_completion

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) —— 搜 `"report_completion"`（注册点在 `server/src/tools.ts`，全仓唯一）

汇报任务完成。会自动更新 session 状态为 idle。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `alias` | string | &check; | Session 别名 |
| `task` | string | &check; | 完成的任务描述 |
| `result` | string | &check; | 结果摘要（最大 50000 字符） |
| `artifacts` | string[] | | 输出文件路径或 URL（最多 50 个） |
| `score` | number | | 自评分 0-10 |
| `duration_minutes` | number | | 耗时（分钟） |
| `network_id` | string | | 网络 ID |

**返回值**：

```json
{
  "ok": true,
  "completion_id": "uuid-xxx"
}
```

**示例**：

```typescript
report_completion({
  alias: "代码1号",
  task: "写排序算法",
  result: "使用快排实现，时间复杂度 O(n log n)",
  artifacts: ["/tmp/sort.py"],
  score: 8,
  duration_minutes: 2
})
```

::: tip 副作用（除了 completions 表 INSERT）
- **session 状态切换**：[`tools.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) 搜 `UPDATE sessions SET status = 'idle'` `UPDATE sessions SET status='idle', task=NULL, progress=0` (按 alias)
- **任务状态切换**：[`tools.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) 搜 `UPDATE tasks SET status = 'replied'`（全仓 2 处） 把 `tasks` 行从 `delivered`/`acked`/`running` 切到 `replied`。先按 `task_id = <task 参数>` 匹配；不命中再 fallback 用 `to_name=<alias> AND content=<task 参数>` 找最近一条 — 所以 `task` 参数实际可填**真实 task_id**（推荐）或**任务描述字符串**（fallback）
- **`result` 截断**：写 `tasks.result` 时只取前 4000 字符（[`tools.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) 搜 `result.slice(0, 4000)`（全仓 2 处）），但完整 `result` 会进 `completions.result`
- **chained_reply 自动传播**：如果该任务有 `parent_task_id`，会给父任务发起者 SSE 推 `chained_reply` event（[`tools.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) 搜 `type: "chained_reply"`（全仓 2 处）；用于子任务回 → 链式通知父任务发起者，详见 [`task-lifecycle` 双写机制](/concepts/task-lifecycle#双写机制)）
- **`task_events` log**：记录一条 `replied` event（[`tools.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) 搜 `logTaskEvent(updatedTaskId, null, "replied"`）

跟 [`send_reply`](#send-reply) 比较：`send_reply` 是 hub 工具，需要显式 `task_id` 参数；`report_completion` 是 agent 工具，可 fallback by content。
:::

---

### get_inbox

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) —— 搜 `"get_inbox"`（注册点在 `server/src/tools.ts`，全仓唯一）

拉取待处理的消息。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `alias` | string | &check; | Session 别名 |
| `limit` | number | | 最大条数（默认 10，最大 100） |

**返回值**：

```json
{
  "ok": true,
  "messages": [
    {
      "id": "uuid-xxx",
      "task_id": "task-uuid-xxx",
      "type": "task",
      "priority": "high",
      "content": "写排序算法",
      "context": null,
      "from_session": "指挥室",
      "created_at": "2026-04-12 10:00:00",
      "network_id": "net_xxx"
    }
  ]
}
```

任务消息的 `id` 是本次 inbox 投递行 ID；`task_id` 是跨重试/转派保持不变的逻辑任务 ID。旧数据没有独立 `task_id` 时，Hub 会回退为 `task_id = id`。处理任务时应把返回的 `task_id` 传给 `ack_inbox.message_id`；非任务消息继续传 `id`。

消息按优先级排序：high > normal > low，同优先级按时间排序。

---

### ack_inbox

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) —— 搜 `"ack_inbox"`（注册点在 `server/src/tools.ts`，全仓唯一）

确认消息已接收。ACK 后消息不会再被 `get_inbox` 返回。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `alias` | string | &check; | Session 别名 |
| `message_id` | string | &check; | inbox 投递行 `id`，或任务消息的逻辑 `task_id`。任务消费者应优先传 `get_inbox` 返回的 `task_id`；非任务消息传 `id` |
| `response` | string | | **当前 no-op**：handler 接受这个参数但不写库（[`tools.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) 搜 `"ack_inbox"` 没有读取 `response`）。schema 保留是为了 forward-compat / 不破坏现有调用方；想真正回复用 [`send_reply`](#send-reply) |
| `network_id` | string | | Network 范围。utok_ 恰好 1 个成员网络时自动解析，可省略；跨多网络必须显式传（#517） |

**返回值**：

```json
{ "ok": true }
```

**错误**：找不到属于该 alias 的待确认投递 → `message not found or already acknowledged`；投递在查询后不再可写 → `message not found or not yours`。

::: tip 副作用：tasks 表状态机
Hub 先用 `id = message_id`，或对任务消息用 `task_id = message_id`，解析出当前未确认的 inbox 行并只 ACK 那一行。若它是任务消息，再用该行解析出的稳定逻辑 `task_id` 把 `tasks` 从 `status='delivered'` UPDATE 到 `'acked'`（[`tools.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) 搜 `UPDATE inbox SET acked = 1 WHERE id = ?1 AND session_name = ?2`）。因此 retry/reassign 产生新 inbox `id` 后，仍能 ACK 原任务；旧消费者继续传 inbox `id` 也兼容。任务状态**仅**从 `delivered` 起跳，跟 hub 端 [`send_ack`](#send-ack)（接受 `created` / `delivered`）不同 —— 详见 [Task 生命周期 — `created` 状态](/concepts/task-lifecycle#状态机)。
:::

---

## 任务管理工具

### send_task

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) —— 搜 `"send_task"`（注册点在 `server/src/tools.ts`，全仓唯一）

派发任务到指定 Agent 的 inbox。**`send_task` 会触发收件方 AI 处理**（跟 [`broadcast`](#broadcast) 同款；`send_message` / `send_reply` / `send_ack` 不触发，详见 [Task 生命周期 — 消息类型](/concepts/task-lifecycle#消息类型)）。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `alias` | string | &check; | 目标 Agent 别名 |
| `task` | string | &check; | 任务内容（最大 10000 字符） |
| `priority` | enum | | `high` / `normal`（默认）/ `low` |
| `context` | string | | 上下文信息（最大 10000 字符） |
| `from_session` | string | | 发送者标识（默认 "hub"） |
| `ttl_seconds` | number | | 过期时间（默认 3600，最大 86400） |
| `network_id` | string | | 网络 ID |
| `parent_task_id` | string | | 父任务 ID；子任务回复后会自动沿任务链回传给父任务发起者 |
| `meta` | object | | 结构化任务元数据；主要用于附件 `{ attachments: [{ type, path, url, mime, name, size }] }`，写入 task 的 `meta_json` 列 |
| `force` | boolean | | 目标节点降级（返回 `node_degraded`）时仍强制派发。只对用户令牌生效，节点令牌带了也被拒。Hub `0.9.0-preview.86` 起，见[健康与降级](/guide/codex-copresence#health) |

**返回值**：

```json
{
  "ok": true,
  "message_id": "uuid-xxx",
  "actual_to": {
    "alias": "代码1号",
    "to_node_id": "node_xxx",
    "network_id": "net_xxx"
  },
  "session_status": "idle"
}
```

`actual_to` 表示 Hub 在调用方有权访问的 network 内实际解析到的 canonical
目标；在线成功、离线排队和幂等重放均使用同一 shape。改名兼容字段
`renamed_from` / `renamed_to` 继续保留。not-found 与权限拒绝不会返回该对象，
因此不能借失败响应枚举其他 network 的 alias、node ID 或 network ID。

**队列信息**（#500）：成功和离线排队（`alias_offline`）的响应都另带下面几个字段。只是建议，**从不因此拒绝派活**；不认识它们的旧客户端照旧工作。幂等重放（`idempotent_replay`）不带。

| 字段 | 类型 | 说明 |
|------|------|------|
| `queue_ahead` | number | 派这一条**之前**目标上开着的任务数：`tasks` 行 `status ∈ created / delivered / acked / running`、最近 24 小时内派出、同一网络、任何发送方。消息（`send_message` / `broadcast`）不写 `tasks`，不算；终态（replied / failed / cancelled / expired）不算；超过 24 小时还没终态的遗弃行不算 |
| `target_busy` | boolean | 目标上有一条已开工（`acked` / `running`，或带 `started_at` / `consumed_at`）的开着任务，或会话状态是 `working` / `busy` / `running` |
| `est_wait_minutes` | number \| null | **粗估**：目标最近 24 小时 `replied` 任务耗时的中位数 × `queue_ahead`，四舍五入，上限 1440。前面没人 → `0`；样本少于 3 条 → `null`（不知道）。耗时从 `started_at` 算起，没有就退回派出时间，所以通常偏大 |
| `warning` | string | 只在 `queue_ahead ≥ 3` 或 `est_wait_minutes > 30` 时出现：一句英文提示，建议换一个空闲节点（`get_all_status` 里 `status=idle`、`queue_depth=0` 的）、合并请求或加长 `ttl_seconds`，并提醒不要原样重发 |

```json
{
  "ok": true,
  "message_id": "uuid-xxx",
  "actual_to": { "alias": "代码1号", "to_node_id": "node_xxx", "network_id": "net_xxx" },
  "session_status": "working",
  "queue_ahead": 3,
  "target_busy": true,
  "est_wait_minutes": 60,
  "warning": "代码1号 already has 3 open task(s) ahead of this one (rough wait ~60 min, busy now). Your task is queued, not refused. It may expire before it starts (ttl 60 min). Consider an idle node instead (get_all_status: status=idle, queue_depth=0), merging your asks, or a longer ttl_seconds. Do not resend the same task."
}
```

**示例**：

```typescript
send_task({
  alias: "代码1号",
  task: "写一个 Python 快排算法，要求有注释",
  priority: "high",
  from_session: "指挥室",
  ttl_seconds: 7200
})
```

::: warning 权限要求
- viewer 角色不能发任务
- 试用期过期后不能发任务
:::

---

### send_message

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) —— 搜 `"send_message"`（注册点在 `server/src/tools.ts`，全仓唯一）

发消息（不触发 AI 处理，只展示）。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `alias` | string | &check; | 目标 Agent 别名 |
| `message` | string | &check; | 消息内容（最大 10000 字符） |
| `from_session` | string | | 发送者标识（默认 "hub"） |
| `network_id` | string | | Network 范围。utok_ 恰好 1 个成员网络时自动解析，可省略；跨多网络必须显式传（#517） |

**返回值**：

```json
{
  "ok": true,
  "message_id": "uuid-xxx",
  "session_status": "idle"
}
```

---

### send_reply

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) —— 搜 `"send_reply"`（注册点在 `server/src/tools.ts`，全仓唯一）

回复任务。关联到原始 task_id，不触发对方 AI 处理。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `alias` | string | &check; | 目标 Agent 别名 |
| `text` | string | &check; | 回复内容（最大 10000 字符） |
| `in_reply_to` | string | | 原始 task/message ID |
| `status` | enum | | `replied`（默认）/ `failed` / `cancelled` |
| `from_session` | string | | 发送者标识（默认 "hub"） |
| `network_id` | string | | Network 范围。utok_ 恰好 1 个成员网络时自动解析，可省略；跨多网络必须显式传（#517） |
| `attachments` | array | | 附件数组，与 `send_task` 的 `meta.attachments` 对等。每项 `{ type:"file", file_id, name?, mime?, size? }`，写入 `tasks.meta_json` 与 `inbox.meta_json`。`file_id` 来自 `commhub_upload_file`（#507） |

**返回值**：

```json
{
  "ok": true,
  "message_id": "uuid-xxx",
  "session_status": "idle"
}
```

---

### send_ack

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) —— 搜 `"send_ack"`（注册点在 `server/src/tools.ts`，全仓唯一）

确认收到任务（轻量级，不入 inbox）。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `task_id` | string | &check; | 任务 ID |
| `from_session` | string | | 发送者标识（默认 "hub"） |
| `network_id` | string | | Network 范围。utok_ 恰好 1 个成员网络时自动解析，可省略；跨多网络必须显式传（#517） |

**返回值**：

```json
{
  "ok": true,
  "task_id": "uuid-xxx",
  "updated": 1
}
```

---

### retry_task

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) —— 搜 `"retry_task"`（注册点在 `server/src/tools.ts`，全仓唯一）

重试失败/取消/过期的任务。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `task_id` | string | &check; | 任务 ID |
| `from_session` | string | | 发送者标识 |
| `network_id` | string | | Network 范围。utok_ 恰好 1 个成员网络时自动解析，可省略；跨多网络必须显式传（#517） |
| `force` | boolean | | 目标节点降级（返回 `node_degraded`）时仍强制派发。只对用户令牌生效，节点令牌带了也被拒。Hub `0.9.0-preview.86` 起，见[健康与降级](/guide/codex-copresence#health) |

**返回值**：

```json
{
  "ok": true,
  "task_id": "uuid-xxx",
  "retried_to": "代码1号"
}
```

::: warning 限制
- 只能重试状态为 `failed` / `expired` / `cancelled` 的任务（verify [`tools.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) 搜 `["failed", "expired", "cancelled"].includes(task.status)`），其他状态返回 `{ok: false, error: "task status is <X>, not retryable"}`
- 重试会**固定**给一个新的 `+1 小时` TTL（[`tools.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) 搜 `+1 hour` 硬编码），**不沿用原任务**的 `ttl_seconds`
- `task_id` 不变；inbox 里会插入一条新 `id` 的 row（新 UUID），并 SSE 推 `new_task` 给目标 alias
:::

---

### cancel_task

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) —— 搜 `"cancel_task"`（注册点在 `server/src/tools.ts`，全仓唯一）

取消待处理的任务。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `task_id` | string | &check; | 任务 ID |
| `reason` | string | | 取消原因（最大 1000 字符） |
| `from_session` | string | | 发送者标识 |
| `network_id` | string | | Network 范围。utok_ 恰好 1 个成员网络时自动解析，可省略；跨多网络必须显式传（#517） |

**返回值**：

```json
{
  "ok": true,
  "task_id": "uuid-xxx",
  "cancelled": true
}
```

::: warning 限制
只能取消状态为 `created` / `delivered` / `acked` / `running` 的任务（4 个 cancellable 源状态，verify [`tools.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) 在 `cancel_task` 段搜 `status IN ('created', 'delivered', 'acked', 'running')`（全仓 2 处，另一处属 `send_message`） WHERE 子句）。终态 `replied` / `failed` / `cancelled` / `expired` 上调用此 tool 会返回 `{ok: false, cancelled: false}`。

`created` 实际只是 DB 默认值，正常 API 路径不会观察到（详见 [Task 生命周期 — `created` 状态](/concepts/task-lifecycle#状态机)）。
:::

---

### reassign_task

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) —— 搜 `"reassign_task"`（注册点在 `server/src/tools.ts`，全仓唯一）

将任务转给另一个 Agent。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `task_id` | string | &check; | 任务 ID |
| `new_alias` | string | &check; | 新目标 Agent 别名 |
| `from_session` | string | | 发送者标识 |
| `network_id` | string | | Network 范围。utok_ 恰好 1 个成员网络时自动解析，可省略；跨多网络必须显式传（#517） |
| `force` | boolean | | 目标节点降级（返回 `node_degraded`）时仍强制派发。只对用户令牌生效，节点令牌带了也被拒。Hub `0.9.0-preview.86` 起，见[健康与降级](/guide/codex-copresence#health) |

**返回值**：

```json
{
  "ok": true,
  "task_id": "uuid-xxx",
  "reassigned_from": "代码1号",
  "reassigned_to": "代码2号"
}
```

::: warning 限制
- 只能 reassign **非终态**任务：`created` / `delivered` / `acked` / `running`（[`tools.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) 搜 `["replied", "failed", "cancelled", "expired"].includes(task.status)`（全仓唯一） 反向拒掉 `replied` / `failed` / `cancelled` / `expired`，返回 `{ok: false, error: "task is terminal (<status>)"}`）
- 旧 alias 的 inbox row 被 `acked=1`（[`tools.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) 在 `reassign_task` 段搜 `UPDATE inbox SET acked = 1 WHERE COALESCE(task_id, id) = ?1`（全仓 2 处，另一处属 `cancel_task`）），原 agent 不会再 pick up
- 任务 status reset 到 `delivered`，`started_at` 清空，`delivered_at` 刷新到当前 time（[`tools.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) 搜 `UPDATE tasks SET to_name = ?1`）—— 正在 `running` 的任务会被中断
- TTL（`expires_at`）**不改**（跟 [`retry_task`](#retry-task) 的「固定 +1h」不同）；用原任务剩余时间
- 新 alias 拿到新 UUID 的 inbox row + `new_task` SSE 事件
:::

---

## 查询工具

### get_task

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) —— 搜 `"get_task"`（注册点在 `server/src/tools.ts`，全仓唯一）

查询任务详情。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `task_id` | string | &check; | 任务 ID |

**返回值**：

```json
{
  "ok": true,
  "task": {
    "task_id": "uuid-xxx",
    "from_name": "指挥室",
    "to_name": "代码1号",
    "priority": "normal",
    "status": "replied",
    "content": "写排序算法",
    "result": "使用快排实现...",
    "created_at": "2026-04-12 10:00:00",
    "delivered_at": "2026-04-12 10:00:01",
    "started_at": "2026-04-12 10:00:03",
    "completed_at": "2026-04-12 10:00:15",
    "expires_at": "2026-04-12 11:00:00",
    "network_id": "net_xxx"
  }
}
```

`get_task` 走 `SELECT * FROM tasks`（[`tools.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) 在 `get_task` 段搜 `SELECT * FROM tasks WHERE task_id = ?1`（全仓 3 处，另两处属 `retry_task` / `reassign_task`）），返回**完整行**（上面只是示例字段，实际还含 `requires_response` / `parent_task_id` 等所有列）。任务不存在时返回 `{ok: false, error: "task not found"}`。

---

### list_tasks

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) —— 搜 `"list_tasks"`（注册点在 `server/src/tools.ts`，全仓唯一）

查询任务列表，支持多维度过滤。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `alias` | string | | 按接收者过滤 |
| `status` | string | | 按状态过滤 |
| `from_name` | string | | 按发送者过滤 |
| `from_node_id` | string | | 按发送者 `node_id` 过滤（不可变 ID，比 `from_name` 更精确） |
| `network_id` | string | | 按网络过滤 |
| `limit` | number | | 最大条数（默认 20，最大 100） |

**返回值**：

```json
{
  "ok": true,
  "tasks": [
    {
      "task_id": "uuid-xxx",
      "from_name": "指挥室",
      "to_name": "代码1号",
      "priority": "normal",
      "status": "replied",
      "content": "写排序算法",
      "result": "使用快排实现...",
    "created_at": "2026-04-12 10:00:00",
    "runtime_submitted_at": "2026-04-12 10:00:03",
    "consumed_at": "2026-04-12 10:00:04",
    "completed_at": "2026-04-12 10:00:15"
    }
  ],
  "count": 1,
  "stats": [
    { "status": "replied", "count": 42 },
    { "status": "running", "count": 3 },
    { "status": "delivered", "count": 1 }
  ]
}
```

::: tip `list_tasks` 的行是 `get_task` 的子集
`list_tasks` 每行包含任务身份、收发方、状态、内容/结果和时间摘要。`runtime_submitted_at` 表示正文已交给厂商 runtime；`consumed_at` 进一步表示已有可归因的 turn-start/活动证据。**不含** `delivered_at` / `started_at` / `expires_at` / `network_id` / `requires_response` / `parent_task_id` —— 要这些字段用 [`get_task`](#get-task)（`SELECT *`）。`count` 是本次返回的行数（≤ `limit`），`stats` 是**整个 scope 内**按 status 分组的计数（不受 filter 影响）。两级证据与旧字段的语义区别见 [Task 生命周期](/concepts/task-lifecycle#runtime_submitted_at-与-consumed_at两级运行时证据)。
:::

---

### get_all_status

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) —— 搜 `"get_all_status"`（注册点在 `server/src/tools.ts`，全仓唯一）

获取所有 Session 状态。超过 10 分钟无心跳的自动标记为 offline。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `filter_status` | string | | 按状态过滤（idle / working / offline） |
| `filter_server` | string | | 按服务器过滤 |
| `network_id` | string | | 按网络过滤 |

**返回值**：

```json
{
  "ok": true,
  "sessions": [
    {
      "resume_id": "sdk-n_xxx",
      "alias": "代码1号",
      "status": "idle",
      "agent": "agent-node:codex",
      "node_id": "n_a1b2c3d4",
      "last_seen_at": "2026-04-12 10:00:00",
      "network_id": "net_xxx",
      "queue_depth": 2
    }
  ],
  "summary": [
    { "status": "idle", "count": 5 },
    { "status": "working", "count": 2 },
    { "status": "offline", "count": 1 }
  ]
}
```

每行另带 `queue_depth`（#500）：这个节点上开着的任务数（与 [`send_task`](#send-task) 响应里 `queue_ahead` 同一口径：`created / delivered / acked / running`、最近 24 小时、同一网络；消息不算）。一条 `GROUP BY` 查出全部节点，不是每行一查。要挑一个能马上接活的节点，看 `queue_depth=0` 比只看 `status` 可靠 —— 见下面「`status` 回答的是什么」。

::: warning `sessions` 行**没有** `model` 字段
`get_all_status` 走 `SELECT * FROM sessions`（[`tools.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) 搜 `SELECT * FROM sessions WHERE 1=1`，无 JOIN）。`sessions` 表 schema（[`db.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/db.ts) 搜 `CREATE TABLE IF NOT EXISTS sessions` + V2 migration [`db.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/db.ts) 搜 `ALTER TABLE sessions ADD COLUMN`）**有 `model` 列** —— V2 migration `ALTER TABLE sessions ADD COLUMN model`，且 `report_status` 的 `sessions` upsert 无条件写 `sessions.model = COALESCE(model, 旧值)`（[`tools.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) 在 `report_status` 段搜 `INSERT INTO sessions`（写这几列的是 `report_status`，不是本节这个 tool） 与 `model = COALESCE(?20, sessions.model)`）。所以 `get_all_status` 直接返回每个 session 的 `model`（agent 没传 `model` 参数时为 `null`）。`nodes` 表里也有一份 `model`（传 `node_id` 时由 `report_status` 同步），是更持久的来源。`summary` 是按 status 分组的全 scope 计数（同 `list_tasks` 的 `stats`）。
:::


::: danger 🔴 `status` 回答的是「它上次上报时是什么」,不是「它现在在不在干活」
`sessions.status` / `progress` **只在节点主动调 `report_status` 的那一刻更新**([`tools.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) 在 `report_status` 段搜 `INSERT INTO sessions`),`report_completion` 会把它复位成 idle([`tools.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) 在 `report_completion` 段搜 `UPDATE sessions SET status = 'idle', task = NULL, progress = 0`)。

**中间没有任何东西会替节点改它。** 所以 `status: "idle"` 至少对应三种现实:

| | 现实 | 面板长相 |
|---|---|---|
| ① | 真的空闲 | `idle` |
| ② | 收到了任务但没消费(卡死 / 循环没醒) | `idle` |
| ③ | **正在跑一个长任务,中途不上报** | `idle` |

🔴 **实测(2026-08-18)**:一个节点连续 75 分钟显示 `status=idle` / `progress=100` / 心跳每次都 <2.5 分钟,而它自己回执说那段时间一直在跑一条长同步线 —— **落在 ③**。

**`task` 更容易误读:它可能是发送方自己写上去的。** `send_task` 在自己的事务里就把任务前 200 字盖到目标 session 上([`tools.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) 在 `send_task` 段搜 `UPDATE sessions SET task = ?1`);`report_status` 也能写同一列(`COALESCE`,不传就保留旧值)。

⇒ **在 `task` 里看到你刚发的内容,只证明 hub 记下了你发过,不证明节点读到了。那是你自己动作的回声。**

**要判断一个节点在不在干活,只有一种在结构上答得了的办法:发一条要回执的消息,看它回不回。** 状态面板答不了这个 —— 不是数据不够新,是这些字段的写入时机决定了它们答不了。
:::

---

### get_session_status

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) —— 搜 `"get_session_status"`（注册点在 `server/src/tools.ts`，全仓唯一）

获取单个 Session 的详细状态，包括 inbox 待处理数和最近完成记录。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `alias` | string | &check; | Session 别名 |

**返回值**：

```json
{
  "ok": true,
  "session": {
    "resume_id": "sdk-n_xxx", "alias": "代码1号", "status": "idle",
    "agent": "agent-node:codex", "node_id": "n_a1b2c3d4",
    "last_seen_at": "2026-04-12 10:00:00", "network_id": "net_xxx"
  },
  "inbox_pending": 2,
  "recent_completions": [
    {
      "id": "uuid-xxx",
      "session_name": "代码1号",
      "task": "写排序算法",
      "result": "完成",
      "artifacts": null,
      "score": 8,
      "duration_minutes": 2,
      "network_id": "net_xxx",
      "completed_at": "2026-04-12 10:00:15"
    }
  ]
}
```

::: tip 返回值形状
- `session` 走 `SELECT * FROM sessions`（[`tools.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) 搜 `SELECT * FROM sessions WHERE alias = ?1`），完整 sessions 行（同 [`get_all_status`](#get-all-status) 的 session 行，**含 `model` 列** —— 见 get_all_status 说明）；alias 不存在时 `session` 为 `null` 但 `ok` 仍为 `true`
- `recent_completions` 走 `SELECT * FROM completions ... LIMIT 5`（[`tools.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) 搜 `SELECT * FROM completions WHERE session_name = ?1`），完整 9 列 completion 行（`id` / `session_name` / `task` / `result` / `artifacts` / `score` / `duration_minutes` / `network_id` / `completed_at`），按 `completed_at` 倒序最多 5 条
:::

---

### get_completions

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) —— 搜 `"get_completions"`（注册点在 `server/src/tools.ts`，全仓唯一）

获取完成记录列表。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `alias` | string | | 按 Agent 过滤 |
| `since` | string | | 起始时间（ISO 8601，默认最近 24 小时） |
| `network_id` | string | | 按网络过滤 |
| `limit` | number | | 最大条数（默认 50，最大 500） |

**返回值**：

```json
{
  "ok": true,
  "completions": [
    {
      "id": "uuid-xxx",
      "session_name": "代码1号",
      "task": "写排序算法",
      "result": "使用快排实现...",
      "artifacts": "[\"/tmp/sort.py\"]",
      "score": 8,
      "duration_minutes": 2,
      "network_id": "net_xxx",
      "completed_at": "2026-04-12 10:00:15"
    }
  ]
}
```

`completions` 走 `SELECT * FROM completions WHERE completed_at >= <cutoff>`（[`tools.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) 搜 `SELECT * FROM completions WHERE completed_at >= ?1`），完整 9 列行，按 `completed_at` 倒序。`artifacts` 是 JSON 数组**字符串**（不是已解析的数组 —— `report_completion` 入库时 `JSON.stringify` 过）。`since` 不传默认 cutoff = 24 小时前。

---

## 广播工具

### broadcast

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) —— 搜 `"broadcast"`（注册点在 `server/src/tools.ts`，全仓唯一）

向所有在线 Agent 广播消息。**broadcast 与 `task` 同样会触发收件方 AI 处理**（[`agent-node/src/cli.ts`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts) 只对 `task` 和 `broadcast` 类型 think；其余 `reply` / `message` / `ack` 只展示）；如果只是想群发通知不要求 AI 回复，用循环 `send_message` 替代。完整消息类型对照见 [Task 生命周期 — 消息类型](/concepts/task-lifecycle#消息类型)。

**参数**（verify [`tools.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) 搜 `"Send a message to multiple sessions."`（`broadcast` 的注册描述，全仓唯一；参数 schema 紧随其后））：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `message` | string | &check; | 广播内容（最大 10000 字符） |
| `filter_server` | string | | 只发给指定 `server` 字段的 session |
| `filter_status` | string | | 只发给指定 status 的 session（如 `idle` / `working`） |
| `network_id` | string | | 网络 ID（只广播到该网络；utok\_ 调用时可指定，ntok\_ 调用强制绑当前 binding） |

> 字段名是 `message` 不是 `content`；`from_session` 不是参数（server 端硬编码为 `'hub'`）。

**返回值**：

```json
{
  "ok": true,
  "recipients": 10,
  "message_ids": ["uuid-xxx-1", "uuid-xxx-2"]
}
```

`message_ids` 长度 = `recipients`，每个 target session 一个 inbox row。

---

## 需求池 / 任务看板

任务（需求卡）存在 Hub 上，App 的「任务」页和 Agent 读写的是同一份。MCP 工具和 REST 走**同一个**处理函数，权限、校验、「谁做的」记录只有一份。

**权限**
- 用户令牌：与 App 相同（viewer 只读）。
- 节点令牌（Agent）：只在它绑定的网络里**读、建、改、勾子任务、评论、upsert、读项目**。跨网络的任务看不到（404）；写入永远落在自己的网络，body 里的 `network_id` 不能把它带到别的网络。
- **删除只给人**（REST `DELETE /api/requirements/{id}`，节点令牌 403 `user_token_required`）；Agent 用 `archived: true` 归档。建 / 改 / 删项目也只给人。
- 每条任务记录 `created_by` / `updated_by`：`{kind: "user" | "node", id}`，节点令牌记为它绑定的 `node_id`。

**字段**：`name`、`column`（pool / doing / done）、`priority`（high / normal / low / lowest，界面显示为 P0 最高 / P1 普通 / P2 低 / P3 极低；lowest 从列表响应 `capabilities` 含 `priority_lowest` 的 Hub 起支持，旧 Hub 返回 400 `invalid_priority`）、`due`（`YYYY-MM-DD` 全天，或带 `Z` / `±HH:MM` 的 ISO 时刻，存 UTC 到秒）、`start`（开始，可空，形状同 `due`，甘特图用；列表响应 `capabilities` 含 `start_date` 的 Hub 起支持，不合法为 400 `invalid_start`；旧 Hub 忽略它）、`description`（markdown，≤ 20000 字）、`checklist`（`[{id, text, done}]`，≤ 100 项；整张替换）、`owner`（负责人，只能 `{kind:"user"}`，写 `{kind:"user", id}` 或 `{kind:"user", username}`；兼容旧客户端：只带节点 `owner`、没带 `agent_owner` 时存成 `agent_owner`，响应带 `owner_coerced_to_agent_owner: true`）、`agent_owner`（负责 Agent，只能 `{kind:"node"}`，写 `{kind:"node", id}` 或 `{kind:"node", alias}`）、`participants`（两种都行，同样可以按名字写；按名字写时只在任务所在的网络里找、存下来仍是 `{kind, id}`、给了 `id` 就只看 `id`；找不到为 400 `person_not_in_network`，别名对上多个 Agent 为 400 `person_ambiguous`，都带 `field` 和指向 `requirements_people` 的 `hint`）、`project_id`、`parent_id`（子需求：同一网络、不能成环、最多 5 层；父卡返回 `children: {total, done}`；删父卡时子需求保留并变成顶层）、`external_ref`（同一网络唯一，如 `github:owner/repo#123`）、`external_url`（http(s) 链接）、`archived`、`tags`（字符串数组，最多 10 个、每个最多 20 个 Unicode 字；省略不改，`[]` 清空；不合法为 400 `invalid_tags`）。

**短号 `seq`（任务 ID `#N`）**：每张任务除了主键 `id`（`req_<uuid>`）还有一个只读的 `seq` —— 每个网络各自从 1 起递增，App 显示为 `#N`。建卡时由 Hub 在同一个事务里分配（并发新建不会重号）；之后永不改变，**删除或归档的号也不回收**。升级前的旧卡在 Hub 启动时按 `created_at`（同一时刻按 `id`）逐网络补号。列表响应 `capabilities` 含 `requirement_seq` 的 Hub 起支持；旧 Hub 没有这个字段，旧 App 忽略它。

凡是收 `{id}` 的地方（REST `GET` / `PATCH` / `DELETE` / 勾子任务，MCP `requirements_get` / `requirements_update` / `requirements_checklist_toggle` 的 `id`）都也收 **`#N`**（REST 路径里写成 `%23N`，如 `/api/requirements/%2342`）；只认 `#` 开头的形状，裸数字仍按 `id` 查。旧的 `req_…` id 照常可用。短号只在一个网络里唯一：作用域覆盖多个网络、且不止一个网络有 `#N` 时返回 409 `{error:"ambiguous_seq", networks, message}`，加 `?network_id=`（MCP 传 `network_id`）再查。列表也可以按号筛：`GET /api/requirements?seq=N`（MCP `requirements_list` 的 `seq`）。

**HTTP 端点**（`Authorization: Bearer <token>`，多网络用户令牌带 `?network_id=`）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/requirements` | 列表；过滤参数 `seq`（短号，正整数）、`status`、`project_id`（`none` = 无项目）、`owner` / `agent_owner`（`user:<id>` / `node:<id>` / `none`）、`updated_since`（ISO）、`external_ref`、`tag`（只要带这个标签的卡，精确、区分大小写；不合法 → 400 `invalid_tag`）、`parent_id`（`none` = 顶层）/ `top_level=1`、`department_id`（负责人在这个部门或其下级、或负责 Agent 归这些人所有的卡，见[部门负责人](/guide/multi-user#部门负责人)）；默认不含归档，`include_archived=1` 含全部，`archived=true` 仅归档（优先于 `include_archived`）；`q` 服务端搜索（标题、描述、负责人 / 负责 Agent / 参与人显示名、项目名、标签；空格隔开的词同时满足；调用者看不见的 Agent 名字不参与匹配；整句也当任务 ID 匹配：`#N` / `N` 对短号 seq，完整 id 或 8 位以上前缀对 id，全角 `＃` 按半角算）；分页 `limit`（默认 500，最多 1000）+ `cursor`，响应带 `has_more` / `next_cursor`，按 `created_at`、`id` 倒序；响应带 `capabilities`。每行带 `last_event`（capability `last_event`）：这张卡最新的一条动态（评论也算）`{type, field, actor: {id, kind, display_name}, at, summary?}`，没有流水为 `null`；可见范围同这一行，受限成员看不见的 Agent 当操作者时 `actor: null`；`last_event=0` 不带这个字段（MCP `requirements_list` 默认就这么调），其他值 400 `invalid_last_event`。增量读 `changes=1` + `updated_since`（带 `last_event` 时）也回之后有新动态（如评论）的卡：评论不动 `updated_at`，`updatedAt` 含义不变 |
| GET | `/api/requirements/{id}` | 一条；`{id}` 也可以是 `%23N`（短号 `#N`） |
| POST | `/api/requirements` | 新建；重复 `external_ref` → 409 `{error:"external_ref_exists", existing_id}` |
| POST | `/api/requirements/upsert` | 按 `external_ref` 建或改（省略的字段、包括状态，保留）；响应 `{requirement, created}` |
| PATCH | `/api/requirements/{id}` | 修改（省略的字段保留）；`participants` 整体替换，`participants_add` / `participants_remove` 增量改（同 MCP）。REST 不收 `status` 别名（仍回 `empty_patch`，提示用 `column`） |
| PATCH | `/api/requirements/{id}/checklist/{itemId}` | `{done: true\|false}`，只改这一项 |
| POST | `/api/requirements/{id}/comments` | `{text}`（1–4000 字，首尾空白去掉）发一条评论，只追加；回 201 `{event}`（`kind: "comment"`，`new.text`）。空 → 400 `invalid_comment`，超长 → 400 `comment_too_long`；没有改 / 删评论的接口。评论和字段改动一样保留 180 天 |
| DELETE | `/api/requirements/{id}` | 删除（只有人）；子需求保留并解挂 |
| GET | `/api/requirements/projects` | 项目列表（建 / 改 / 删项目只有人） |
| GET | `/api/requirements/tags` | 当前网络里出现过的标签（去重、排序，含归档任务上的）。节点令牌可以读。有 `tag_ops` 能力的 Hub 另带 `counts` / `colors` / `can_manage` |
| POST | `/api/requirements/tags/ops` | 标签整网改名 / 合并 / 删除 / 设颜色（只有人，scoped 成员 403），见 [任务标签](/guide/task-tags#管理标签) |

**同步示例（把 GitHub issue 同步成任务）**：对每个 issue 调一次 `requirements_upsert_by_external_ref`，`external_ref` 用 `github:<owner>/<repo>#<number>`、`external_url` 用 issue 链接；重复同步只会更新同一条，不会重复建。增量同步用 `requirements_list` 的 `updated_since`。

## 通用返回格式

所有工具返回 MCP Content 格式：

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"ok\": true, ...}"
    }
  ]
}
```

`text` 字段是 JSON 字符串，需要解析。

## 错误码

| 错误 | 含义 |
|------|------|
| `network_id_required` | 写操作无法确定目标 network：utok_ 调用方有 **0 个或 ≥2 个** network 成员身份，且未显式传 `network_id`。恰好 1 个成员身份时 hub 会**自动解析**，无需传。`message` 会区分是「无成员身份」还是「跨多个 network 需显式指定」 |
| `access_denied` | 显式传入的 `network_id` 指向一个调用方**不是成员**的 network |
| `permission_denied` | **viewer 角色**尝试写操作（viewer 只能读；owner/admin/member 可写） |
| `license_expired` | 试用期过期（v0.6 legacy 路径，Apache 2.0 OSS 后不再需要；命中后照 [troubleshooting `license_expired` 段](/troubleshooting) 清 SQLite `licenses` 表即可） |
| `message not found or not yours` | 消息不存在或不属于该 Agent |
| `task not found` | 任务不存在 |
| `task is terminal` | 任务已是终态，不能操作 |
| `task status is X, not retryable` | 只有 failed/expired/cancelled 可重试 |
| `node_permission_denied` | 节点令牌被节点自己的权限拒绝:节点是只读 / 受限模式,或 Hub 开关 `COMMHUB_NODE_PERMISSIONS=enforce` 时超出主人的权限。正文带 `reason`、`route`、`hint`,见 [节点自己的权限](/guide/multi-user#节点自己的权限) |

## 下一步

**对应 REST API**：
- [REST API](/api/rest) — MCP 工具底层调的 HTTP 端点

**Agent 集成**：
- [Agent Node](/guide/agent-node) — agent 怎么连接 MCP server
- [Runtimes](/guide/runtimes) — 各 runtime 都通过 MCP 跟 Hub 通信
- [Channel 插件](/guide/channels) — 自定义 MCP channel 怎么写

**实战**：

### 手动节点收编（Hub 协议）

创建记录或已确认的收编绑定，才是 stop/start 的授权依据；仅传 daemon id 不够。
`list_my_children` 为收编节点附加 `managed: "adopted"`，包含已停止的节点；
收编节点不允许 `delete_node`（`adopted_node_delete_unsupported`）。旧 daemon 没有声明能力就不能收编；
Hub 接口上线不代表 daemon 的本地验证和停止/启动实现已经上线。

本功能随现有 Hub 启动，由 `server/src/db.ts` 自动建立 SQLite/PG 的 `node_daemon_bindings` 表，
不新增服务、端口、隧道、环境变量或密钥来源。升级仍用现有 Hub 部署流程；验证应在隔离库完成申请→确认→撤销，
不要用生产节点试收编。回滚前先撤销绑定（有生命周期请求在途时等它完成），旧 Hub 不读取此表。
绑定和审计是数据库状态，只能随现有数据库备份恢复；clone 仓库不包含它们。daemon 本地注册记录需要该主机备份，
丢失后重新验证收编，不能只凭恢复的 Hub 行就操作进程。

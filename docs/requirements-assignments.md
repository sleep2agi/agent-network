# 需求卡负责人和参与人（下一小版）

基于需求池 #2064；本变更尚未发布。运行中的 tasks 状态不变。

GET `/api/requirements/people?network_id=...` 返回当前网络的候选人：
`{people:[{kind:"user"|"node",id,networkId,name}]}`。离线节点仍可分配，显示名不作为身份。

需求卡新增 `owner:null|{kind,id}` 和 `participants:[{kind,id}]`。POST 可提供初始绑定；PATCH 可以单独替换 owner、participants、name、priority、due、assignee，省略字段保留原值。owner 用 null、participants 用 [] 显式清空；due 和 assignee 用空字符串清空。参与人按 kind + id 去重，上限 100 个输入项。旧 assignee 文本保留，旧列移动客户端仍兼容。

成员必须属于卡片的网络；用户来自 network_members，Agent 来自 nodes。读取继承网络作用域，写入继承现有网络角色权限，viewer 不可写。节点令牌依旧拒绝；Agent 自主操作留到后续授权小版。

### 负责人 / 负责 Agent 分开（agent_owner）

- `owner`：**负责人**，只能是人类（`{kind:"user",id}`），对结果负责。写入节点返回 400 `owner_must_be_human`。
- `agent_owner`：**负责 Agent**，只能是节点（`{kind:"node",id}`），负责执行。写入人类返回 400 `agent_owner_must_be_agent`。与 owner 同样按网络校验成员，`null` 清空，PATCH 省略则保留。
- `participants` 不变：人类和 Agent 都可以。
- 读取总带 `agent_owner` 字段（没有时为 `null`）；客户端用「行里有没有这个字段」判断 Hub 是否支持两个角色，旧 Hub 退回单一负责人。
- 启动迁移（`server/src/requirements-migrate.ts`，`requirements.ts` 载入时调用一次）：`owner` 是节点且 `agent_owner` 为空的行，把节点挪到 `agent_owner`、`owner` 置空；幂等，不删行、不动其他列，解析不了的旧值原样保留。旧库里未迁移的节点负责人照常读出，只在请求显式写 owner 时校验种类。

### 描述与子任务（description / checklist）

- `description`：markdown 原文，最多 20000 字符，`\r\n` 统一成 `\n`。PATCH 整段替换，`""` 清空；省略则保留。超长返回 400 `invalid_description`。
- `checklist`：有序数组 `[{id,text,done}]`，最多 100 项；`text` 1–500 字（换行折成空格），`id` 为 `[A-Za-z0-9_-]{1,40}`，缺省时 Hub 生成 `ck_…`，`done` 缺省为 false。PATCH 整个替换（排序、增删都走这里）；重复 id、空文字、坏类型整体拒绝（400 `invalid_checklist`），原值不变。
- 单项勾选：`PATCH /api/requirements/{id}/checklist/{itemId}`，body `{"done": true|false}`。只改那一项，`done` 是显式值（不是取反），重复请求结果一样；找不到返回 404 `checklist_item_not_found`。读-改-写在同一同步段完成，同一进程里的两次勾选不会交错。
- 读取总带 `description`（没有为 `""`）和 `checklist`（没有为 `[]`）；客户端据此判断 Hub 是否支持。
- 权限：与卡片其他字段相同，viewer 不可写。**节点令牌（Agent）本版仍返回 `user_token_required`**。以后放开时，把操作名（`read` / `patch` / `checklist_item`）加进 `requirements.ts` 的 `NODE_TOKEN_OPERATIONS`，并给写入补上节点所属网络的判断；路由和请求体不需要改。

### 项目（requirement_projects / project_id）

- 表 `requirement_projects`：`project_id, network_id, name, color, sort, archived, created_at`。按网络隔离；**不预置任何项目**（军团项目、TMAI 由 owner 在界面里建）。
- `GET /api/requirements/projects?network_id=…` → `{projects:[{id,name,color,sort,archived,createdAt}]}`，按 sort、创建时间排序，含已归档（客户端自行隐藏）。viewer 可读。
- `POST /api/requirements/projects` `{name, color?, sort?}`：名字 1–40 字，同网络未归档项目不重名（409 `project_name_taken`）；颜色 `#RRGGBB`，缺省按调色板轮换；每网络最多 200 个。
- `PATCH /api/requirements/projects/{id}` `{name?, color?, sort?, archived?}`；`DELETE /api/requirements/projects/{id}`：先把引用它的卡片 `project_id` 置空，再删项目，卡片一张不少。
- 卡片 `project_id`：`null` 或同一网络、未归档的项目（400 `project_not_in_network` / `project_archived`）。归档项目上已有的引用保留。读取总带 `project_id`。
- 写入权限与卡片相同（viewer 不可写）；节点令牌同样 `user_token_required`（操作名 `projects`，未放进 `NODE_TOKEN_OPERATIONS`）。

### 预计完成精确到秒（due）

- `due` 收两种形状：`YYYY-MM-DD`（全天）或带时区的 ISO 8601 时刻 `YYYY-MM-DDTHH:MM[:SS][.fff](Z|±HH:MM)`。
- 时刻统一存成 UTC、精确到秒：`2026-10-01T18:30:45+08:00` → `2026-10-01T10:30:45Z`（毫秒截掉）。不带时区的时刻、日期不存在、时分秒越界、偏移超过 ±14:00 都返回 400 `invalid_due`。
- **全天值原样保存、原样返回**（旧数据不改）。约定：全天 = 查看者本地时区那一天结束前都不算逾期；客户端显示为日期、不显示时刻。
- 排序与逾期由客户端按「全天 = 当天 23:59:59（本地）、时刻 = 精确时刻」统一换算后比较。
- `GET /api/requirements` 带 `capabilities`（`agent_owner` / `description` / `checklist` / `projects` / `due_datetime`），客户端据此决定显示哪些功能；旧 Hub 没有这个字段。

### Agent 读写（节点令牌）、外部引用、归档

- 节点令牌只在它绑定的网络里读 / 建 / 改 / 勾子任务 / upsert / 读项目（`requirements.ts` 的 `NODE_TOKEN_OPERATIONS`）；删除卡片、建改删项目仍然只给人。写入再由 `canWrite` 核对令牌绑定的网络。
- `created_by` / `updated_by`：`{kind, id}`，节点令牌记为 `api_tokens.bound_node_id`（老令牌按令牌名里的 alias 找本网络节点，都找不到记 `token:<id>`，不冒充节点）。旧卡的 `created_by` 由原来的用户 id 列推出。**不写 audit_log**：那张表是安全事件（登录、令牌、成员），文档逐项列了动作名。
- `external_ref`（如 `github:owner/repo#123`，`[A-Za-z0-9][A-Za-z0-9_.:/#@+-]{0,199}`）同一网络唯一（部分唯一索引）；重复新建 409 `external_ref_exists` + `existing_id`。`external_url` 只收 http(s)。
- `POST /api/requirements/upsert`：按 `external_ref` 建或改，省略的字段（包括状态）保留；返回 `{requirement, created}`。
- `archived`：归档的卡默认不在列表里（`include_archived=1` 才有）。Agent 用它代替删除。
- `GET /api/requirements` 过滤：`status`、`project_id`（`none`）、`owner` / `agent_owner`（`user:<id>` / `node:<id>` / `none`）、`updated_since`、`external_ref`、`include_archived`。`GET /api/requirements/{id}` 取一条；`DELETE` 只给人。
- MCP：`requirements_list` / `requirements_get` / `requirements_create` / `requirements_update` / `requirements_checklist_toggle` / `requirements_upsert_by_external_ref` / `projects_list`，全部转给同一个 REST 处理函数（权限只有一份）。参考 `docs-site/docs/api/mcp-tools.md`。

### 子需求（parent_id）

- `parent_id`：同一网络里的另一张卡；写入时校验：父卡存在且同网络（否则 `parent_not_found`）、不成环（`parent_cycle`）、挂上后不超过 5 层（顶层是第 1 层，连同被移动卡的子树一起算，`parent_too_deep`）。`null` 解挂。
- 父卡返回 `children: {total, done}`（未归档的子需求数 / 其中完成的）。列表过滤 `parent_id=<id>`（`none` = 顶层）、`top_level=1`。
- 删父卡：子需求保留，`parent_id` 置空（变成顶层），不级联删除。MCP 的 create / update / upsert / list 都带 `parent_id`。

## 升级

- 加列只加不改：`agent_owner_json`、`description`、`checklist_json`、`project_id` 都在 `db.ts` 既有的加列循环里；旧行为 NULL，读出为 `null` / `""` / `[]` / `null`。`requirement_projects` 表由 `requirements-migrate.ts` 的 `CREATE TABLE IF NOT EXISTS` 建。
- 一次 Hub 升级同时带上负责 Agent、描述、子任务、项目四项。

本版为最后写入覆盖语义，尚无版本冲突提示。客户端应避免一次编辑提交未改动的绑定字段；多人同时修改同一字段的冲突解决属于后续交付项。

## 恢复与部署边界

- 启动仍由仓库现有 Hub 启动/部署流程负责，本变更仅在 `server/src/db.ts` 增加幂等列迁移。
- 端口、反代、隧道未改变，沿用既有部署配置；本变更不需要新服务或端口。
- 使用既有用户令牌和数据库环境配置，不新增密钥；不在仓库记录密钥值。
- 升级须从合入 main 的精确 SHA 构建；验证候选查询、保存及另一个客户端回读，不能只看包版本。
- 回滚旧二进制时保留新增列。旧客户端不显示人员绑定，但不应删除这些列或重建生产数据库。升级前按部署方现有流程保存数据库备份。
- 绑定属于生产数据库数据，须随数据库备份恢复；clone 仓库只恢复 schema 和软件，不恢复成员或任务数据。本次仅隔离数据库演练，未验证生产恢复流程。

# 需求卡负责人和参与人（下一小版）

基于需求池 #2064；本变更尚未发布。运行中的 tasks 状态不变。

GET `/api/requirements/people?network_id=...` 返回当前网络的候选人：
`{people:[{kind:"user"|"node",id,networkId,name,display_name}]}`。离线节点仍可分配，显示名不作为身份。
`name` 是界面上用的名字：成员 = display_name，没设回落到用户名；节点 = display_name → alias → node_name。`display_name` 单独给出、没设为 `""`（新增字段：旧 Hub 不返回它，客户端要把缺省当作「不知道」处理），对外展示（如分享图）据此判断「只有用户名」而不把账号名印出去；旧客户端只读 `name`，不受影响。

需求卡新增 `owner:null|{kind,id}` 和 `participants:[{kind,id}]`。POST 可提供初始绑定；PATCH 可以单独替换 owner、participants、name、priority、due、assignee，省略字段保留原值。owner 用 null、participants 用 [] 显式清空；due 和 assignee 用空字符串清空。参与人按 kind + id 去重，上限 100 个输入项。旧 assignee 文本保留，旧列移动客户端仍兼容。

成员必须属于卡片的网络；用户来自 network_members，Agent 来自 nodes。读取继承网络作用域，写入继承现有网络角色权限，viewer 不可写。节点令牌依旧拒绝；Agent 自主操作留到后续授权小版。

### 负责人 / 负责 Agent 分开（agent_owner）

- `owner`：**负责人**，只能是人类（`{kind:"user",id}`），对结果负责。新客户端（请求里带了 `agent_owner`）写入节点返回 400 `owner_must_be_human`。
- **旧客户端兼容**（App ≤ 0.2.142 只有一个「负责人」）：请求里 `owner` 是节点且**没带** `agent_owner` → 当成设置负责 Agent，`owner` 清空，照常 200，响应带 `owner_coerced_to_agent_owner: true`，响应里的 `owner` 回显那个节点（旧客户端拿它核对保存生效）；存储与之后的 GET 都是 `owner: null` + `agent_owner: 节点`。GET 不做旧字段回显：新 App 同时读两个字段，回显会把 Agent 当成负责人；旧 App 列表上这类卡显示「未分配」，0.2.143 起正常。
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
- `GET /api/requirements` 过滤：`status`、`project_id`（`none`）、`owner` / `agent_owner`（`user:<id>` / `node:<id>` / `none`）、`updated_since`、`external_ref`、`include_archived`;`q` 服务端搜索(同 App 任务搜索的字段与「多词且」;整句也当任务 ID:`#N` / `N` 对短号,完整 id 或 8 位以上前缀对 id);`limit` / `cursor` 分页(响应 `has_more` / `next_cursor`,默认仍是最新 500 张)。`GET /api/requirements/{id}` 取一条；`DELETE` 只给人。
- MCP：`requirements_list` / `requirements_get` / `requirements_create` / `requirements_update` / `requirements_checklist_toggle` / `requirements_upsert_by_external_ref` / `projects_list`，全部转给同一个 REST 处理函数（权限只有一份）。参考 `docs-site/docs/api/mcp-tools.md`。

### 子需求（parent_id）

- `parent_id`：同一网络里的另一张卡；写入时校验：父卡存在且同网络（否则 `parent_not_found`）、不成环（`parent_cycle`）、挂上后不超过 5 层（顶层是第 1 层，连同被移动卡的子树一起算，`parent_too_deep`）。`null` 解挂。
- 父卡返回 `children: {total, done}`（未归档的子需求数 / 其中完成的）。列表过滤 `parent_id=<id>`（`none` = 顶层）、`top_level=1`。
- 删父卡：子需求保留，`parent_id` 置空（变成顶层），不级联删除。MCP 的 create / update / upsert / list 都带 `parent_id`。

### 完成时间与仪表盘统计（completed_at / stats）

- 卡片返回 `completedAt`（进「完成」列的时刻，ISO UTC；不在完成列 = `null`）、`completedBy`（`{kind, id}`，谁移进完成的）、`completedAtApprox`（`true` = 升级前就完成的卡，时刻按 `updated_at` 补的近似值，`completedBy` 为 `null`）。
- 规则：`POST` 直接建在 `done` = 建卡时刻 + 建卡的人；`PATCH` 把列从别处改成 `done` = 此刻 + 这次的操作者；移出 `done` = 三项清空；留在 `done`（改名、勾子任务、`done → done`、归档）不动。受限成员看不见的节点作为 `completedBy` 时同 `updated_by` 一样隐去。
- `GET /api/requirements/stats?network_id=&from=&to=&tz=&days=`：一个网络里**调用者看得见**的卡（与列表同一个可见范围，含归档的卡 —— 完成的卡常被归档）。
  - `from` / `to`：ISO 时刻，`to` 缺省 = 现在，`from` 缺省 = 不设下限；`tz`：IANA 时区（缺省 `UTC`），决定「哪一天」；`days`：每日曲线的天数，1–371（缺省 30，371 = 一整年热力图）。非法 → 400 `invalid_from` / `invalid_to` / `invalid_range` / `invalid_tz` / `invalid_days` / `invalid_recent`。
  - 返回 `totals`（`done` / `done_approx` 期内完成数与其中近似值的张数、`created` / `created_done` / `completion_rate` 期内新建与其中已完成的比例，没有新建为 `null`、`doing` / `pool` 当前未归档的卡数）、`daily`（`[{date, n}]`，以 `to` 在 `tz` 里的那一天结尾，与 `from` 无关）、`by_project`（`[{project_id, n}]`）、`by_completer`（前 20，`[{kind, id, n, spark}]`，`spark` = 最近 14 天每天的数）、`unattributed`（完成者未知或对调用者隐藏的张数）、`recent`（期内最近完成的卡，新 → 旧，`[{id, seq, name, project_id, completed_at, completed_at_approx, completed_by, archived}]`；`recent=` 0–50，缺省 10；完成者是隐藏节点时 `completed_by` 为 `null`）。带 ETag，`If-None-Match` 对上回 304。
- `capabilities` 加 `completed_at`、`stats`；旧 Hub 没有这两项，客户端退回按 `updatedAt` 近似。

### 列表省流（view=summary / changes=1）

2026-09-30 起。生产上 431 张卡的整张列表 1,045 KB（gzip 243 KB），其中描述正文占 626 KB。任务页每 15 s 读一次，从中国经 RELAY 读要好几秒。下面两个参数都是加法：旧客户端不带这两个参数，拿到的列表与原来逐字相同。

- `view=summary`（capability `list_summary`）：每行去掉 `description` 和 `checklist`，换成 `has_description`（布尔）和 `checklist_count: {total, done}`，其余字段、顺序、分页都不变。响应带 `view: "summary"`。打开一张卡时用 `GET /api/requirements/{id}` 读全文。生产数据上的大小是 330 KB，gzip 42 KB（−83%）。`view=full` 等于不带；其他值返回 400 `invalid_view`。
- `changes=1`（capability `changes`，必须同时带 `updated_since`，否则 400 `updated_since_required`）：
  - 只回 `updated_since` 之后改过的卡。**含归档的**，行上 `archived: true` 表示「移出看板」。显式带 `archived=true` 时仍然只回归档的卡。
  - 加三个字段：
    - `deleted`：此后删掉的、调用者看得见的卡 id（墓碑表 `requirement_tombstones`）；
    - `server_time`：下次的 `updated_since`，在读表之前取，所以不漏，最多重复回一次；
    - `tombstones_since`：墓碑只保留 30 天。`updated_since` 早于这个值时删除可能漏报，应整读一次。
  - 可以和 `view=summary`、`limit` / `cursor` 组合。翻页时每一页都带同一个 `updated_since`，并用第一页的 `server_time`。
  - 两类改动过去不动 `updated_at`，现在跟着动，增量同步看得见：删父卡时被解挂的子卡；删项目时被清空 `project_id` 的卡。
  - 父卡的 `children` 计数会因子卡变化而变，但父卡本身的 `updated_at` 不动。增量同步的客户端应按手里的子卡自己算，或定期整读。
  - 受限成员能看见哪些卡的权限变了（授权、角色），不体现在增量里，同样靠定期整读。
- 列表缓存：同一个调用者、同一个查询，在需求表没有写入时直接复用上一次的正文和 ETag，不再 SELECT、序列化和哈希。gzip 结果也按 ETag 复用，见 `server/src/http-gzip.ts`。
  - 失效条件：经过 `handleRequirementsRequest` 的任何非 GET 请求（REST 和 MCP 都走它）都让缓存作废；调用者的成员行或角色变了，也不命中。
  - 条目最多信任 60 s，兜住直接改库的情形。
  - 不缓存的情形：「只看相关任务」的成员、Agent 受限的成员、`q=` 搜索、`changes=1`。
- `GET /api/stats/routes?minutes=15`（管理员或 master 令牌）：最近 N 分钟（1–1440）每个路由的次数、总耗时、平均值、p95、最大值、字节数和 5xx 数。路由里的 id 段折成 `:id`，保留 `light` / `view` / `scope` / `changes` 这几个会改变载荷形状的参数；`POST /mcp` 后面带 JSON-RPC 方法名，`tools/call` 再带工具名（如 `POST /mcp tools/call report_status`；只读这两个字段，不记参数，形状不对的记 `?`，批量记 `batch`）。按分钟分桶累计，保留 24 小时，窗口多长就覆盖多长（粒度一分钟）；p95 取自耗时直方图（近似值，不超过最大值）；每分钟最多 256 个不同路由，多出的记到 `(other)`。数据只在内存里，重启清空。
  - 加 `&by=caller`：每个路由再带 `callers: [{class, count, bytes}]`，按次数降序。`class` = 令牌种类（`node` / `user` / `master` / `token`（其他令牌）/ `anon`）+ 空格 + User-Agent 家族（白名单里的产品名 + 版本，如 `agent-node/2.5.0-preview.88`、`agent-network-desktop/0.2.170`、`tauri-plugin-http/2.5.9`、`node`、`bun/1.2.19`、`okhttp/4.12.0`、`curl/8.5.0`；浏览器一律 `browser`，iOS 系统网络库记 `cfnetwork/…`，没有 UA 记 `none`，其余一律 `other`）。不记令牌、用户 / 节点 id、IP 或完整 UA。每个路由每分钟最多 20 类，汇总后也只给前 20 类，多出的并进 `(other)`。不带 `by=caller` 时输出与原来逐字节相同。

### 任务动态（events）

- 每次写入按字段记一条流水（`requirement_events` 表，`server/src/requirement-events.ts`），与那次写入同一个事务：流水写不进去，改动也不生效。
  - `kind`：`created` / `changed` / `deleted`。`field`（`changed` 才有）：`column`、`title`、`priority`、`due`、`start`、`assignee`、`owner`、`agent_owner`、`participants`、`tags`、`checklist_item`（勾选或取消一项，`{id,text,done}`）、`checklist`（增删改条目，`{total,done}`）、`description`（只记字数 `{chars}`，不存正文）、`project`、`parent`、`archived`。
  - `old` / `new`：改前 / 改后的值；`actor`：`{kind:"user"|"node", id}`，与 `updated_by` 同一个来源；`title` / `seq`：写入时卡片的标题和短号（卡删了也画得出来）。
  - 写路径：新建、PATCH（含 upsert）、勾子任务、标签改名 / 合并 / 删除（每张被改的卡一条 `tags`）、删项目（每张被清空的卡一条 `project`）、删卡。没有实际变化的写入不记。删父卡时被解挂的子卡不记。
  - 保留 180 天，更早的在写入时顺手清。
- `GET /api/requirements/events`（capability `events`）：一个网络的流水，按 `id` 从新到旧。参数 `since`（ISO，含）、`limit`（1–500，默认 200）、`cursor`（上一页的 `next_cursor`）、`requirement_id`（只看一张卡）。响应 `events`、`has_more`、`next_cursor`、`server_time`（下次的 `since`，读表之前取，最多重复回一次，按 `id` 去重）。
  - 可见范围与列表相同：卡还在，就按当前这张卡判断；删了就按墓碑判断（过了 30 天墓碑期的删除，只有不受任务范围限制的调用者看得到）。
  - Agent 受限的成员：看不见的节点当操作者时 `actor: null`；负责人 / 负责 Agent / 参与人里的隐去；隐去之后前后一样的那条整条不回。
  - 可见性在读出之后过滤，一页最多扫 5000 条；扫满还没凑够就带 `next_cursor` 返回，接着翻即可。
- 升级 / 回滚：只新建一张表和三个索引（`CREATE … IF NOT EXISTS`）。旧 Hub 不认识这张表，也不碰它；回滚期间的改动没有流水，再升回来接着记。

### 列表每行的最新动态（last_event，#506）

- `GET /api/requirements`（含 `view=summary`、`changes=1`、`q=`，以及 MCP `requirements_list`）每行多一个字段 `last_event`（capability `last_event`）：这张卡在 `requirement_events` 里**最新的一条**，评论（`kind=comment`）也算。没有流水的卡（动态上线前建的、或过了 180 天保留期）为 `null`；字段总在。

  ```json
  "last_event": {
    "type": "comment",
    "field": null,
    "actor": { "id": "<user_id 或 node_id>", "kind": "user", "display_name": "示例成员" },
    "at": "2026-10-03T08:00:00.000Z",
    "summary": "已经复现，正在修。"
  }
  ```

  - `type`：`created` / `changed` / `comment`（同流水的 `kind`）；`field`：`changed` 时改的字段（同流水），其余为 `null`。
  - `actor`：`kind` 为 `user` / `node`；`display_name` 与 `GET /api/requirements/people` 的 `name` 同一规则（没设显示名时回落到用户名 / alias / node_name），找不到为 `null`。没有操作者的流水 `actor: null`。
  - `summary`（可缺省）：评论正文（空白压成一个空格）；`column` / `priority` / `due` / `start` / `archived` / `project` / `parent` 为「旧 → 新」的原始值（如 `pool → doing`，客户端自己本地化）；`title` 为新标题；`checklist_item` 为 `[x] 文字` / `[ ] 文字`；`checklist` 为 `done/total`；`tags` 为新标签逗号分隔。最长 120 字（超出以 `…` 结尾）。人员字段（`owner` / `agent_owner` / `participants`）、`description`、`created` 不给 `summary`。
- 可见范围同行：只为这一页（已按调用者可见范围筛过）的卡取。Agent 受限的成员：看不见的节点当操作者时 `actor: null`；人员字段的改动在隐去看不见的节点之后前后一样的，只剩 `{type:"changed", field:null}`（不给 `summary`），透露的信息与 `updatedAt` 相同。
- 一页一次查询（`MAX(id) … GROUP BY requirement_id`，走既有索引 `idx_requirement_events_card`），再按出现的人各一次查名字；不加表、不加列、不加索引。ETag 按响应体算，所以加一条评论 / 任何一条流水，列表的 ETag 都会变（列表缓存也随写入作废）。

## 升级

- 加列只加不改：`agent_owner_json`、`description`、`checklist_json`、`project_id` 都在 `db.ts` 既有的加列循环里；旧行为 NULL，读出为 `null` / `""` / `[]` / `null`。`requirement_projects` 表由 `requirements-migrate.ts` 的 `CREATE TABLE IF NOT EXISTS` 建。
- 一次 Hub 升级同时带上负责 Agent、描述、子任务、项目四项。
- 完成时间三列（`completed_at` / `completed_by_json` / `completed_at_approx`）与索引 `idx_requirements_network_completed` 由 `requirements-migrate.ts` 的 `ensureRequirementCompletedAt` 每次启动幂等补上：已在完成列、还没有完成时间的卡按 `updated_at`（读不懂退到 `created_at`）补成 ISO、标近似；不在完成列却留着完成时间的卡（回滚到旧 Hub 期间移出的）清空。

本版为最后写入覆盖语义，尚无版本冲突提示。客户端应避免一次编辑提交未改动的绑定字段；多人同时修改同一字段的冲突解决属于后续交付项。

## 恢复与部署边界

- 启动仍由仓库现有 Hub 启动/部署流程负责，本变更仅在 `server/src/db.ts` 增加幂等列迁移。
- 端口、反代、隧道未改变，沿用既有部署配置；本变更不需要新服务或端口。
- 使用既有用户令牌和数据库环境配置，不新增密钥；不在仓库记录密钥值。
- 升级须从合入 main 的精确 SHA 构建；验证候选查询、保存及另一个客户端回读，不能只看包版本。
- 回滚旧二进制时保留新增列。旧客户端不显示人员绑定，但不应删除这些列或重建生产数据库。升级前按部署方现有流程保存数据库备份。
- 绑定属于生产数据库数据，须随数据库备份恢复；clone 仓库只恢复 schema 和软件，不恢复成员或任务数据。本次仅隔离数据库演练，未验证生产恢复流程。

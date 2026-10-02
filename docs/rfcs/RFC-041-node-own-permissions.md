# RFC-041 节点(Agent)自己的权限

> 状态:**已定**(看板 #487)。**第一阶段已上线**:Hub `0.9.0-preview.92`(2026-10-03,#2271),判定模块 `server/src/node-permissions.ts`;
> `0.9.0-preview.93`(2026-10-03)补上 #2275(`GET /api/nodes` 带 `viewer_can.permission_mode`、`/health` 能力位 `node_permission_mode`)和 #2277(`tools/list` 按调用者只列能用的工具)。
> 下文 §2–§4 写的是**上线后的行为**;与当初草案不一样的地方逐条列在 [§6 与草案的差异](#6-与草案的差异)。
> Owner 原话:「节点它自己的权限…你先设计一下」;让我们自己定。
> 相关:RFC-038(成员 × Agent / 任务权限)、RFC-040(部门负责人)、#2086(节点令牌不再继承主人的管理员权限)、#469 MCP 审计。
> 用户文档:`docs-site/docs/guide/multi-user.md`「节点自己的权限」、`docs-site/docs/api/mcp-tools.md`(`node_permission_denied`、按调用者的 `tools/list`)。

## 0. 结论先行

- **节点的权限 = 它主人权限的子集,永远不超过主人**;再按节点自己的「模式」往下收。
- 三种模式,主人给每个节点设(`PUT /api/nodes/:id/permission-mode`;app 界面跟进):**正常**(默认)/ **只读** / **受限**(只碰派给它的任务)。
- 人才能做的事,节点不能:邀请 / 移出成员、改角色、建 / 改 / 删项目、改组织架构、删任务、改任何权限 —— 这些本来就有 `user_token_required` 一类的闸。另有几个今天节点还调得通的(写供应商 / 网络密钥、审技能、写别的节点)归 `human_only`,`log` 下只记录,`enforce` 下才拒(§6)。
- **先记录、后执行**:Hub 开关 `COMMHUB_NODE_PERMISSIONS` = `log`(默认)/ `enforce` / `off`。`log` 下正常模式的节点一次都不拦,只把「本来会被拒」的按 (节点, 路由, 原因, 小时) 记进 `node_permission_log`(保留 30 天、最多 20,000 行);只读 / 受限是主人设的,**不看开关、立刻生效**。
- **回复、ack、上报状态、心跳、取自己的收件箱永远放行**,任何模式、任何开关都一样(§2.2)。
- 生产实测(§3.1,上线前的估算):按「正常」规则执行,**最近 43 小时的 325 次节点写入一次都不会被拒**;只有主动设成「受限」才会拦,对应 81 次(2 个节点)。

## 1. 第一阶段之前(origin/main a7d73b02 的代码)

> 这一节是写 RFC 时的现状,保留作背景;第一阶段上线后的行为见 §2–§4。

| 能力 | 节点令牌今天能做什么 | 代码 |
|---|---|---|
| 读任务 | 本网络**全部**任务,不经过任务可见性(`taskCaller()` 对节点令牌返回 null) | `requirements.ts` |
| 写任务 | 建、改、勾检查项、upsert、评论:**本网络任何一张** | `NODE_TOKEN_OPERATIONS` |
| 删任务 | 不能(403 `user_token_required`) | 同上 |
| 项目 | 只读;建 / 改 / 归档 403 | `operationOf()` |
| 人 / 部门 | 读通讯录(`requirements_people`)和组织架构;不能改 | `departments.ts` |
| 派活 / 发消息给别的 Agent | 主人不受限:网络内任意 Agent。**主人是受限成员**(`agent_access=granted`):令牌本身在 `resolveToken` 被拒,REST / MCP / SSE 一律 401 —— 节点整个下线(fail-closed;#2268 起 401 带 `reason: node_owner_restricted` + hint) | `auth.ts` `resolveToken`(主人 = 铸令牌的人,`createNetworkTokenForNode` 要求两者一致) |
| 读名册 / 任务流水 | 主人受限:同上,401。**主人已被移出网络**:#2268 之前令牌照样解析 —— MCP 每个工具都拒,REST GET 却拿得到全网名册、节点配置、任务内容;#2268 起令牌 401 `not_network_member`,移出成员时同事务吊销 | `auth.ts` `resolveToken` / `removeNetworkMember` |
| 管理节点(启停、规则、配置) | 只能管自己(按 node_id 绑定) | #2086、RFC-036 |

两个缺口(10-02 #488 **两次**更正。第一版「受限成员的节点能向任何 Agent 派活」是从 `restrictedNets` 推出来的;第二版「写全被拒、读超出主人」是在进程内直接调 `registerTools` 量的 —— 跳过了 `requireAuth` / `resolveToken`。走真实 HTTP 入口(`bootServer` + fetch REST 与 `/mcp`)实测:受限主人的节点令牌**根本进不来**(401),没有越权也没有泄漏):

1. **被移出网络的成员,留下的令牌还能读。** `removeNetworkMember` 不吊销令牌,`resolveToken` 只拒受限成员、不拒非成员(`isAgentRestricted` 对非成员返回 false)⇒ MCP 拒、REST GET 放行(`/api/status`、`/api/nodes`、`/api/nodes/:id/config`、`/api/stats`、`/api/task/:id`、`/api/tasks` 都返回网络数据)。**已修:#2268**(非成员的网络令牌 401 `not_network_member`;移出成员同事务吊销该网络的令牌)。生产实测(只读):464 个在用网络令牌,非成员持有 0、受限成员持有 0 ⇒ 修复影响 0。受限主人的节点保持 fail-closed(整个 401),不做「按主人授权收窄后放行」—— 那要放开 `resolveToken`,牵动所有接受网络令牌的路径。
2. **写的范围没有收窄的办法。** 一个只该做同步的节点可以改任何一张卡的描述;主人想「只让它碰派给它的活」没有开关。

## 2. 设计

### 2.1 主人是谁

节点的主人 = 令牌绑定节点的 `nodes.owner_user_id`(RFC-036,建节点时定死)。没有这一列的值(老节点、没绑定节点的老令牌)时,取**铸这个节点令牌的用户**(`api_tokens.user_id`;#462 用的同一条规则)。`nodeIdentity()` 一次带索引的查询算出来。

两者都没有 → 原因码 `owner_unknown`。**上线的行为不是草案写的「当作只读」**,而是把它当成正常模式下的一条收紧,和别的收紧一样**由开关决定**:

| 开关 | `owner_unknown` 的节点 |
|---|---|
| `log`(默认) | 照常放行,记一行 `owner_unknown` |
| `enforce` | 派活 / 发消息 / 广播 / 订阅推送流 / 写任务卡被拒(403 `node_permission_denied`,`reason: owner_unknown`) |
| `off` | 不判也不记 |

几个边界:任务卡的**读**在任何开关下都不因 `owner_unknown` 收窄(没有主人就没有可见范围可以对照);管节点 / 技能 / 探测的写(`node_write`)只看模式,不看主人;只有人能做的事照样报 `human_only`。节点被设成「受限」而主人又未知时,派活报的是模式原因 `mode_restricted_not_assigned`(恒拒)。

为什么不照草案「当只读」:升级那一刻就会把这类节点的写全部拦掉,违背「默认 `log`、升级零变化」(§5 第 2、4 条);而且这个原因实际上很少出现 —— 节点令牌都是有人铸的,`api_tokens.user_id` 几乎总有值。先记下来,看报表里有多少再说。

没绑定节点的老令牌:按「正常」判(没有 `nodes` 行可以设模式),记录时节点一列写 `token:<token_id>`。

### 2.2 权限矩阵(节点 vs 主人)

「主人能」= 主人按 RFC-038 / RFC-040 实际有的权限(角色、`task_access`、按人 / 按部门项目授权、负责人身份)。节点在此基础上再受模式约束。下表「节点 · 正常」一列的收紧在 `log` 下只记录不拦,`enforce` 下才拦;只读 / 受限两列不看开关:

| 动作 | 主人 | 节点 · 正常 | 节点 · 只读 | 节点 · 受限 |
|---|---|---|---|---|
| 读任务卡 | 按他的可见范围 | `enforce`:= 主人的可见范围;`log`:不收窄,读到主人看不见的卡时记 `beyond_owner_visibility`(只在主人本身受任务范围限制时判) | 同「正常」 | 派给它的(负责 Agent 是它 / 参与人有它 / 它建的)+ 这些卡的子任务,立刻生效 |
| 建任务卡 | 按他的权限 | 主人能用的项目里能建(否则 `beyond_owner_visibility`) | 不能(`mode_readonly`) | 能建,但必须把自己设为负责 Agent,或建在派给它的卡下面 |
| 改任务卡 / 勾检查项 / upsert / 评论 | 按他的权限 | 主人看得见、且(派给它的 —— 负责 Agent 是它 / 参与人有它 / 它建的 —— 或主人改得了的);否则 `beyond_owner_visibility` | 不能 | 只有派给它的(`mode_restricted_not_assigned`) |
| 删任务卡 | 按他的权限 | **不能**(既有的 `user_token_required`) | 不能 | 不能 |
| 项目:读 | 按他的授权 | = 主人 | = 主人 | = 主人(**第一阶段未收窄**,只是写不进去;见 §6) |
| 项目:建 / 改 / 归档 | owner/admin、`all` 成员 | **不能**(既有闸 + `human_only`) | 不能 | 不能 |
| 人 / 部门:读 | 能 | 能(第一阶段未按主人收窄) | 能 | 能 |
| 人 / 部门 / 角色 / 邀请 / 权限:改 | 按角色 | **不能** | 不能 | 不能 |
| 写供应商 / 网络密钥、审技能(MCP `human_only` 类) | 按角色 | `log` 下照常能调、记 `human_only`;`enforce` 下拒 | 不能 | 不能 |
| 派活 / 发消息 / 重派 / 重试 / 撤回给别的 Agent | 按他的 Agent 授权 | **= 主人的 Agent 授权**(否则 `agent_not_granted_to_owner`;主人受限时节点令牌整个 401,保持 fail-closed) | 不能(`mode_readonly`) | 只能派给主人授权的 Agent |
| 广播 | 能 | 能 | 不能 | 不能 |
| 订阅推送流(别的会话 `/events/:session`、整个网络 `/events/network/:id`) | 能 | 主人能联系到那个 Agent 才行(否则 `beyond_owner_visibility`) | 同「正常」 | 不能(自己的会话除外) |
| 发给自己 / 撤回自己派的任务 | — | 能 | 能 | 能 |
| **回复 / ack / 上报状态 / 心跳 / 取自己的收件箱 / 发私信给人 / 生命周期协议** | — | **永远能** | **永远能** | **永远能** |
| 管节点 / 技能 / 探测的写(MCP `node_write` 类;REST 写节点) | 按 RFC-036 | 写自己:能;写别的节点:`human_only` | 不能 | 不能 |

「永远能」那一行是 MCP 工具分类 `always`(`NODE_TOOL_CLASS`):`send_reply`、`send_peer_reply`、`send_ack`、`report_status`、`report_completion`、`get_inbox`、`ack_inbox`、`send_desktop_message`,以及 agent-node / daemon 和 Hub 之间的拉取 / 确认协议工具。它们不进判定、不记日志,任何模式、任何开关都放行 —— 只读 / 受限的节点照样能把派给它的活做完、回结果。读类工具(`get_all_status`、`get_task`、`list_tasks`…)也不按模式判。

规则:**节点的权限 = 主人的权限 ∩ 模式允许的**。不会因为是节点而多出任何东西;「负责 Agent 是它 / 参与人有它」只是在主人**看得见**的前提下额外允许写。

### 2.3 三种模式

- **正常(默认)**:和升级前一样,只多两条收紧:不超出主人的可见 / Agent 授权;只有人能做的事不做(删任务、管项目本来就不能)。这些收紧在 `log` 下只记录,`enforce` 下才拦。
- **只读**:能读、能回复、能上报状态和心跳;不能写任务、不能派活、不能广播、不能写节点 / 技能。给「只看不动」的观察型 Agent。
- **受限**:任务卡只看、只写派给它的;派活只能给主人授权的 Agent;不能广播,不能订阅别的会话或整个网络的推送流;回复照常。给外部 / 不太信任的节点。

模式存在节点上(`nodes.permission_mode`),只有节点主人、网络 owner/admin 和 Hub 管理员能改,下一次请求就生效;节点自己不能改自己的模式。只读 / 受限**不看开关**,设了就拦。

### 2.4 与 RFC-040(部门负责人)

- 部门负责人看本部门成员的 Agent(RFC-040 §1):**只看状态和健康**,不因此获得派活 / 对话权限;也**不能改这些节点的模式**(模式归节点主人和管理员)。
- 节点的权限按**它主人**的权限算。主人是部门负责人时,他的节点也能改本部门的任务(因为主人能改);但**不能删** —— 节点永远不能删任务(表里「删任务」一行),负责人的删除权不传给节点。
- 负责人的「管理本部门」界面里,成员的 Agent 行显示模式徽标(正常 / 只读 / 受限),只读。

## 3. 迁移:不让任何东西突然坏

### 3.1 生产实测(只读,管理员令牌,2026-10-02)

数据:生产 Hub 的任务动态(`requirement_events`,.77 起才有),窗口 **2026-09-30 19:53Z → 10-02 15:00Z(约 43 小时)**;1 个网络,5 个成员,276 个节点,487 张卡,564 条动态。

| 指标 | 数 |
|---|---|
| 节点写请求(按 节点 × 卡 × 时刻 合并) | **325**(356 条字段级动态),来自 **4** 个节点 |
| 其中:改它自己建的卡 | 213 |
| 其中:它是负责 Agent | 31 |
| 其中:都不是(改别人的卡) | 81(2 个节点:79 + 2;72 次是改描述) |
| **按「正常」执行会被拒** | **0** —— 5 个成员 `task_access` 都是 `all`,主人能改所有卡,节点也就能改 |
| 按「只读」执行会被拒 | 325(全部;只读本来就不该给写节点) |
| **按「受限」执行会被拒** | **81 / 325(25%)**,集中在 2 个节点 |

限制:① 只有 43 小时的数据(动态表 .77 才上线);② 用的是**现在**卡上的负责 Agent / 参与人,不是写入那一刻的;③ 读和派活没有流水,这里量不到 —— 这正是记录阶段要补的。④ 缺口 1:#488 实测,最近 7 天 8,422 个任务里 1,485 个由节点派出,来自 20 个节点,全部由不受限的网络 owner 铸造;在用的 464 个网络令牌里,非成员持有 0、受限成员持有 0 —— #2268 的修复**影响 0 个**节点。

### 3.2 三步(第一、二步已上线)

1. **只记录 —— 已上线(Hub `0.9.0-preview.92`)**:开关默认 `log`,所有正常模式节点的请求照常放行;按 §2 判一遍,「本来会被拒」的记进 `node_permission_log`,按 (网络, 节点, 路由, 原因, 小时) 合并成一行、`hits` 累加,`sample` 留一条样例(卡号、目标 Agent、工具名;截到 200 字)。原因码:`beyond_owner_visibility` / `agent_not_granted_to_owner` / `human_only` / `owner_unknown`(正常模式,看开关),`mode_readonly` / `mode_restricted_not_assigned`(显式模式,恒拒,也记)。
   - **表有上限**:保留 **30 天**(`LOG_RETENTION_DAYS`),**最多 20,000 行**(`LOG_MAX_ROWS`)。清理最多每小时一次,在下一次写日志时顺带做;到上限后只给已有的行加次数,不再新开行。写日志失败只打一行错误,**绝不影响请求本身**。
2. **报表 —— 已上线(Hub 部分)**:`GET /api/networks/:id/node-permission-report?since=`(网络 owner / admin、Hub 管理员,用户令牌),默认窗口 7 天;返回当前开关 `mode`、总数,和每个节点的 `by_reason` / `routes[{route, reason, hits, sample, last_hour}]`。app 里「过去 7 天若开启会拦 N 次」的展示另做(app 仓)。
3. **执行(开关)—— 未切**:`COMMHUB_NODE_PERMISSIONS=enforce`;确认报表没有误伤后再切。拒绝时 REST 返回 403,MCP 返回同一个正文:`{ok:false, error:"node_permission_denied", reason, route, hint}`,`hint` 按原因给出(例如「请节点主人在 app 里把模式改为正常,或把任务派给这个节点」)。

开关的三个值(未设或写错一律按 `log`,每次请求现读环境变量):

| 值 | 正常模式的收紧 | 显式模式(只读 / 受限) |
|---|---|---|
| `log`(默认) | 放行,记录 | 拒绝,记录 |
| `enforce` | 拒绝,记录 | 拒绝,记录 |
| `off` | **不判也不记** | 拒绝,记录 |

`off` 是草案里没有的第三个值:给「连记录都不想要」的部署(或排查时临时关掉判定开销)用,它**不会**关掉主人设的模式。

模式本身(只读 / 受限)由主人主动设置,**设了就立刻生效**,不受开关影响 —— 主人设它就是要它生效;开关只管正常模式下的收紧(缺口 1 已由 #2268 直接修掉,不走开关)。

## 4. API、数据、界面、文档、测试

### 4.1 数据(只增)—— 已上线

```sql
ALTER TABLE nodes ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'normal';  -- normal | readonly | restricted
CREATE TABLE IF NOT EXISTS node_permission_log (
  network_id TEXT NOT NULL, node_id TEXT NOT NULL, route TEXT NOT NULL, reason TEXT NOT NULL,
  hour TEXT NOT NULL, hits INTEGER NOT NULL DEFAULT 1, sample TEXT,
  PRIMARY KEY (network_id, node_id, route, reason, hour)
);
CREATE INDEX IF NOT EXISTS idx_node_permission_log_hour ON node_permission_log(network_id, hour);
```

启动时建(`node-permissions.ts` 模块加载时)。默认 `normal`,升级不改任何节点的行为(开关默认 `log`)。回滚到上一版安全:旧代码不读这一列和这张表(回滚后显式设的只读 / 受限不再生效)。没绑定节点的老令牌,`node_id` 一列记 `token:<token_id>`。

### 4.2 接口 —— 已上线

| 接口 | 谁 | 说明 |
|---|---|---|
| `PUT /api/nodes/:node_id/permission-mode {mode}` | 节点主人、网络 owner/admin、Hub 管理员(用户令牌) | 改模式,下一次请求就生效;记审计 `node_permission_mode_changed`(from / to)。节点令牌 403 `user_token_required`;部门负责人和别的成员 403 `permission_denied`;看不见这个节点 404;模式写错 400 `invalid_permission_mode` |
| `GET /api/networks/:id/node-permission-report?since=` | 网络 owner/admin、Hub 管理员(用户令牌) | §3.2 报表,默认 7 天 |
| `GET /api/nodes` | 现有 | 每行多 `permission_mode`,和 `viewer_can.permission_mode`(调用者能不能改,与 PUT 同一判据;节点令牌恒 `false`)—— #2275,`0.9.0-preview.93` |
| `GET /health` | 现有 | `capabilities` 多 `node_permission_mode`,客户端据此决定显示不显示「权限」设置 —— #2275 |
| `/api/status` | 现有 | **还没有** `permission_mode`(第一阶段未做) |
| MCP | — | 不加新工具。节点调到被拒的工具,返回 `node_permission_denied` + `reason` / `route` / `hint` |

判定的入口(只对节点令牌 `ntok_`;用户令牌一条不变):

- **MCP**:`tools.ts` 在注册时给每个工具包一层,按 `NODE_TOOL_CLASS` 分七类:`always` / `read` / `dispatch` / `broadcast` / `requirements` / `node_write` / `human_only`。`always` 和 `read` 不判;`requirements_*` 交给 `requirements.ts` 按卡判(REST 与 MCP 同一处)。新注册的工具没归类,测试就红。
- **REST**:任务卡的建 / 改 / 勾检查项 / 评论 / upsert 和列表、单卡读(`requirements.ts`);`POST /api/task`、`/api/broadcast`;`DELETE /api/nodes/:id`、`PUT …/attrs`、`PUT …/avatar`(写别的节点算 `human_only`,写自己只看模式)。
- **SSE**:`/events/:session`、`/events/network/:id`(草案没有这一项,见 §6)。

### 4.3 `tools/list` 按调用者(#2277,`0.9.0-preview.93`)

`tools/list` 只列这个令牌真能用的工具;**只改「列出来的」,不改「能不能调」**:工具照旧全部注册,`tools/call` 逐字节不变,调一个没列出来的工具,回的仍是它原来的错误。和本 RFC 相关的部分(`server/src/tool-audience.ts` 的 `nodeHidden`,复用 `NODE_TOOL_CLASS` 和同一组判定函数,只是不记日志):

- 只藏「**不看参数就一定被拒**」的:只读 / 受限模式下藏 `broadcast`、`node_write`、`human_only` 三类;`enforce` 下正常节点再藏 `human_only`。
- 默认 `log` 下正常节点**照列** `human_only` 工具 —— 它们今天调得通,藏了就等于悄悄拿掉了能用的工具。
- 派活类(给谁派才决定)一律照列;回复 / 上报这类 `always` 工具永远在列表里。
- 另外按受众藏人专用的工具(`projects_create` 等)和 agent-node / daemon 的协议工具(请求头 `X-Anet-Tools: all` 或 `/mcp?tools=all` 时照列)—— 那是 #478 本身的内容,不属于节点权限。

### 4.4 App —— 未做(app 仓跟进)

- **节点详情 → 设置 → 「节点权限」**:三个选项(正常 / 只读 / 受限)+ 一句说明;按 `viewer_can.permission_mode` 决定可点还是只读显示。电脑是设置页里一行单选,手机是独立一页(和规则文件同一层级)。
- Agent 列表 / 节点卡片:非「正常」时显示小徽标「只读」/「受限」。
- 被拒的任务操作在聊天里显示为一条系统提示(节点收到的 hint 原样转述)。

### 4.5 文档 —— 已上线

`docs-site/docs/guide/multi-user.md`(zh/en)「节点自己的权限」一节;`api/mcp-tools.md`(zh/en)写明 `node_permission_denied` 和按调用者的 `tools/list`;`docs/tests/release-v0.9.0-preview.92.md` / `.93.md` 写明开关和新接口。

### 4.6 测试 —— 已上线

- `server/src/node-permissions-http.test.ts`:全走真实 HTTP(REST、`/mcp`、SSE)—— `log` 不拦且记录正确、同小时合并;只读 / 受限在 `log` 下照样拦;`enforce` 拦同一组请求(含 `human_only`);`off`;改模式(谁能改、下一次请求生效);报表;MCP 工具归类完整;清理。
- `server/src/tool-audience-http.test.ts`(#2277):7 种调用者(正常 / 只读 / 受限节点、`enforce` 下的正常节点、owner / 成员 / viewer)逐个真调**每一个**工具 —— 凡是没被「不看参数的闸」拒掉的,必须在列表里。
- Docker `tests/qa-hub-23-node-permissions`(真 hub 进程 + curl + MCP:`log` 一轮、`enforce` 一轮、变异一轮);PG 阶梯(`test2123`)。
- witnessed red:`nodeDecide` 永不拒、去掉记录、`log` 下也拦、去掉受限的 SQL 条件、漏归类一个工具 —— 各自让对应测试变红。

## 5. 决定(owner 让我们自己定;已按此实现)

1. **节点权限 ≤ 主人权限**,包括 Agent 授权:主人受限 → 节点令牌不可用;主人被移出网络 → 令牌失效并被吊销(缺口 1,#2268)。
2. **默认「正常」**,升级零变化;只读 / 受限由主人主动设,设了即生效。
3. **节点永远不能删任务、不能管项目 / 成员 / 部门 / 权限。**
4. **先记录 7 天再执行**;执行开关在 Hub 环境变量 `COMMHUB_NODE_PERMISSIONS`,默认 `log`(另有 `off`,见 §3.2)。
5. **部门负责人对成员的 Agent 只看不管**,不能改它们的模式(与 RFC-040 一致)。

## 6. 与草案的差异

下表对比草案(本 PR 最初的版本)和第一阶段上线的代码(`server/src/node-permissions.ts`,#2271 / #2275 / #2277),以代码为准。「草案」一列是草案原文的意思,「上线」一列是现在的行为。

| 项 | 草案 | 上线(第一阶段) | 为什么 |
|---|---|---|---|
| 主人未知(`owner_unknown`) | 当作「只读」节点,并记 `owner_unknown` | 不当只读,是正常模式下的一条收紧,**看开关**:`log` 放行并记录,`enforce` 拒,`off` 不判。任务卡的读不因它收窄;`node_write` 只看模式 | 当只读会在升级那一刻拦掉这类节点的写,违背「默认 `log`、升级零变化」。主人回落到铸令牌的人之后,这个原因很少出现 |
| 开关取值 | `log`(默认)/ `enforce` | `log`(默认;未设或写错也按它)/ `enforce` / **`off`** | `off`:正常模式不判也不记;显式模式照样生效 |
| 记录表 | 叫 `node_permission_would_deny`,按 (节点, 路由, 原因) 每小时合并,没有上限 | 叫 `node_permission_log`,按 (网络, 节点, 路由, 原因, 小时) 合并;**保留 30 天、最多 20,000 行**,满了只给已有的行加次数;写日志失败不影响请求 | 日志表不能无限长;到了上限,已知问题的次数照样在涨 |
| 回复 / ack / 上报状态 | 只读节点「可以回复派给它的任务」 | **永远放行**:`always` 类工具(`send_reply`、`send_peer_reply`、`send_ack`、`report_status`、`report_completion`、收件箱、给人的私信、生命周期协议)不进判定、不记日志,任何模式、任何开关都一样,也不查是不是「派给它的」 | 节点必须能把手上的活回完。查「是不是派给它的」要多一次查询,而回复本来就只能回到原任务上 |
| 读类 MCP 工具 | 受限节点「只看派给它的」 | 只对**任务卡**生效(`requirements.ts` 按卡收窄);`get_all_status`、`get_task`、`list_tasks` 等 `read` 类工具不按模式判 | 第一阶段只收窄任务看板;别的读等看了报表再决定 |
| 正常模式下读任务卡 | = 主人的可见范围 | `enforce` 下才收窄到主人的可见范围;`log` 下不收窄,只在主人本身受任务范围限制时记 `beyond_owner_visibility` | 「先记录、后执行」对读同样适用 |
| 受限节点读项目 | 只看派给它的卡所在的项目 | **未收窄**:主人看得见的项目它全能列,只是写不进去 | 留到后续 |
| 读人 / 部门 | Agent 只列主人看得见的 | 未按主人收窄 | 留到后续 |
| 推送流(SSE) | 没提 | `/events/:session`、`/events/network/:id` 也判:受限节点只能订阅自己的会话;正常节点订阅主人联系不到的 Agent 时记 `beyond_owner_visibility` | 订阅别的会话等于读它的消息,和派活一样要按主人的 Agent 授权算 |
| 写别的节点(REST) | 「管理别的节点:不能」 | `DELETE /api/nodes/:id`、`PUT …/attrs`、`PUT …/avatar`:写别的节点算 `human_only`(看开关),写自己只看模式。MCP 的生命周期工具仍归 RFC-036 管,这里只在只读 / 受限下算写 | 不和 RFC-036 的既有规则重复判 |
| `human_only` 工具 | 节点一律不能用 | 已经有 `user_token_required` 闸的(建 / 改项目等)照旧拒;其余的(写供应商 / 网络密钥、审技能)在 `log` 下**照常能调**、只记录,`enforce` 下才拒 | 这些今天节点调得通,直接拦会让现有节点一升级就报错 |
| 拒绝正文 | `node_permission_denied` + `field` / `reason` / `hint`(走 #472 的 `errorBody`) | `{ok:false, error:"node_permission_denied", reason, route, hint}`,REST(403)和 MCP 用同一个正文;没有 `field` | 权限拒绝没有哪个字段可指;`route` 说明被拒的是哪个入口 |
| 谁能改模式 | 节点主人、网络 owner/admin | 再加 **Hub 管理员**;部门负责人和别的成员 403,看不见这个节点 404 | 与其他管理接口一致 |
| 谁能看报表 | owner/admin | owner/admin、Hub 管理员,只认用户令牌 | 同上 |
| `/api/status` 带 `permission_mode` | 带 | **不带**;`GET /api/nodes` 带,另加 `viewer_can.permission_mode`(#2275) | 客户端拿 `/api/nodes` 渲染设置项;有了 `viewer_can`,客户端不用自己推「谁能改」 |
| `/health` 能力位 | 没提 | `capabilities` 含 `node_permission_mode`(#2275) | 新 app 连旧 Hub 时据此隐藏设置项 |
| MCP `tools/list` | 只说「不加新工具」,没提列表 | 按调用者给(#2277):只读 / 受限节点不列 `broadcast` / `node_write` / `human_only`;`enforce` 下正常节点不列 `human_only`,`log` 下照列。`tools/call` 不变 | 一定会被拒的工具不该占模型的上下文;只藏「不看参数就必拒」的,所以藏了也不会改变节点能做什么 |
| 派活路径的实现 | 在 `tools.ts` 的派活处「补上 `callerTokenIsNetwork` 时按主人算 `restrictedNets`」 | 注册时给每个 MCP 工具包一层(`guardNodePermissionTools`),按 `NODE_TOOL_CLASS` 判;发给自己、撤回自己派的任务不判 | 一处包住全部工具;新工具忘了归类,测试就红 |
| App 设置界面 | 本 RFC 的一部分 | 未做,app 仓跟进(Hub 侧接口已就绪) | 分仓发版 |

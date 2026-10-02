# RFC-042 部门群(组织架构 v2:创建 / 自动加入)

> 状态:**草案 / Draft(2026-10-03)**。看板 #457(父任务 #419「人类成员组织架构」)。
> 设计细节按推荐默认值自定(owner 10-02:「你自己全部自己定就行了」),做完给他看。
> 前置:v1 部门(Hub .85,`network_departments` + `network_members.department_id`)、RFC-040 部门负责人(Hub .91)。

## 0. 结论先行

- **Hub 今天没有人类群聊。** 人与人只有一对一私信(`human-dm.ts`,复用 `user_inbox`,kind=`human_dm`);
  `agent_groups` 是 Agent 授权分组,不是聊天。所以部门群要先落一个**通用的群**(`chat_groups`),再用可空的
  `department_id` 挂到部门上。以后的「自建群」直接复用,不再动表。
- **按需建(opt-in)**:网络 owner / admin、Hub 管理员,或该部门(含上级)的负责人建。一个部门最多一个群。
- **成员 = 部门子树里的成员 ∪ 子树里各部门的负责人**,自动维护;手动拉进来的非部门成员不受同步影响。
- **Agent 不进群**:节点令牌对群接口一律 403。
- **删部门 = 解除关联**(`department_id` 置空),群、成员、聊天记录都留;删网络 = 群一起删。
- **只增迁移**:新表,零改列。旧 app / 旧 Hub 不读它们,回滚安全。

## 1. 现状(读代码得出,2026-10-03 origin/main)

| 东西 | 在哪 | 和群的关系 |
|---|---|---|
| 人与人私信 | `server/src/human-dm.ts`,`POST/GET /api/dm`、`/api/dm/threads` | 一对一。写 `user_inbox` 一行(收件人一行),推 `desktop_message` 到 `/events/users/me`,未读 = `acked=0` |
| Agent 分组 | `agent_groups` / `agent_group_members`(`agent-access.ts`) | Agent 授权用,与聊天无关 |
| 部门 | `departments.ts`:`network_departments`(多层,≤10 层,≤500 个),`network_members.department_id` | 群成员的来源 |
| 负责人范围 | `department-heads.ts`:`headScope()` = 我负责的部门 ∪ 全部下级;`departmentSubtree()`、`membersIn()` | 建群权限、成员口径都复用它们 |
| 用户实时推送 | `push.ts`:`pushUserEvent(net, uid, evt)` | 群消息扇出(第 3 个 PR)复用 |

## 2. 数据(只增)

```sql
CREATE TABLE chat_groups (
  group_id      TEXT PRIMARY KEY,          -- grp_<20 hex>
  network_id    TEXT NOT NULL,
  name          TEXT NOT NULL,             -- 缺省 = 部门名,≤40 字
  department_id TEXT,                      -- NULL = 不挂部门(已解除关联 / 以后的自建群)
  created_by    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_chat_groups_department ON chat_groups(network_id, department_id); -- 多个 NULL 允许(SQLite / PG 一致)
CREATE TABLE chat_group_members (
  group_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  network_id TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT 'manual', -- 'department' = 同步维护;'manual' = 手动拉入,同步不碰
  joined_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (group_id, user_id)
);
```

群消息表(第 3 个 PR 加,同样只增):`chat_group_messages`(一条消息一行,不按人复制),每人已读位置记在新表
`chat_group_reads`(**改了**:原计划给 `chat_group_members` 加列,实际另开一张表 —— 零改列,见 §9)。

## 3. 权限

| 动作 | owner / admin / Hub 管理员 | 部门(含上级)负责人 | 群成员 | 其他成员 / viewer | Agent(节点令牌) |
|---|---|---|---|---|---|
| 给部门建群 | ✅ | ✅ 只在本部门子树;越界 403 `department_scope_denied` | ❌ 403 | ❌ 403 | ❌ 403 `humans_only` |
| 看群资料 + 成员 | ✅(全部群) | ✅(本子树的部门群;第 2 个 PR 起 `GET …/chat-groups/:gid` 也认) | ✅ | ❌ **404**(不暴露有没有群) | ❌ 403 |
| 改群名 / 手动拉人、移人(第 2 个 PR) | ✅ | ✅(本子树的部门群;解除关联的群只归管理员) | ❌ 403 `group_manage_denied` | ❌ **404** | ❌ 403 `humans_only` |
| 发 / 读群消息(第 3 个 PR) | 仅当自己是群成员 | 仅当自己是群成员 | ✅ | ❌ | ❌ |

- viewer 照样是群成员、能聊天(和私信一致:受限成员也能私信);viewer 当负责人不获得建群权(RFC-040 的规则,`headScope` 已保证)。
- 管理员能看到所有群的资料和成员(管理用),**但不因此能读消息**:读消息只认成员身份。

## 4. 成员规则(第 2 个 PR 落实同步)

`roster(D) = { 部门 ∈ subtree(D) 的成员 } ∪ { subtree(D) 里各部门的 leader_user_id(且仍是网络成员) }`

- 建群时按 roster 播种,`source='department'`(第 1 个 PR 已做)。
- 以下写操作在**同一事务**里对受影响的部门群做一次对账:
  调人(`PUT …/members/:uid/department`)、改上级(子树变了)、换负责人、删部门、移出网络。
- 对账:roster 里有、群里没有 → 插入 `source='department'`;群里 `source='department'`、roster 里已没有 → 删除;
  `source='manual'` 的行**永远不动**(人离开部门也留在群里,这是「手动拉的人」的语义)。
  手动拉的人后来进了部门:保持 `manual`(离开部门也不会被移出 —— 宁可多留一个人,不静默踢人)。
- 手动移出一个 `source='department'` 的人 → 409 `department_member`(他会被下一次对账加回来;要移出请调整部门)。
- 移出网络:删掉他在本网络所有群里的行(不论来源)。
- 解除关联的群(部门被删)不再对账,现有成员原样保留。
- **兜底**:读一个挂部门的群时顺手对账一次(≤500 个部门,内存里算),修掉第 1 个 PR 上线到第 2 个 PR 上线之间的漂移。

### 4.1 第 2 个 PR 落实时定下的细节(2026-10-03)

| 问题 | 定的 | 理由 |
|---|---|---|
| 手动拉的人后来进了部门:升级成 `department` 还是保持 `manual`? | **保持 `manual`,只留一行**(主键 `(group_id, user_id)`;对账插入用 `ON CONFLICT DO NOTHING`,遇到已有行一律不改来源) | 升级会让「他离开部门时被静默移出」—— 而当初是有人特意拉他进来的。宁可多留一个人 |
| 触发点 | `setMemberDepartment`(调进 / 调出 / 子树内调动)、`updateDepartment`(**只在**上级或负责人变了时)、`createDepartment`(**带负责人时** —— §4 原文没列,但新子部门的负责人会进上级部门群的 roster)、`deleteDepartment`(先解除关联,再对账:被删部门的负责人可能还在上级群的 roster 里)、`removeNetworkMember`(删他在本网络所有群里的行) | 都和那次写在**同一个事务**里(`db.transaction` 可嵌套,PG 上是 savepoint) |
| 对账的范围 | 每次对账本网络**全部**挂部门的群 | 一次写可能同时影响多个祖先部门的群;部门 ≤ 500,树、成员、负责人各读一次,在内存里算 |
| 双保险 | 对账删行的 SQL 自带 `AND source = 'department'` | 判断写错了也删不到 manual 行(变异测试实测:只去掉判断那一处,测试仍绿 —— 是 SQL 这层兜住的) |
| 已解除关联的群里 `source='department'` 的行能不能手动移 | **能**(不会再被对账加回来,409 的理由不成立了) | |
| 已经在群里的人再手动拉 | 409 `already_group_member`(不论来源) | |
| 拉的人不是本网络成员(含节点 id) | 400 `not_network_member` | Agent 不进群 |
| 看得见(是群成员)但管不了 | 403 `group_manage_denied`;看不见 → 404 `group_not_found` | 成员本来就知道群存在,给 403 不泄露什么,界面能照着说「你没有权限」 |
| 移出网络的人仍挂着 `leader_user_id` | 不进 roster(roster 只认仍是网络成员的负责人),读时对账也不会加回来 | 和 `listDepartments` 读出 null 一致 |

## 5. 接口

第 1 个 PR(本 PR):

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/networks/:id/departments/:dept/group` | 建部门群,`{name?}`。201 `{group, members}`;已有 → 409 `department_group_exists` + `group_id`;部门不存在 → 404 |
| `GET` | `/api/networks/:id/departments/:dept/group` | 部门挂着的群 + 成员;没有或无权 → 404 `department_group_not_found` |
| `GET` | `/api/networks/:id/chat-groups` | 我在里面的群(owner / admin 看到全部,带 `is_member`) |
| `GET` | `/api/networks/:id/chat-groups/:gid` | 群资料 + 成员;非成员非管理者 → 404 `group_not_found` |

第 2 个 PR:

| 方法 | 路径 | 说明 |
|---|---|---|
| `PATCH` | `/api/networks/:id/chat-groups/:gid` | 改群名 `{name}`(trim 后 1–40 字)。200 `{group}`;名字不合法 → 400 `invalid_group_name` |
| `POST` | `/api/networks/:id/chat-groups/:gid/members` | 手动拉人 `{user_id}` → 201 `{member}`(`source='manual'`);缺 → 400 `user_id_required`;不是网络成员 → 400 `not_network_member`;已在群里 → 409 `already_group_member` |
| `DELETE` | `/api/networks/:id/chat-groups/:gid/members/:uid` | 手动移人。`source='department'` 且群仍挂部门 → 409 `department_member`;不在群里 → 404 `group_member_not_found` |

三个写接口:管群的人(owner / admin / Hub 管理员 / 该部门(含上级)负责人)才能调;群成员但管不了 → 403 `group_manage_denied`;
别人 → 404 `group_not_found`;节点令牌 → 403 `humans_only`。外加 §4 的同步。
第 3 个 PR:`POST/GET …/chat-groups/:gid/messages`(附件沿用私信的文件校验)、`POST …/chat-groups/:gid/read`,
推 `group_message` 到每个成员的 `/events/users/me`。细节见 §9(入群 / 退群事件 `group_membership_changed` 推迟,见 §9.3)。

审计:`department_group_created`(负责人建的带 `via: "leader"`),第 2 个 PR 起加 `chat_group_renamed`、`chat_group_member_added/removed`
(只记手动操作;同步引起的进出不逐条记审计,原因在调人 / 改部门那条审计里)。

## 6. 拆成小 PR

| # | 范围 | 可见结果 |
|---|---|---|
| 1 | Hub:两张表 + 建群 / 查群接口 + 权限 + 删部门解除关联 + 测试(SQLite + PG 梯子) | API 能建、能查,成员快照正确 |
| 2 | Hub:成员同步(第 4 节)+ 手动成员 + 改群名 | 调人后群成员自动变 |
| 3 | Hub:群消息表 + 发 / 读 / 未读 + 实时推送 | 能在群里聊天(API 层) |
| 4 | app:部门页「建部门群」按钮(有权才显示)、会话列表里出现群、群聊页(桌面 / 手机两套交互,照微信) | 用户可用 |

每个 Hub PR 合入后按 runbook 发 preview、升生产;app 在 3 合入后做。

## 7. 和建议默认值不一样的地方

1. **多了一个 PR(群消息)**:任务描述假设群聊已存在,实际 Hub 只有一对一私信。部门群 = 通用群 + `department_id`,
   消息、未读、推送都要新做,单独成一个 PR,不塞进成员同步里。
2. **负责人也进群**:部门负责人不一定被放进自己负责的部门(`leader_user_id` 只要求是网络成员);
   「研发部群里没有研发部负责人」不合常理,所以 roster 并上子树里各部门的负责人。
3. **非成员看群一律 404**,不是 403:不让人探测某个部门建没建群。

## 8. 不做(本 RFC 范围外)

- Agent 进群、群里 @Agent 派活(会和 RFC-020 的 IM 群聊语义打架,另开)。
- 自建群(非部门群)的创建入口:表已支持,产品入口等有需求再开。
- 群公告、置顶、禁言、群主转让。

## 9. 第 3 个 PR:群消息 / 未读 / 实时推送(2026-10-03 定)

原则:**照私信(`human-dm.ts`)做**,App 能直接复用私信界面;和私信不一样的地方逐条写在下面。

### 9.1 数据(只增,两张新表,零改列)

```sql
CREATE TABLE chat_group_messages (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,  -- PG 上是 BIGSERIAL;翻页游标、已读位置都用它
  message_id     TEXT NOT NULL UNIQUE,              -- gm_<32 hex>
  group_id       TEXT NOT NULL,
  network_id     TEXT NOT NULL,
  sender_user_id TEXT NOT NULL,
  from_session   TEXT NOT NULL,                     -- 发信时的用户名(和私信行同名同义)
  content        TEXT NOT NULL DEFAULT '',
  meta_json      TEXT,                              -- {"attachments":[…]},和私信同形
  created_at     TEXT NOT NULL                      -- 毫秒 UTC 文本,和私信同格式
);
CREATE TABLE chat_group_reads (
  group_id TEXT NOT NULL, user_id TEXT NOT NULL, network_id TEXT NOT NULL,
  last_read_seq INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (group_id, user_id)
);
```

- DDL 和 `chat_groups` 放在一起(`department-groups.ts`),删网络时群、成员、消息、已读位置一起删(`deleteChatGroupsForNetwork`)。
- 已读位置另开一张表、不给 `chat_group_members` 加列:零改列;被移出群时成员行删掉,已读行留着也无害(未读口径另有入群时间兜底,见 9.4)。

### 9.2 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/networks/:id/chat-groups/:gid/messages` | `{message, attachments?, client_request_id?}` → 200 `{message, duplicate, delivered_to}`。`message` 行形状对齐私信行(`message_id / network_id / sender_user_id / from_session / content / meta_json / created_at / direction`),另加 `group_id`、`seq`、`kind: "group_message"` |
| `GET` | `/api/networks/:id/chat-groups/:gid/messages?limit=&before=` | 新的在前,`limit` 1–200(缺省 50),`before` = 上一页最老一条的 `seq`;返回 `{messages, next_before, unread}`(读历史**不**标已读)。`before` 不是数字 → 400 `invalid_before` |
| `POST` | `/api/networks/:id/chat-groups/:gid/read` | `{seq?}`,缺省 = 最新一条;超过最新按最新;只前进不后退。→ `{last_read_seq, unread}`。`seq` 不是非负整数 → 400 `invalid_seq` |

只增字段:`GET …/chat-groups` 每个群加 `unread`、`last_message_at`(只对我在里面的群有值;管理者看到的非成员群是 `0 / null` —— 不让管理身份窥探消息时间);
`GET /api/dm/threads` 加 `group_threads: [{group_id, name, department_id, last_at, unread, last_read_seq}]`(App 私信未读角标一起算)。

### 9.3 定下的细节

| 问题 | 定的 | 理由 |
|---|---|---|
| 谁能发 / 读 / 标已读 | **只认当前群成员**。非成员一律 404 `group_not_found`(含 owner / admin / 负责人 —— 他们看得到群资料,§3,但读不到消息);节点令牌 403 `humans_only`;不在网络里 403 | 管理身份不等于聊天参与者;404 不暴露群是否存在 |
| 被移出的人(同步移出 / 手动移出 / 移出网络) | **立刻整群不可读**:历史 404、收不到推送、打不开群里的附件。重新入群后整段历史又可见 | 默认值:「移出 = 看不到」最简单、最不会泄露;群历史属于群,不属于某个人 |
| 新入群的人能看到入群前的历史吗 | **能**(读权限只看「现在是不是成员」) | 部门群是部门的知识沉淀;不按人切历史也省一张表 |
| 去重 | 按 `(群, 发信人, client_request_id)` 定出同一个 `message_id`(sha256 取 32 位),`INSERT … ON CONFLICT(message_id) DO NOTHING`;重投返回原消息、`duplicate: true`、不再推送、不再记审计。**不按内容去重**:同一个人连发两条一样的话就是两条 | 照私信;内容哈希去重会吞掉用户真的重复发的消息(已知 bug 的教训) |
| 正文 / 附件上限 | 和私信相同:1 万字(`MAX_DM_CHARS`),附件 ≤ 20 个(`validateAttachments`),空正文且无附件 → 400 `message_required` | 照私信 |
| 频率限制 | **和私信一样不单独限流**(私信今天没有专门的限流,只有上传 60/小时) | 「与私信一致」;真要限流应该私信、群一起加,另开 |
| 推送 | 新事件 `group_message`,发给**发送那一刻**的每个群成员(现查 `chat_group_members`),**含发信人自己**(多端同步,App 按 `message_id` 去重),每人带自己的 `unread`。标已读推 `group_read {group_id, last_read_seq, unread}` 给自己(多端角标一起清) | 复用 `/events/users/me`;被同步移出的人自然不在收件人里 |
| `group_membership_changed`(入群 / 退群事件) | **推迟**到 app 那一步按需加 | 成员变化发生在调人 / 改部门的事务里,要在提交后推,得改 `departments.ts` 的四个写路径;app 现在可以在收到 `group_message` 或刷新会话列表时拿到最新群列表,不阻塞聊天 |
| 发消息时要不要先对账一次成员 | **不对账** | 第 2 个 PR 起每个写路径已同事务对账;每条消息都按整网算一次部门树不值得。`GET …/chat-groups/:gid` 的兜底对账仍在 |
| 附件可见性 | 私信文件(`?purpose=dm` 上传)和受限成员两条下载分支各加一个「或」:**当前**是某个群的成员、且那个群里有消息带着这个文件(`groupMemberSeesFile`)。不带 purpose 的网络文件对不受限成员本来就可见,不变 | 镜像私信「参与者可见」,收窄到「当前成员」;被移出立刻失效 |
| 附件转发 | 和私信同一条规矩:私信文件只能由看得见它的人发进群(上传者、带它的私信里的人、带它的群的当前成员);受限成员只能发自己能用的(自己传的 / 别人发给他的 / 他所在群里的) | 否则把别人私信里的 `file_id` 塞进群,就给全群解锁了它 |
| 私信转发群里看到的私信文件 | **不放开**(私信的转发判据不改) | 这个 PR 只动群;要放开另议 |

### 9.4 未读口径

`unread(我, 群) = 群里满足以下三条的消息数`:不是我发的;`created_at > 我的 joined_at`;`seq > 我的 last_read_seq`(没有已读行按 0)。

- 入群时间兜底:新入群的人不会一进来就几百条未读;重新入群 `joined_at` 刷新,离开期间的消息不算未读。
- `joined_at` 是秒级、`created_at` 是毫秒级的同格式 UTC 文本(SQLite / PG 一致),逐字比较即时间先后;入群那一秒里发的消息算未读(宁可多一条)。
- 一处定义(`UNREAD_SUBQUERY`),推送、群列表、`/api/dm/threads`、`read` 返回值都用它。

### 9.5 测试

`server/src/group-messages-http.test.ts`(SQLite 本地 + test2123 PG 梯子):发 / 历史 / 翻页 / 校验、`client_request_id` 去重、未读与已读只前进、
推送只到当前成员(含发信人、带各自未读、重投不推)、非成员 / 管理者 404、节点 403、被同步移出后历史 / 推送 / 附件全部失效、重新入群、
私信文件与受限成员的群附件可见性、不能借群解锁别人的私信文件、删网络连带清理。变异(逐条注入、跑、`cp` 还原、`cmp` 核对):
去掉文件可见性里的成员过滤、去掉消息接口的成员判断、去掉未读的入群时间条件、关掉 `client_request_id` 去重、去掉私信文件分支的群放行 —— 五条全部被测试抓到。


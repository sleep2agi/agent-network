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

群消息表(第 3 个 PR 加,同样只增):`chat_group_messages`(一条消息一行,不按人复制),每人已读位置记在
`chat_group_members` 新增的可空列 `last_read_at`(`ADD COLUMN`,不改旧列)。

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
推 `group_message` 到每个成员的 `/events/users/me`;入群 / 退群推 `group_membership_changed`。

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

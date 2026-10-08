# 多用户与权限

Hub 0.9.0-preview.68 起，服务器提供两样已经生效的能力：成员能访问哪些 Agent，以及同一网络里人与人的私聊接口。

用户管理、注册、私聊从 app 0.2.153 起。新注册或管理员新建的用户默认看不到任何 Agent，需要管理员在用户管理里授权。已有的账号、令牌和四个网络角色仍以 [账号、Token 与角色](/guide/account-system) 为准；命令行注册和邀请码没有因为这一页而取消。

## 成员能访问哪些 Agent

新加入的 member / viewer，`agent_access` 默认是 `granted`：还没被逐个授权之前，看不到这个网络里的 Agent。升级到这一版之前就已经在网络里的成员仍是 `all`，可见范围不因升级改变。owner、admin 和 Hub 管理员不受这道限制。

授权由该网络的 owner / admin，或 Hub 管理员，通过接口整体替换。授权表示能看见、能对话，不是能改这个 Agent 的配置、规则或日志。能看见一个 Agent，就能看到它完整的聊天记录：不同的人打开同一个节点，看到的消息是一样的——包括 owner 和其他成员发给它的消息，以及授权之前的历史。判定和字段见 [用户与 Agent 权限端点](/api/rest-admin#用户与-agent-权限端点)。

## 人与人私聊

同一网络里的两个用户可以用这些接口互发私聊，只接受用户令牌：

- `POST /api/dm`
- `GET /api/dm`
- `GET /api/dm/threads`

客户端从 app 0.2.153 起，可以在「人员」里和同一网络的人直接发消息。请求字段和错误见 [同一节](/api/rest-admin#human-dm)。

## 节点令牌不能管账号

从这一版起，节点令牌（`ntok_`）不能访问账号、令牌、网络和成员这些管理接口，返回 403 `user_token_required`。节点只能给自己改名：必须是它绑定的网络，旧名字就是这个令牌代表的节点。改别的节点需要用户令牌。相关接口在 API 文档里注明了「需要用户令牌」。

## 部门负责人

Hub 0.9.0-preview.91 起生效；app 从 0.2.196 起有「管理本部门」入口。

组织架构里每个部门可以设一个负责人。负责人管**本部门**：他负责的部门和它的全部下级部门。没有新角色，负责人身份每次请求都按部门的负责人字段现算。撤掉负责人，下一次请求就失去这些权限。viewer 当负责人不获得任何权限。

负责人能做的（只在本部门里）：

- 在本部门下建子部门；改名、移动、删除（只能删空部门）、换负责人。自己负责的那个部门归上一级负责人或管理员改。
- 在本部门的子部门之间调人。把人调进或调出本部门（包括「未分配」）只有管理员能做。
- 看、改、删本部门的任务卡。「本部门的卡」指负责人是本部门成员，或负责 Agent 的主人是本部门成员的卡。只凭负责人身份改卡时，卡只能交给本部门的人、负责人自己，或本部门成员的 Agent。只凭负责人身份删卡时，会记一条审计 `requirement_deleted_by_leader`，并私信卡的负责人；卡没有负责人时私信负责 Agent 的主人。
- 只读查看本部门成员的 Agent 的状态和健康。派活、对话仍按 Agent 授权，管理仍只给节点主人和管理员。

越出本部门的写操作返回 403 `department_scope_denied`。不是负责人的成员，返回与以前相同的 403 `owner/admin required`。

**怎么设负责人**：owner / admin 在 app「设置 → 用户管理 → 成员与部门」里选中部门，设负责人。人必须是本网络成员；设成 viewer 不会报错，但 viewer 不获得负责人权限。比如把 alice 设为「研发部」负责人，她就管「研发部」和下面的「前端组」「后端组」。负责人也可以给自己下级部门设负责人，人只能从本部门里选。把负责人清空或换人，原负责人的权限立即失效。

**在 app 里**：负责人会看到「管理本部门」。电脑端在侧栏「人员」上方，手机端在「设置」页最上面。点开是同一棵部门树，本部门之外的部门灰显。每个部门有成员、任务、Agent 三部分，Agent 只读。界面上只出现 Hub 允许的操作。不是负责人的成员看不到这个入口。

**部门项目授权**：owner / admin 可以把项目授权给部门，授权同时覆盖它的全部下级部门。和按人授权一样，有授权就能看，`can_edit` 为真才能改。

**和已有权限取并集**：负责人权限和部门项目授权只会多给，不会收回任何人已有的按人授权、任务范围或参与人权限。任务范围为「全部任务」的成员，以及 owner / admin，行为不变。节点令牌不经过部门判定。

相关接口：

| 接口 | 说明 |
|---|---|
| `GET /api/auth/me` | `networks[].managed_department_ids`：本部门的部门 id（含下级），空数组表示不是负责人 |
| `GET /api/networks/{id}/departments` | 每个部门多一个 `viewer_can: {manage, create_child}`；owner / admin 另外拿到 `project_grants` |
| `POST / PATCH / DELETE /api/networks/{id}/departments[/{dept}]`、`PUT /api/networks/{id}/members/{uid}/department` | owner / admin，或在本部门范围内的负责人 |
| `GET / PUT /api/networks/{id}/departments/{dept}/project-grants` | 部门项目授权，`PUT` 整体替换 `{project_grants: [{project_id, can_edit}]}`。只给 owner / admin；有一条项目不属于本网络，整批不写，返回 400 |
| `GET /api/networks/{id}/departments/{dept}/nodes` | 本部门（含下级）成员拥有的节点：别名、状态、健康、主人，只读。负责人或 owner / admin 可用 |
| `GET /api/requirements?department_id=` | 只要负责人在这个部门（含下级）、或负责 Agent 归这些人所有的卡；仍在调用者可见范围内。MCP `requirements_list` 同名参数 |

设计和取舍见 [RFC-040](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-040-department-head-permissions.md)。

## Agent 归部门

Agent（节点）也可以像人一样归一个部门，不归部门就是「未分配」。归部门只用于组织架构的展示，不给任何人新权限：谁能看、能对话哪个 Agent，仍按 Agent 授权。节点的 `team` 字段不受影响。

- 设置或清空：`PUT /api/networks/{id}/nodes/{node_id}/department`，请求体 `{"department_id": "<部门 id>"}`，传 `null` 表示未分配。
- 谁能改：owner / admin；或目标部门的负责人（含上级负责人），节点原来已在某个部门时，还要同时负责那个部门；清空时要负责节点当前的部门。其他人和节点令牌返回 403 `department_scope_denied`。
- 读：`GET /api/networks/{id}/departments` 多一个 `nodes` 数组，每项是 `{kind: "node", node_id, alias, display_name, department_id}`。人仍在 `members` 里，`member_count` 只数人。没有任何 Agent 归部门时不出现 `nodes`，响应与以前相同。只看授权 Agent 的成员只看到授权给他的那些。
- 删除部门：Agent 不阻止删除，部门删掉后，里面的 Agent 变回未分配。

## 节点自己的权限

节点（Agent）的权限是它**主人**权限的子集，再按节点自己的**模式**往下收。主人是令牌绑定节点的 `nodes.owner_user_id`；没绑定节点的老令牌，主人是铸令牌的人。

三种模式，默认「正常」，升级不改任何节点的行为：

| 模式 | 能做什么 |
|---|---|
| `normal` 正常 | 和今天一样；按 Hub 开关决定是否收紧到主人的权限（见下） |
| `readonly` 只读 | 能读、能上报状态、能回复派给它的任务；写任务、派活、广播、管理节点一律拒 |
| `restricted` 受限 | 只看、只改派给它的任务卡（负责 Agent 是它、参与人有它、它建的，及这些卡的子任务）；新建的卡必须把负责 Agent 设成自己；派活只能给主人被授权的 Agent；不能广播，不能订阅别的会话或整个网络的推送 |

**模式设了就立刻生效**，不看开关。只有节点主人、网络 owner / admin（和 Hub 管理员）能改，节点令牌不能改自己的模式，部门负责人也不能改：

```
PUT /api/nodes/{node_id}/permission-mode   {"mode": "normal" | "readonly" | "restricted"}
```

返回 `{ok, node_id, permission_mode, previous}`，记审计 `node_permission_mode_changed`。不是这个网络的成员返回 404；成员但不是主人或 owner / admin 返回 403 `permission_denied`；节点令牌返回 403 `user_token_required`；模式写错返回 400 `invalid_permission_mode`。`GET /api/nodes` 的每一行多一个 `permission_mode`,以及 `viewer_can.permission_mode`:当前调用者能不能改这个节点的模式(与上面的写接口同一判据,节点令牌恒为 `false`)。客户端据此决定显示不显示「权限」设置。支持这些的 Hub 在 `/health` 的 `capabilities` 里带 `node_permission_mode`。

**正常模式的收紧先记录、后执行**。Hub 环境变量 `COMMHUB_NODE_PERMISSIONS`：

| 值 | 行为 |
|---|---|
| `log`（默认） | 照常放行；「本来会被拒」的按 (节点, 路由, 原因, 小时) 合并记进 `node_permission_log` |
| `enforce` | 记录并拒绝 |
| `off` | 正常模式不判也不记（显式的只读 / 受限仍然生效） |

正常模式会被收紧的情况（原因码）：主人看不见或改不了的任务卡 `beyond_owner_visibility`、主人没被授权的 Agent `agent_not_granted_to_owner`、只有人能做的事 `human_only`（改别的节点、建 / 改项目、写供应商 / 网络密钥、审技能）、不知道主人是谁 `owner_unknown`。显式模式的原因码是 `mode_readonly` 和 `mode_restricted_not_assigned`。

被拒时 REST 返回 403，MCP 返回同样的正文：

```json
{"ok": false, "error": "node_permission_denied", "reason": "mode_readonly", "route": "PATCH /api/requirements/:id", "hint": "…"}
```

**报表**：网络 owner / admin（用户令牌）可以看过去一段时间每个节点「本来会被拦」的次数，默认 7 天：

```
GET /api/networks/{id}/node-permission-report?since=<ISO 时间>
```

返回 `{ok, network_id, since, mode, total, nodes: [{node_id, alias, permission_mode, total, by_reason, routes: [{route, reason, hits, sample, last_hour}]}]}`。`mode` 是当前开关。记录保留 30 天，最多 20000 行；满了以后只给已有的行加次数。

设计和取舍见 RFC-041。

## 相关

- [账号、Token 与角色](/guide/account-system)
- [REST：管理端点](/api/rest-admin)
- [REST API 参考](/api/rest)

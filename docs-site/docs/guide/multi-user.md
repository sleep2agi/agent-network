# 多用户与权限

Hub 0.9.0-preview.68 起，服务器提供两样已经生效的能力：成员能访问哪些 Agent，以及同一网络里人与人的私聊接口。

用户管理、注册、私聊从 app 0.2.153 起。新注册或管理员新建的用户默认看不到任何 Agent，需要管理员在用户管理里授权。已有的账号、令牌和四个网络角色仍以 [账号、Token 与角色](/guide/account-system) 为准；命令行注册和邀请码没有因为这一页而取消。

## 成员能访问哪些 Agent

新加入的 member / viewer，`agent_access` 默认是 `granted`：还没被逐个授权之前，看不到这个网络里的 Agent。升级到这一版之前就已经在网络里的成员仍是 `all`，可见范围不因升级改变。owner、admin 和 Hub 管理员不受这道限制。

授权由该网络的 owner / admin，或 Hub 管理员，通过接口整体替换。授权表示能看见、能对话，不是能改这个 Agent 的配置、规则或日志。判定和字段见 [用户与 Agent 权限端点](/api/rest-admin#用户与-agent-权限端点)。

## 人与人私聊

同一网络里的两个用户可以用这些接口互发私聊，只接受用户令牌：

- `POST /api/dm`
- `GET /api/dm`
- `GET /api/dm/threads`

客户端从 app 0.2.153 起，可以在「人员」里和同一网络的人直接发消息。请求字段和错误见 [同一节](/api/rest-admin#human-dm)。

## 节点令牌不能管账号

从这一版起，节点令牌（`ntok_`）不能访问账号、令牌、网络和成员这些管理接口，返回 403 `user_token_required`。节点只能给自己改名：必须是它绑定的网络，旧名字就是这个令牌代表的节点。改别的节点需要用户令牌。相关接口在 API 文档里注明了「需要用户令牌」。

## 部门负责人

组织架构里每个部门可以设一个负责人。负责人管**本部门**：他负责的部门和它的全部下级部门。没有新角色，负责人身份每次请求都按部门的负责人字段现算。撤掉负责人，下一次请求就失去这些权限。viewer 当负责人不获得任何权限。

负责人能做的（只在本部门里）：

- 在本部门下建子部门；改名、移动、删除（只能删空部门）、换负责人。自己负责的那个部门归上一级负责人或管理员改。
- 在本部门的子部门之间调人。把人调进或调出本部门（包括「未分配」）只有管理员能做。
- 看、改、删本部门的任务卡。「本部门的卡」指负责人是本部门成员，或负责 Agent 的主人是本部门成员的卡。只凭负责人身份改卡时，卡只能交给本部门的人、负责人自己，或本部门成员的 Agent。只凭负责人身份删卡时，会记一条审计 `requirement_deleted_by_leader`，并私信卡的负责人；卡没有负责人时私信负责 Agent 的主人。
- 只读查看本部门成员的 Agent 的状态和健康。派活、对话仍按 Agent 授权，管理仍只给节点主人和管理员。

越出本部门的写操作返回 403 `department_scope_denied`。不是负责人的成员，返回与以前相同的 403 `owner/admin required`。

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

设计和取舍见 RFC-040。

## 相关

- [账号、Token 与角色](/guide/account-system)
- [REST：管理端点](/api/rest-admin)
- [REST API 参考](/api/rest)

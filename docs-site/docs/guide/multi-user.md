# 多用户与权限

Hub 0.9.0-preview.68 起，服务器提供两样已经生效的能力：成员能访问哪些 Agent，以及同一网络里人与人的私聊接口。

桌面和手机上的用户管理、注册、私聊还没发，即将随 app 发布。不要把这三样当成客户端里已经能点的功能。已有的账号、令牌和四个网络角色仍以 [账号、Token 与角色](/guide/account-system) 为准；命令行注册和邀请码没有因为这一页而取消。

## 成员能访问哪些 Agent

新加入的 member / viewer，`agent_access` 默认是 `granted`：还没被逐个授权之前，看不到这个网络里的 Agent。升级到这一版之前就已经在网络里的成员仍是 `all`，可见范围不因升级改变。owner、admin 和 Hub 管理员不受这道限制。

授权由该网络的 owner / admin，或 Hub 管理员，通过接口整体替换。授权表示能看见、能对话，不是能改这个 Agent 的配置、规则或日志。判定和字段见 [用户与 Agent 权限端点](/api/rest-admin#用户与-agent-权限端点)。

## 人与人私聊

同一网络里的两个用户可以用这些接口互发私聊，只接受用户令牌：

- `POST /api/dm`
- `GET /api/dm`
- `GET /api/dm/threads`

客户端里还没有私聊界面。请求字段和错误见 [同一节](/api/rest-admin#human-dm)。

## 节点令牌不能管账号

从这一版起，节点令牌（`ntok_`）不能访问账号、令牌、网络和成员这些管理接口，返回 403 `user_token_required`。节点只能给自己改名：必须是它绑定的网络，旧名字就是这个令牌代表的节点。改别的节点需要用户令牌。相关接口在 API 文档里注明了「需要用户令牌」。

## 相关

- [账号、Token 与角色](/guide/account-system)
- [REST：管理端点](/api/rest-admin)
- [REST API 参考](/api/rest)

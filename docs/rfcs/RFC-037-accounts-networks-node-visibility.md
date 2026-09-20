# RFC: 多账号与按网络的节点可见性(账号 → 网络 → 节点)

- 状态:草案,等 Vincent 定稿(2026-09-15)
- 提出:通信龙,按 Vincent 2026-09-14「现在我只用了 admin 账号登录,能创建不同的账号吗?不同账号能访问的节点不同,这是大功能」;他已点头「按网络分组」方向。
- 范围:hub(commhub-server)、桌面端/手机端(agent-network-app)、CLI(anet)。不改节点运行时。

## 一句话

一个人 = 一个账号;账号加入若干**网络**;每个节点属于一个网络;账号只看得到、只能派活给自己网络里的节点;`admin` 全局可见。权限跟着组织结构走,不给每个节点单独配白名单。

## 现状盘点(2026-09-15,生产 hub .50 只读查得)

hub 里这套东西**已经存在一半以上**,不是从零做:

| 已有 | 在哪 | 备注 |
|---|---|---|
| 用户表 `users(user_id, username, role, plan, must_change_password…)`,25 个账号,`role ∈ {admin, user}` | hub DB | `admin` 之外的账号今天大多是测试账号 |
| 注册 / 登录 / 改密 / 个人资料 | `POST /api/auth/register` `login` `password`,`GET/PUT /api/auth/me` | **注册是开放的**(任何人 POST 即可建账号)——这是第一个要收口的点 |
| 网络 `networks(network_id, network_name, owner_id, visibility, max_members)` + 成员 `network_members(network_id, user_id, role)` + 邀请码 `network_invites` | `GET/POST /api/networks`,`POST /api/networks/join`(邀请码) | 25 个网络,成员关系已是权限的真实载体 |
| 用户 token(utok)/节点 token(ntok):ntok 绑定单个网络;utok 的可见范围 = `network_members` 里该用户的全部网络 | server.ts 1486–1502(「认证 ≠ 已授权」那一段) | `/api/status` 的会话列表已按成员网络过滤 |
| 节点归属 `nodes.network_id`(建节点时定)+ `nodes.owner_user_id` | hub DB | 节点本来就落在网络里 |
| 用户列表 `GET /api/users`(admin 限定) | server.ts 1371 | 只读 |

**缺的**(按用户能感知的顺序):
1. admin 在桌面端**建账号、给账号分网络、改角色/停用**的界面与 API(现在只能开放注册 + 邀请码自助加入)。
2. 桌面端/手机端的名册、聊天、任务列表在多网络账号下的**过滤与切换**(单网络账号已天然正确;多网络账号今天靠 token 自动并集)。
3. 建节点向导里**选网络**(daemon 建的节点要落在发起人有权限的网络里)。
4. 关掉开放注册(或改为「仅邀请码注册」),否则「不同账号看不到别人的节点」在安全上不成立。
5. 审计:谁建了谁、谁把谁加进了哪个网络(`logAudit` 已有,补齐这几种事件)。

## 设计

### 模型(不新增概念)
- 账号(`users`)——人。`role`:`admin`(全局)| `user`。新增 `disabled`(停用,不删)。
- 网络(`networks`)——组织单元(团队/项目/客户)。`network_members.role`:`owner | member`。
- 节点(`nodes.network_id`)——每个节点属于且仅属于一个网络;`owner_user_id` 记谁建的。
- 可见性规则(hub 单点执行,客户端只做展示):
  - `admin`:一切可见。
  - `user`:只看 `network_members` 里自己所在网络的节点/会话/任务/消息;派活、聊天、建节点同样受限;跨网络的 alias 对它「不存在」(404,不泄漏存在性)。
  - ntok:维持单网络绑定不变。

### API(hub)
| 动作 | 路由 | 谁能调 |
|---|---|---|
| 建账号 | `POST /api/admin/users {username, display_name, password?(留空则生成一次性密码, must_change_password=1), role}` | admin |
| 停用/启用、改角色 | `PATCH /api/admin/users/:id {disabled?, role?}` | admin |
| 网络成员增删 | `POST/DELETE /api/networks/:id/members {user_id, role}` | admin 或该网络 owner |
| 注册开关 | `settings.registration ∈ {open, invite_only, closed}`,默认改 `invite_only` | admin |
| 我的网络 | `GET /api/networks`(已有) | 本人 |
- 所有列表类接口(`/api/status`、`/api/nodes`、`/api/messages`、任务)已有 network 过滤的,复核一遍「utok 多网络并集」在每条路由都成立;没有的补(判据:非成员网络的 alias 返回 404)。
- 一次性密码只在创建响应里出现一次,不落审计正文。

### 桌面端 / 手机端
- 设置 → **账号与网络**(admin 可见):账号列表(建/停用/改角色)、网络列表(建网络、加成员、发邀请码)、节点归属查看(某网络下有哪些节点)。
- 顶栏网络切换器(账号属于 ≥2 个网络时才出现);名册/聊天/任务按当前网络过滤;「全部」视图给 admin。
- 建节点向导第一步选网络(默认当前网络);daemon 侧校验发起人是该网络成员。
- 登录页无变化;新账号首登强制改密。

### CLI(anet)
- `anet user create|disable|role`、`anet network add-member|remove-member`(admin/owner 令牌);给运维脚本用,不做 UI 的替代品。

### 分三步落地
1. **hub**:注册开关(默认 invite_only)+ admin 建账号/停用/改角色 + 网络成员增删 + 全路由 404 复核 + 审计事件;单测按「一个非成员账号对别人网络的每条路由都拿 404」写;发 commhub-server preview。
2. **桌面端/手机端**:「账号与网络」设置页 + 网络切换器 + 向导选网络;发 desktop 0.2.6x + APK。
3. **CLI + 文档**:anet 子命令、docs-site「多账号与网络」指南、迁移说明(现有 25 个网络/账号不动,只是从此有了管理入口)。

### 不做 / 边界
- 不做节点级白名单(网络粒度够用;真要细分就再建一个网络)。
- 不做跨 hub 的账号同步;一个 hub 一套账号。
- 外部团队的节点与网络不动;上线前先在 DEV 的一个新网络里用两个测试账号走完整流程(admin 建账号 → 分网络 → 该账号只看到该网络的节点 → 派活 → 回复 → 换网络看不见)。

### 验收(真机、可复核)
- 用 `u2`(已有测试账号)登录桌面端:名册只含其网络的节点;对别的 alias `send_task` 得 404。
- admin 新建账号 `demo-a`,分到网络 A;`demo-a` 首登强制改密;只看到 A 的节点;admin 把它加进 B 后,切换器出现 B。
- 开放注册关掉后,匿名 `POST /api/auth/register` 返回 403。

### 需要 Vincent 定的三件事
1. 注册默认改 `invite_only` 还是 `closed`(只有 admin 能建)?—— 建议 `closed`。
2. 网络 `owner` 能不能自己加成员(还是只有 admin)?—— 建议能,便于各团队负责人自管。
3. 先发 hub 还是先做桌面端?—— 建议 hub 先(客户端没有它什么都做不了),两周内 hub + 桌面端一起可用。

# RFC-038: 节点权限 —— 账号能看见 / 能对话哪些节点(补齐与收口)

- 状态:草案,等 Vincent 定稿(2026-09-30)
- 提出:通信龙。需求原话(Vincent):「我可以用不同的账号去登录到这个军团里面,然后 admin 它可以设置不同账号去访问不同的一个节点的一个权限,就可以限制它能够与多少个节点进行对话,它可以去进行配置。」
- 前置:[RFC-037](RFC-037-accounts-networks-node-visibility.md)(账号 → 网络 → 节点)。本 RFC 在它之上加「网络内按成员、按节点」这一层。
- 范围:hub(commhub-server)、agent-network-app(桌面端 / 手机端)。不改节点运行时、不改 CLI。

## 0. 结论先行

这件事的**主体已经上线**,不是从零设计:

- hub:#2084(slice 1)与 #2086(slice 3)已合入 main,实现「每个成员 × 每个节点」的授权表 + 全路由 fail-closed 执行。
- app:agent-network-app#514(slice 2:设置 → 用户管理、新建用户、「可访问的 Agent」勾选、受限空态、人员私信)已合入,随桌面端 0.2.153 发出。

所以本 RFC 做三件事:(1) 把**今天**非管理员到底能做什么按代码钉死;(2) 指出读代码发现的缺口 —— 其中两条会让管理员以为已经限制了、其实没限制;(3) 把剩下的工作拆成 4 个可以单独发版的小步。

## 1. 今天的模型(以 origin/main 代码为准)

### 1.1 角色

| 层 | 值 | 定义处 |
|---|---|---|
| Hub 全局 | `users.role`:`admin` / `user` | `server/src/auth.ts`;`isHubAdmin()` 在 `server/src/agent-access.ts` |
| 网络内 | `network_members.role`:`owner` / `admin` / `member` / `viewer` | `auth.ts` 的 `MEMBER_ROLES`、`addNetworkMember()`、`updateMemberRole()` |
| 网络内 Agent 范围 | `network_members.agent_access`:`all` / `granted` | `server/src/db.ts`(`ALTER … DEFAULT 'all'`) |
| 逐节点授权 | `network_member_agent_grants(network_id, user_id, node_id \| alias, can_message, created_by, created_at)` | `db.ts`;读写全在 `agent-access.ts` |

**受限成员**(restricted member)的唯一判据是 `agent-access.ts` 的 `isAgentRestricted()` / `restrictedRow()`:网络角色为 `member`/`viewer`、`agent_access` 不是字面 `'all'`、且不是 Hub 管理员。它是 fail-closed 的:未知角色、未知取值一律按受限处理。

### 1.2 实际的权限级别

目前一个受限成员对某个节点只有三档:

| 档 | 数据 | 能做什么 |
|---|---|---|
| 不可见 | 没有授权行 | 列表里没有这个节点;按 alias 派活返回的 403 和「节点不存在」**逐字节相同**(不能拿它探测 alias) |
| 只读(view) | 授权行 `can_message=0` | 能在名册里看见状态,不能派活 / 发消息 |
| 可对话(talk) | 授权行 `can_message=1` | 能看见、能派活 / 发消息;任务与消息**只看自己和它之间的往来** |

「管理节点」(规则文件、技能、工作目录文件、运行日志、配置、启停)**对受限成员一律拒绝,不管有没有授权**。#2086 把这一条作为明确决定写进了代码和测试:「能和 X 聊」不等于「能管 X」。

### 1.3 升级时的默认值(向后兼容)

- 升级**之前**就存在的成员行:列的 `DEFAULT 'all'` 让它们全部落在 `all`,**可见范围不因升级而变**(`db.ts` 该列上方的注释写明了这一点)。
- 升级**之后**新加入的 member/viewer(管理员建号 `adminCreateUser()`、`POST /api/networks/:id/members`、邀请码 `joinByInvite()`):一律 `granted`,也就是**默认零节点**。
- owner / admin 角色、Hub 管理员:永远看见全部。

## 2. 今天非管理员能做什么(证据)

下表的每一格都对应一条读过的代码路径。「受限」指 `agent_access='granted'` 的 member/viewer。

| # | 面 | 受限成员今天的行为 | 执行点 |
|---|---|---|---|
| 1 | 升级前已有的 member | 仍是 `all`:能看见、能联系网络里所有节点 | `db.ts` 的 `ALTER … DEFAULT 'all'` |
| 2 | 名册 `GET /api/status`、`GET /api/nodes`、MCP `get_all_status` / `get_session_status` | 只返回授权的节点;没有授权时返回 0 行 | `network-scope.ts` 的 `addAgentNetworkScope()` |
| 3 | 派活 `POST /api/task` | 只能发给 `can_message` 的节点,其余一律 403 `agent_not_granted`;`from` 固定为本人用户名;附件只能用自己看得见的文件 | `server.ts` 的 `/api/task` 分支,用到 `canMessageAgent()`、`restrictedMemberAttachmentsDenied()` |
| 4 | MCP `send_task` / `send_message` | 同 #3;不在 `RESTRICTED_MEMBER_TOOLS` 白名单里的工具,在受限网络里一律 `agent_access_restricted` | `tools.ts`(`canMessageAgent` + 白名单判断),白名单在 `agent-access.ts` |
| 5 | 任务、消息、事件 `GET /api/tasks`、`/api/messages`(alias 分支)、`/api/task_events` | 只看自己和授权节点之间的往来,**看不到** owner 发给同一节点的任务 | `network-scope.ts` 的 `addOwnTrafficScope()` |
| 6 | SSE | 即使有授权,`/events/<节点 alias>` 也返回 403(这条流里有所有人发给该节点的任务);网络观察流只推 `from`/`to` 是自己的事件;`/events/users/me` 照常 | `server.ts` 的 SSE 鉴权(`isAgentRestricted()`) |
| 7 | 文件 | 只能下载自己上传的文件,以及对方发给自己的文件;不能转发看不见的 file id | `server/src/restricted-files.ts` |
| 8 | 计划任务 | 列表为空、不能新建;受限之前建的计划任务,到点派发时按创建者重新判定,失败记 `creator_access_revoked` | `server/src/scheduled-tasks.ts` |
| 9 | 需求看板 | 可以用;没授权给他的节点在 `agent_owner` / 参与人里被隐去,也不能被他改动(`agent_owner_not_granted`) | `server/src/requirements.ts` |
| 10 | 凭据与人 | 在受限网络里不能持有网络令牌(ntok),`resolveToken()` 解析时就拒绝;可以通过 `/api/dm` 给网络里任何人发私信 | `auth.ts` 的 `resolveToken()`、`server/src/human-dm.ts` |

这些行为有两份测试覆盖,都起真实的 `Bun.serve`,用临时库:`server/src/agent-acl-http.test.ts` 和 `server/src/agent-acl-slice3-http.test.ts`。节点令牌提权的回归测试在 `server/src/node-token-privilege-http.test.ts`。

app 侧的流程如下:
- 名册来自 `/api/status` 和 `/api/nodes`,派活走 `POST /api/task`(`src/api.ts` 的 `sendTask`),所以上面 hub 的过滤直接决定 app 里看到什么。
- 授权 UI 在 `src/UserManagementPanel.tsx` 和 `src/user-admin.ts`。
- 调用的接口集中在 `src/user-admin-api.ts`。

## 3. 缺口(读代码发现的,按严重程度排)

**G1 —— 在 app 里限制「老成员」是静默无效的(最严重)。**

对老成员(`agent_access='all'`)点「可访问的 Agent」,勾选并保存后,**什么也不会被限制**。代码上是这样走的:
1. `UserManagementPanel.tsx` 能不能打开编辑,只看角色(`grantsEditable()` 只排除 owner/admin),所以老成员也能打开。
2. 保存时的 body 由 `grantsPayload()` 生成,**只有 `grants`,没有 `agent_access`**。
3. hub 侧 `replaceAgentGrants()` 只在 `agentAccess !== undefined` 时才改模式。

结果是授权行写进去了,成员仍然是 `all`,`isAgentRestricted()` 为 false。行上的摘要继续显示「全部 Agent」—— 这本身是对的,但管理员没有任何办法把他切成「仅指定」。换句话说,**今天在 app 里,升级前加入的成员限制不了**。

**G2 —— viewer 的「可对话」开关不起作用。**

受限的 viewer 即使有 `can_message=1` 的授权,派活也会 403 `permission_denied`。原因是 `/api/task` 分支先检查 `canRestWriteNetworkAsHuman()`,而这个函数对 viewer 恒为 false。但 app 的授权对话框照样对 viewer 显示「可对话」开关,而且默认是打开的。

**G3 —— 在 app 里改不了角色,也移不出成员。** hub 早有 `PUT/DELETE /api/networks/:id/members/:uid`,并且都写了审计(`member_role_changed` / `member_removed`),但 app 没有入口。

**G4 —— 网络负责人看不到权限变更记录。**
- hub 已经写审计:`member_agent_grants_changed`(带 `network_id`)、`member_added`、`admin_user_created`。
- 但 `GET /api/audit-log` 对非 Hub 管理员只返回**本人**做过的操作,所以网络 owner/admin 看不到本网络里别的管理员改了谁的权限。
- 另外,被拒的派活(`agent_not_granted`)不写审计。

**G5 —— 没有「管理」级别。**
- 今天就算给了授权,受限成员也管不了节点(见 §1.2)。
- 如果要做「让某个成员能改某个节点的规则或配置」,需要新增一个授权位。#2086 已经预留了 `can_manage` 这个名字。

**G6 —— app 里不能切换网络。**
- 这是 app#514 自己列出的已知限制:给别的网络的用户分配 Agent,得先切到那个网络才行。
- 如果一个账号属于两个以上网络,名册里显示的是 hub 算出来的并集。

不在本 RFC 范围内:开放注册(RFC-037 待定第 1 条)。注册只会得到一个自己的个人网络,拿不到别人网络里的任何节点,所以它不影响本 RFC 的隔离性。

## 4. 设计

### 4.1 模型:不加新概念,只补一位

- 保留「成员 × 节点」授权表(按 node_id,改名不丢权限)。**不做节点组**:需要成批管的时候,另建一个网络(RFC-037 的边界)。app 里再给一个「从某成员复制授权」的快捷操作,就够用了。
- 权限级别定为 **view ⊂ talk ⊂ manage**。前两档已经上线。`manage` 新增一列 `can_manage INTEGER NOT NULL DEFAULT 0`,只在第 4 步做,而且要等 Vincent 拍板(§7)。
- 角色语义定死(让 G2 不再是陷阱):
  - `viewer` 永远只能到 view 这一档,没有例外;
  - hub 在 PUT 授权时把 viewer 的 `can_message` 强制写成 0,并在响应里带 `normalized: ["viewer_cannot_message"]`;
  - app 对 viewer 不显示「可对话」开关。

### 4.2 执行点

执行点**不新增**,继续用 §2 表里那几个,规则只有一条:**一律在 hub 判定,客户端只负责展示**。manage 位上线之后,只有下面这些拒绝点改成「`can_manage=1` 时放行」,其余不动:
- 规则文件、技能、工作目录文件、日志、配置、启停;
- 以及 `/events/<alias>` —— 这条流带着别人的任务,即使有 manage 也继续拒绝。

新写的判定函数只有一个:`agent-access.ts` 里的 `canManageAgent()`,和 `canSeeAgent()` / `canMessageAgent()` 放在同一处。

### 4.3 升级默认值

- 继续保持「升级前已有的成员 = `all`」,**不做**任何会收窄现有访问的迁移。
- 真要限制老成员,只能由管理员在 UI 上显式切到「仅指定 Agent」(修 G1)。切换时预填成员当前可见的全部节点,这样不会一保存就把人清成零节点。

### 4.4 审计

- 读:`GET /api/audit-log?network_id=<id>`。本网络的 owner/admin 可以读 `network_id = <id>`,或者 `target_type='network' AND target_id=<id>` 的行;Hub 管理员不受限制。现有「非管理员只能看自己」的分支保持不变。
- 写:`member_added`、`member_role_changed`、`member_removed` 调用 `logAudit()` 时补上 `networkId` 参数(今天只写在 `target_id` 里)。
- 被拒绝的访问:新增 `agent_access_denied` 审计(字段 user、目标 node_id、路由),**同一 (用户, 节点) 每小时最多记一条**,防止刷爆审计表。

### 4.5 管理 UI(桌面端和手机端分开设计)

入口不变,都在「设置 → 用户管理」。只补下面四样,不新增页面:

| 控件 | 桌面端(≥ 1200 宽,设置右栏 + 居中对话框 460 宽) | 手机端(390 宽,WeChat 式子页面) |
|---|---|---|
| 访问范围切换(G1) | 在「可访问的 Agent」对话框顶部放一个分段控件:「全部 Agent / 仅指定 Agent」。选「全部」时下面的清单置灰 | 放在子页面第一组,单选两行,选中的一行打勾;选「仅指定」后才展开节点清单 |
| 可对话开关(G2) | 成员是 viewer 时不渲染开关,行尾显示「只读」 | 同左 |
| 改角色 / 移出(G3) | 在成员行上 hover 时出现「⋯」,菜单里是「改为成员 / 只读成员 / 管理员」和「移出网络」(红色,需二次确认) | 成员子页面底部放两行:「角色」(push 选择页)和「移出网络」(红字,底部弹出确认) |
| 权限记录(G4) | 右栏在成员列表下面加一个「最近权限变更」折叠区,展示 20 条 | 「用户管理」页最下面加一行「权限变更记录」,push 进列表页 |

交付时,两种尺寸各截图一张并附测量表(居中、边距、行高),沿用 app#514 的做法。

## 5. 测试计划(正反两个方向都要测)

全部用临时 hub 跑:`HOME=$(mktemp -d)`,端口避开 9200,临时库。hub 测试沿用 `agent-acl-*-http.test.ts` 的写法。

| 步 | 允许方向(必须能用) | 拒绝方向(必须 403,或者在列表里不出现) |
|---|---|---|
| 1 | 老成员 `all` 切到 granted 并预填 N 个节点:名册里恰好是这 N 个,对它们派活 200 | 切换之后,对名单外的节点派活返回 403 `agent_not_granted`,和不存在的 alias 返回逐字节相同;在切换之前,只写授权不改模式的请求,应保持 `restricted:false`(守住「不会误收窄」) |
| 1 | viewer 带授权:名册里看得见 | viewer 派活返回 403;PUT 授权时,`can_message:true` 被规整成 false |
| 1 | owner 改角色 / 移出成员,返回 200,审计里有记录 | 网络 admin 改 owner 返回 403;被移出的成员马上看不到任何节点,观察流也被断开 |
| 2 | owner 用 `?network_id=` 能读到本网络的审计 | 普通 member 带 `?network_id=` 只能拿到自己那几行;别的网络的 owner 拿到 0 行 |
| 2 | 被拒绝的派活写 1 条 `agent_access_denied` | 一小时内同一对 (用户, 节点) 重复被拒,不会多写 |
| 4 | `can_manage=1`:该节点的规则、日志、配置返回 200 | `can_manage=0` 返回 403;有 manage 但请求别的节点也返回 403;`/events/<alias>` 始终 403 |

每一步都要做一次变异见证:把新加的判定删掉,至少一条拒绝方向的测试必须变红。app 侧用 ck 单测覆盖 payload 形状,比如切到 granted 时 body 里要带 `agent_access`;再用 Playwright 连真实的临时 hub 跑一遍 E2E。

## 6. 分步发布(每一步都能单独发版)

1. **app:修 G1 / G2 / G3,hub 不动。**
   - 分段控件保存时带上 `agent_access`,切到「仅指定」时预填当前可见的节点。
   - viewer 不显示「可对话」开关。
   - 加上改角色、移出成员。
   - 对现在生产上的 hub(.68,依据是 09-30 的升级记录)就能直接用。发一个桌面端小版本加 APK。
2. **hub:审计可读 + 被拒访问的审计 + viewer 规整;app:「权限变更记录」。**
   - 发 commhub-server 的一个 preview。
   - 生产环境升级前,先拿当前 app 对新 hub 跑一遍(新 hub 只加字段,不改任何现有响应的形状)。
3. **app:网络切换器(修 G6)。**
   - 账号属于 2 个及以上网络时,顶栏才出现切换器。
   - 用户管理页、名册、聊天都跟着当前网络走。
4. **hub + app:`can_manage`(G5),要 Vincent 先定。** 加一列、`canManageAgent()`、放开 §4.2 列的那几个点,再在授权对话框里加第三档「可管理」。

## 7. 需要 Vincent 定的

1. 要不要做「管理」这一档(第 4 步)?建议**先不做**,等真有成员需要改别人节点的规则时再上。前三步不依赖它。
2. 老成员要不要统一收窄?建议**不收**。保持 `all`,由管理员逐个切换(§4.3)。

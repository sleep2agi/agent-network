# RFC-038: 节点权限 —— 账号能看见 / 能对话哪些节点(补齐与收口)

- 状态:草案,等 Vincent 定稿(2026-09-30)
- 提出:通信龙。需求原话(Vincent):「我可以用不同的账号去登录到这个军团里面,然后 admin 它可以设置不同账号去访问不同的一个节点的一个权限,就可以限制它能够与多少个节点进行对话,它可以去进行配置。」
- 前置:[RFC-037](RFC-037-accounts-networks-node-visibility.md)(账号 → 网络 → 节点)。本 RFC 在它之上加「网络内按成员、按节点」这一层。
- 范围:hub(commhub-server)、agent-network-app(桌面端 / 手机端)。不改节点运行时、不改 CLI。

## 0. 结论先行

这件事的**主体已经上线**,不是从零设计:

- hub:#2084(slice 1)与 #2086(slice 3)已合入 main,实现「每个成员 × 每个节点」的授权表 + 全路由 fail-closed 执行。
- app:agent-network-app#514(slice 2:设置 → 用户管理、新建用户、「可访问的 Agent」勾选、受限空态、人员私信)已合入,随桌面端 0.2.153 发出。

两个 hub PR 的合并提交(`8cbb138e`、`82417286`)都是 `commhub-server 0.9.0-preview.68` 的祖先:`git merge-base --is-ancestor` 对准备提交 `24efda45` 和实际发版的 run 所在提交 `753f5ed4` 都返回 0。npm 上的 `.68` 包里也确实有 `src/agent-access.ts` 和 `network_member_agent_grants`。生产 hub 跑的是不是 `.68`,以部署机为准,本 RFC 没有去验证。

所以本 RFC 做三件事:(1) 把**今天**非管理员到底能做什么按代码钉死;(2) 指出读代码发现的缺口 —— 其中两条会让管理员以为已经限制了、其实没限制;(3) 把剩下的工作拆成 4 个可以单独发版的小步。

## 0.1 管理员今天就能这样做

前提:你是 Hub 管理员(`users.role=admin`),或者是当前网络的 owner/admin。其他人看不到「用户管理」这个入口(规则见 app 的 `canManageUsers()`)。

**桌面端(0.2.153 起)**
1. 设置 → 左栏「用户管理」→「新建用户」。填用户名、密码(至少 8 位)、网络、角色(成员 / 只读成员 / 管理员),然后点「创建」。新用户默认看不到任何 Agent。
2. 在成员列表里点这个人 →「可访问的 Agent」。勾选节点;每个勾选的节点都有一个「可对话」开关,关掉就是只读。点「保存」。
3. 成员行右侧会显示「N 个 Agent」。对方登录后,名册里只有这 N 个节点;给别的节点派活会得到 403。

**手机端(同一版本的 APK)**
设置 →「通用」组第一行「用户管理」→ 进入子页面,后面三步与桌面端相同。两个对话框在手机上是居中的 358 宽卡片。

**等价 API**(都要用户令牌 utok;网络令牌 ntok 会被拒):

```bash
# 1. 建账号并加入网络(默认 agent_access=granted,即零节点)
curl -X POST "$HUB/api/admin/users" -H "Authorization: Bearer $ADMIN_UTOK" \
  -d '{"username":"<user>","password":"<pw>","network_id":"<net>","role":"member"}'
# 2. 授权两个节点:一个可对话,一个只读(整体替换)
curl -X PUT "$HUB/api/networks/<net>/members/<user_id>/agent-grants" -H "Authorization: Bearer $ADMIN_UTOK" \
  -d '{"agent_access":"granted","grants":[{"node_id":"<node-a>","can_message":true},{"node_id":"<node-b>","can_message":false}]}'
# 3. 核对
curl "$HUB/api/networks/<net>/members/<user_id>/agent-grants" -H "Authorization: Bearer $ADMIN_UTOK"
```

⚠️ 上面的做法只对**新建**的成员有效。升级前就在网络里的成员,在 app 里勾选节点并保存后**不会被限制**(见 G1)。在第 1 步发版之前,要限制这类成员只能用 API,并且在请求里显式带上 `"agent_access":"granted"`。

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
| 只读(view) | 授权行 `can_message=0` | 能在名册里看见状态、看见它的**整条任务时间线**(谁发的都算,含授权前的历史,#563);不能派活 / 发消息 |
| 可对话(talk) | 授权行 `can_message=1` | 能看见、能派活 / 发消息;任务时间线与「只读」档相同(见 §2 #5,#563) |

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
| 5 | 任务与事件 `GET /api/tasks`、`/api/tasks/:id`、`/api/task_events`、MCP `list_tasks` / `get_task`、网络详情的任务计数 | **#563 起**:看得见节点 N(直接或经组授权)就看得见 N 的整条时间线 —— 谁发的都算(包括 owner、其他成员),也包括授权之前的历史;与 owner 打开同一个节点看到的一样。时间线另一端是**看不见的** Agent 的行仍隐藏(不借此暴露看不见的节点)。没有授权的成员仍什么都看不到 | `network-scope.ts` 的 `addAgentTimelineScope()` |
| 5b | 投递队列 `/api/messages`(alias 分支) | 仍只看自己和授权节点之间的往来(inbox 是投递队列,不是聊天历史) | `network-scope.ts` 的 `addOwnTrafficScope()` |
| 6 | SSE | 即使有授权,`/events/<节点 alias>` 也返回 403(这条流里有所有人发给该节点的任务);网络观察流推 `from`/`to` 是自己的事件,以及授权节点时间线上的事件(#563,判据同 #5:另一端是看不见的 Agent 的不推);`/events/users/me` 照常 | `server.ts` 的 SSE 鉴权(`isAgentRestricted()`) |
| 7 | 文件 | 只能下载自己上传的文件、对方发给自己的文件,以及授权节点时间线上**别人**发出的附件和节点回复的附件(#563,否则共享历史里的图打不开);不能转发看不见的 file id | `server/src/restricted-files.ts` |
| 8 | 计划任务 | 列表为空、不能新建;受限之前建的计划任务,到点派发时按创建者重新判定,失败记 `creator_access_revoked` | `server/src/scheduled-tasks.ts` |
| 9 | 需求看板 | 可以用;没授权给他的节点在 `agent_owner` / 参与人里被隐去,也不能被他改动(`agent_owner_not_granted`) | `server/src/requirements.ts` |
| 10 | 凭据与人 | 在受限网络里不能持有网络令牌(ntok),`resolveToken()` 解析时就拒绝;可以通过 `/api/dm` 给网络里任何人发私信 | `auth.ts` 的 `resolveToken()`、`server/src/human-dm.ts` |

这些行为有两份测试覆盖,都起真实的 `Bun.serve`,用临时库:`server/src/agent-acl-http.test.ts` 和 `server/src/agent-acl-slice3-http.test.ts`。节点令牌提权的回归测试在 `server/src/node-token-privilege-http.test.ts`。

app 侧的流程如下:
- 名册来自 `/api/status` 和 `/api/nodes`,派活走 `POST /api/task`(`src/api.ts` 的 `sendTask`),所以上面 hub 的过滤直接决定 app 里看到什么。
- 授权 UI 在 `src/UserManagementPanel.tsx` 和 `src/user-admin.ts`。
- 调用的接口集中在 `src/user-admin-api.ts`。

## 3. 缺口(按对用户的价值排序;G1 正对应 Vincent 原话「限制它能与哪些节点对话」)

**G1 —— 在 app 里限制「老成员」是静默无效的(最严重)。**

对老成员(`agent_access='all'`)点「可访问的 Agent」,勾选并保存后,**什么也不会被限制**。代码上是这样走的:
1. `UserManagementPanel.tsx` 能不能打开编辑,只看角色(`grantsEditable()` 只排除 owner/admin),所以老成员也能打开。
2. 保存时的 body 由 `grantsPayload()` 生成,**只有 `grants`,没有 `agent_access`**。
3. hub 侧 `replaceAgentGrants()` 只在 `agentAccess !== undefined` 时才改模式。

结果是授权行写进去了,成员仍然是 `all`,`isAgentRestricted()` 为 false。行上的摘要继续显示「全部 Agent」—— 这本身是对的,但管理员没有任何办法把他切成「仅指定」。换句话说,**今天在 app 里,升级前加入的成员限制不了**。

**G2 —— viewer 的「可对话」开关不起作用。**

受限的 viewer 即使有 `can_message=1` 的授权,派活也会 403 `permission_denied`。原因是 `/api/task` 分支先检查 `canRestWriteNetworkAsHuman()`,而这个函数对 viewer 恒为 false。但 app 的授权对话框照样对 viewer 显示「可对话」开关,而且默认是打开的。

**G3 —— 在 app 里改不了角色,也移不出成员。** hub 早有 `PUT/DELETE /api/networks/:id/members/:uid`,并且都写了审计(`member_role_changed` / `member_removed`),但 app 没有入口。

**G4 —— app 里不能切换网络。**
- 这是 app#514 自己列出的已知限制:给别的网络的用户分配 Agent,得先切到那个网络才行。
- 如果一个账号属于两个以上网络,名册里显示的是 hub 算出来的并集。

**G5 —— 网络负责人看不到权限变更记录。**
- hub 已经写审计:`member_agent_grants_changed`(带 `network_id`)、`member_added`、`admin_user_created`。
- 但 `GET /api/audit-log` 对非 Hub 管理员只返回**本人**做过的操作,所以网络 owner/admin 看不到本网络里别的管理员改了谁的权限。
- 另外,被拒的派活(`agent_not_granted`)不写审计。

**G6 —— 没有「管理」级别。**
- 今天就算给了授权,受限成员也管不了节点(见 §1.2)。
- 如果要做「让某个成员能改某个节点的规则或配置」,需要新增一个授权位。#2086 已经预留了 `can_manage` 这个名字。

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
| 权限记录(G5) | 右栏在成员列表下面加一个「最近权限变更」折叠区,展示 20 条 | 「用户管理」页最下面加一行「权限变更记录」,push 进列表页 |

交付时,两种尺寸各截图一张并附测量表(居中、边距、行高),沿用 app#514 的做法。

## 5. 测试计划(正反两个方向都要测)

全部用临时 hub 跑:`HOME=$(mktemp -d)`,端口避开 9200,临时库。hub 测试沿用 `agent-acl-*-http.test.ts` 的写法。

| 步 | 允许方向(必须能用) | 拒绝方向(必须 403,或者在列表里不出现) |
|---|---|---|
| 1 | 老成员 `all` 切到 granted 并预填 N 个节点:名册里恰好是这 N 个,对它们派活 200 | 切换之后,对名单外的节点派活返回 403 `agent_not_granted`,和不存在的 alias 返回逐字节相同;在切换之前,只写授权不改模式的请求,应保持 `restricted:false`(守住「不会误收窄」) |
| 1 | viewer 带授权:名册里看得见;授权对话框对 viewer 不显示「可对话」 | viewer 派活返回 403(hub 现状,app 不再给出误导的开关) |
| 1 | owner 改角色 / 移出成员,返回 200,审计里有记录 | 网络 admin 改 owner 返回 403;被移出的成员马上看不到任何节点,观察流也被断开 |
| 2 | 属于两个网络的账号切到网络 B:名册 / 用户管理只剩 B 的节点与成员 | 切到 B 后,A 的节点不出现、也无法从 B 的会话里派给 A 的节点 |
| 3 | owner 用 `?network_id=` 能读到本网络的审计 | 普通 member 带 `?network_id=` 只能拿到自己那几行;别的网络的 owner 拿到 0 行 |
| 3 | viewer PUT 授权时 `can_message:true` 被规整成 false | — |
| 3 | 被拒绝的派活写 1 条 `agent_access_denied` | 一小时内同一对 (用户, 节点) 重复被拒,不会多写 |
| 4 | `can_manage=1`:该节点的规则、日志、配置返回 200 | `can_manage=0` 返回 403;有 manage 但请求别的节点也返回 403;`/events/<alias>` 始终 403 |

每一步都要做一次变异见证:把新加的判定删掉,至少一条拒绝方向的测试必须变红。app 侧用 ck 单测覆盖 payload 形状,比如切到 granted 时 body 里要带 `agent_access`;再用 Playwright 连真实的临时 hub 跑一遍 E2E。

## 6. 分步发布(每一步都能单独发版,按用户价值排)

1. **app:修 G1 / G2 / G3,hub 不动,一天内可发。** 直接对应 Vincent 原话。
   - 「可访问的 Agent」加「全部 Agent / 仅指定 Agent」切换,保存时带上 `agent_access`;从「全部」切到「仅指定」时预填当前可见的节点。
   - viewer 不显示「可对话」开关,授权一律按只读保存。
   - 加上改角色、移出成员(hub 已有接口)。
   - `.68` 包已含所需接口(§0 的祖先校验)。发一个桌面端小版本加 APK。
2. **app:网络切换器(修 G4)。** 账号属于 2 个及以上网络时,顶栏才出现切换器;用户管理页、名册、聊天都跟着当前网络走。
3. **hub + app:审计(修 G5)+ viewer 规整。**
   - 网络 owner/admin 可读本网络审计、`member_*` 写入 `network_id`、限频的 `agent_access_denied`;hub 侧把 viewer 的 `can_message` 规整为 0;app 加「权限变更记录」。
   - 发 commhub-server 的一个 preview;生产升级前,先拿当前 app 对新 hub 跑一遍(只加字段,不改现有响应形状)。
4. **hub + app:`can_manage`(G6),要 Vincent 先定。** 加一列、`canManageAgent()`、放开 §4.2 列的那几个点,再在授权对话框里加第三档「可管理」。

## 7. 需要 Vincent 定的

1. 要不要做「管理」这一档(第 4 步)?建议**先不做**,等真有成员需要改别人节点的规则时再上。前三步不依赖它。
2. 老成员要不要统一收窄?建议**不收**。保持 `all`,由管理员逐个切换(§4.3)。

## 8. 附:真正的 Agent 分组(需求 ②,2026-09-30 追加)

Vincent 原话:「可以访问的 agent 的时候…可以设置为全部或者是分组…而不是一个一个去选，支持多种选择方式」。

- **已做的(①,纯 app,agent-network-app#548)**:授权选择器里加了「按机器 / 按类型 / 全选搜索结果 / 清空」。这些都是**一次性**的批量勾选,最后仍然存成逐个节点的授权,**以后新建的 Agent 不会自动加入**;界面上写明了这一点。
- **本节设计的(②,hub + app)**:真正的分组。授权可以直接给到一个组;组里加进新 Agent,被授权的成员**立刻**就能访问,不用再去勾一遍。

### 8.1 模型

组是管理员自由定义的:组名随便起,成员随便放。**不做**按机器、按类型的规则组,理由见 §8.6。

```sql
CREATE TABLE agent_groups (
  group_id    TEXT PRIMARY KEY,           -- agrp_<uuid>
  network_id  TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  created_by  TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT,
  UNIQUE (network_id, name)
);
CREATE TABLE agent_group_members (          -- 按 node_id(稳定,改名不丢)
  group_id  TEXT NOT NULL, node_id TEXT NOT NULL,
  added_by  TEXT, added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (group_id, node_id)
);
CREATE TABLE network_member_group_grants (  -- 成员 × 组
  network_id TEXT NOT NULL, user_id TEXT NOT NULL, group_id TEXT NOT NULL,
  can_message INTEGER NOT NULL DEFAULT 1,
  created_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (network_id, user_id, group_id)
);
```

**为什么组授权要单独一张表,而不是往 `network_member_agent_grants` 上加一列 `group_id`**:

1. 那张表带着 `CHECK ((node_id IS NULL) <> (alias IS NULL))`,SQLite 改不了 CHECK,组授权的行写不进去。
2. 更要紧的是**旧 app 的 PUT 是整体替换**。旧 app 保存授权时只会带回它认得的 node_id 和 alias 两类授权;组授权如果放在同一张表里,就会被这次整体替换**悄悄删掉**。放在单独的表里,旧的 PUT 根本碰不到它。

### 8.2 生效规则

生效规则只改一处:`agent-access.ts` 里的 `visibleAgents()`。它现在按逐个节点的授权展开;改成在此基础上再并入「该成员被授权的组 → 这些组里的成员节点」。只算同一网络、而且 `nodes` 表里还存在的节点;已删除或已迁出的节点自然就不算了。

- **动态**:往组里加一个节点,下一次请求这个节点就可见了。hub 现在就是每次请求现算、不做缓存,所以这一点天然成立。
- **并集**:可见 = 直接授权 ∪ 组授权。可对话 = 任一来源给了 `can_message` 就算。
- **执行点不变**:§2 里列的所有路径都经过 `canSeeAgent`、`canMessageAgent`、`addAgentNetworkScope`、`addAgentTimelineScope`(#563)和 `addOwnTrafficScope`,改了 `visibleAgents()` 就全部覆盖了。
- **打开着的实时流**:组成员增删、组授权变化、删除组的时候,对受影响的成员调用 `closeUserStreamsInNetwork()`,让他们按新权限重连。已有的授权变更走的就是这条路。
- **受限判据不变**:`isAgentRestricted()` 照旧;`agent_access='all'` 的成员不看组。

### 8.3 API

全部要求用户令牌,节点令牌一律 403。调用者限于网络 owner/admin 和 Hub 管理员。

| 路由 | 说明 |
|---|---|
| `GET /api/networks/:id/agent-groups` | 组列表,每个组带 `member_count`、`granted_user_count` |
| `POST /api/networks/:id/agent-groups {name, description?, node_ids?}` | 建组;同一网络内重名返回 409 |
| `PATCH /api/networks/:id/agent-groups/:gid {name?, description?}` | 改名 |
| `PUT /api/networks/:id/agent-groups/:gid/members {node_ids}` | 整体替换组成员;不属于本网络的节点返回 400,整批都不写 |
| `DELETE /api/networks/:id/agent-groups/:gid` | 删组,同时删掉这个组上的所有授权;响应里带 `affected_user_ids` |
| `GET/PUT …/members/:uid/agent-grants` | **向后兼容地加字段**:GET 多返回一个 `group_grants:[{group_id, name, can_message}]`,`grants` 的形状不变;PUT 新增可选的 `group_grants`。**不传 `group_grants` 就保持原样**,所以旧 app 的 PUT 不会动到组授权 |
| `GET /api/networks/:id/members` | 每个成员多返回一个 `agent_group_count` |

受限成员**看不到**组列表(403)。他只会通过名册看到最终能访问的那些 Agent。

### 8.4 审计

新增审计事件:`agent_group_created`、`agent_group_renamed`、`agent_group_deleted`(附带受影响成员的数量)、`agent_group_members_changed`(记 `added` 和 `removed` 两份 diff,不记全量)。原有的 `member_agent_grants_changed` 事件里,新增 `group_grants` 字段。这些事件都带 `network_id`,§4.4 的「网络负责人读本网络审计」能直接读到。

### 8.5 兼容

| 组合 | 行为 |
|---|---|
| 旧 app × 新 hub | 选择器只显示直接授权,组授权被保留(见 §8.1)。成员行的「N 个 Agent」只统计直接授权,可能偏少,但不会误删任何东西 |
| 新 app × 旧 hub | 分组接口返回 404,app 就不显示「Agent 分组」入口和授权里的「组」一栏,其余功能照旧 |
| 旧节点(`agent-node`) | 不涉及,组完全是 hub 侧的概念 |

升级不改变任何人现有的可见范围:新表是空的,组授权为零。

### 8.6 app

- 设置 → 用户管理 → 新增「Agent 分组」:可以建组、改名、删除,删除时要二次确认并写明「会影响 N 个成员」。编辑组成员复用 ① 做的那套批量选择器(按机器、按类型、搜索、全选);这里存下来的是**组成员**,之后授权给组的成员会随之动态生效。
- 成员授权对话框和成员页:在「仅指定」下面加一栏「分组」,每个组一行,可勾选,并带可对话开关;组下方用小字写明「组里新加的 Agent 会自动可见」。**桌面端**是对话框里的一个区块,**手机端**是一张单独的卡片,都用 settings-kit 的行。
- **为什么不做规则组(比如「这台机器上的所有 Agent」)**:机器名来自节点自报的 `hostname`,节点换机器、重名都会让授权悄悄漂移,边界不够硬。先上自由定义的组,真有需要再加一个 `rule` 列。

### 8.7 测试计划(正反两个方向)

hub 侧写在 `agent-acl-groups-http.test.ts`,用临时库和真实的 `Bun.serve`。

- **正向**:组授权后能看见、能派活;往组里加节点后立刻可见;移出组但仍有直接授权的节点照样能访问;直接授权与组授权的可对话取并集。
- **反向**:从组里移出节点后,对它派活返回 403,且与「节点不存在」的返回逐字节相同;删组后访问消失;别的网络的 group_id 和 node_id 返回 400;节点令牌 403;受限成员 GET 组列表 403。
- **兼容**:
  - 用旧形状的 PUT(只带 `grants`)保存后,组授权仍在;
  - `agent_access='all'` 的成员不受组影响。
- **变异见证**:删掉 `visibleAgents()` 里的组展开,正向用例必须变红;删掉 PUT 的「不传就保持」,兼容用例必须变红。
- **app 侧**:ck 单测,加上一次性 hub 上的端到端;桌面端和手机端各一套 boundingBox 测量。

### 8.8 发布

分三步,每一步都能单独发:

1. **hub preview**:建表、`visibleAgents()` 并组、上 API、审计和测试。旧 app 照常使用。
2. **app**:加上「Agent 分组」管理页和授权里的「分组」一栏。
3. **可选**:加规则组(`rule` 列),等 Vincent 需要时再做。

需要 Vincent 定的只有一件事:**组列表要不要对普通成员可见**。建议不可见,成员只需要看到最终能访问的 Agent。

## 9. 附:任务(需求卡)的人员权限(2026-09-30 追加)

Vincent 原话:「还有 任务的权限也要设计一下,人员的」。本节只管**人**(用户令牌)能看、能改哪些任务;Agent(节点令牌)的规则**原样不动**(§9.2 末尾)。实现分三步,见 §9.8。

### 9.1 今天(按 origin/main 代码)

代码入口是 `server/src/requirements.ts` 的 `handleRequirementsRequest()`。MCP 的 `requirements_*` 工具经 `tools.ts` 的 `requirementsCall` 直接调它,所以 REST 和 MCP 是同一套规则。

| 操作 | 人(成员 / 受限成员) | viewer | 执行点 |
|---|---|---|---|
| 列表 `GET /api/requirements`(含 `q=`、分页、`seq`、`project_id` 等筛选) | **网络里全部卡片**(未归档的最新 500 张) | 全部 | `addHumanNetworkScope()`:只按网络过滤 |
| 单张 `GET /api/requirements/:id`(或 `#N`) | 网络里任一张 | 任一张 | `scopedRow()` |
| 新建 `POST` | 可以 | 403 | `canWrite()` → `canRestWriteNetworkAsHuman()`(非 viewer 即可) |
| 修改 `PATCH`(含改负责人、参与人、状态) | **任一张** | 403 | `patchRequirement()` → `canWrite()` |
| 勾子任务 `PATCH …/checklist/:item` | 任一张 | 403 | 同上 |
| 删除 `DELETE` | **任一张,而且是硬删除** | 403 | 同上 |
| 按 external_ref 同步 `POST /upsert` | 可以 | 403 | 同上 |
| 项目:列表 | 网络里全部 | 全部 | `handleProjects()` |
| 项目:新建 / 改名 / 归档 / 删除 | 可以 | 403 | `handleProjects()` → `canWrite()` |
| `GET /tags`、`GET /people` | 全网标签;全体成员 + 自己看得见的 Agent | 同左 | — |

补充几点:

- **受限成员**(`agent_access='granted'`)目前在任务上只有一处与普通成员不同:卡片上**没授权给他的 Agent 引用**会被隐去,他也不能指派这些 Agent(`hiddenNodeFilter()`、`personRef()`)。卡片本身他全都看得见、改得了。
- **需求卡的写操作没有任何审计**:`requirements.ts` 里没有调用 `logAudit`。硬删除也不留痕。
- **Agent(节点令牌)**:只能在自己令牌绑定的网络里读、建、改、勾子任务、upsert、读项目;不能删除,也不能管理项目(`NODE_TOKEN_OPERATIONS`)。它能改的是**该网络里任意一张卡**,不限于负责 Agent 是自己的卡。
- **没有「评论」功能**:代码里既没有评论表,也没有评论接口。所以提议里的「只能看 / 评论」,目前只能先落成「只能看」。

### 9.2 模型

在 `network_members` 上新增一列 `task_access`,取值 `all` 或 `scoped`,判定方式与 `agent_access` 完全平行。另加一张项目授权表:

```sql
ALTER TABLE network_members ADD COLUMN task_access TEXT NOT NULL DEFAULT 'all';   -- 升级前的行全部是 all
CREATE TABLE network_member_project_grants (
  network_id TEXT NOT NULL, user_id TEXT NOT NULL, project_id TEXT NOT NULL,
  can_edit INTEGER NOT NULL DEFAULT 0,            -- 行存在即可看;can_edit=1 可改
  created_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (network_id, user_id, project_id)
);
```

| 谁 | 能看见的卡 | 能改 / 能勾子任务 | 能删 | 项目管理 |
|---|---|---|---|---|
| Hub 管理员、网络 owner/admin | 全部 | 全部 | 全部 | 可以 |
| `task_access='all'` 的 member(升级前的老成员) | 全部(与今天相同) | 全部(与今天相同) | 全部(与今天相同) | 可以(与今天相同) |
| `scoped` 的 member | ① 负责人是我;② 参与人里有我;③ 我建的;④ 所在项目授权给了我 | 负责人是我,或我建的;所在项目授权给我且 `can_edit`。参与人里有我的卡:**只能改状态和检查项**(见 §9.9 第 3 项)。**其余能看见的卡只能看** | 负责人是我或我建的 | 不可以;只看得到授权给自己的项目 |
| `scoped` 的 viewer | 只有 ④ | 不能改 | 不能删 | 不可以 |
| `all` 的 viewer(升级前) | 全部,只读(与今天相同) | 不能改 | 不能删 | 不可以 |

- **新建**:`scoped` 的 member 可以建卡。卡要么不放进任何项目,要么放进自己有 `can_edit` 的项目。建完以后他就是创建者,可以看也可以改。
- **子任务**:子卡的可见性按它自己的负责人、参与人、创建者、项目单独判定,**不从父卡继承**。父卡上显示的子任务进度,只统计调用者看得见的子卡。
- **Agent 引用照旧**:§2 的 `hiddenNodeFilter` 规则不变,没授权的 Agent 照样隐去,也照样不能指派。
- **Agent(节点令牌)本节不改**:仍然在自己的网络里读、建、改任意一张卡。「只能改负责 Agent 是自己的卡」是一个可以另做的收紧,列为 §9.9 的第 2 项。

### 9.3 执行点

新增一个模块 `server/src/task-access.ts`,里面只放判定;`requirements.ts` 里的每条路径都走它。

| 路径 | 规则 |
|---|---|
| 列表(含搜索、分页、所有筛选) | SQL 追加可见性子句(见下文示意),`scoped` 调用者才加。`ambiguous_seq` 只在可见行里判定 |
| 单张 `GET` / `PATCH` / 勾子任务 / `DELETE` | 看不见的卡,一律返回 `404 requirement_not_found`,与不存在的卡**逐字节相同**(和 `agent_not_granted` 同一个思路,不能拿它探测卡是否存在)。看得见但没有改权 → `403 task_read_only`;参与人改了状态 / 检查项以外的字段 → 同一个 `403 task_read_only`,另带 `field` 和中文 `message`;没有删权 → `403 task_delete_denied` |
| 新建 | `project_id` 必须是自己有 `can_edit` 的项目,否则返回 `project_not_found`,与项目不存在同一个错误;`parent_id` 必须是看得见的卡,否则返回 `parent_not_found`。用 `client_id` 重放时,只有原卡是**自己建的**才回原卡,否则返回 409 `client_id_taken`,不回别人的卡 |
| upsert(同步接口) | `scoped` 的成员一律 `403 upsert_not_allowed`,是一个固定错误。否则 `external_ref` 的唯一索引会把「这个 ref 已经存在」泄露出去。同步本来就是 Agent 和管理员在用 |
| 项目列表 / 管理 | `scoped` 的成员只列出授权给自己的项目;新建、改名、归档、删除都返回 403 |
| `GET /tags` | 只从自己看得见的卡里汇总 |
| `GET /people` | 不变:人员通讯录 + 看得见的 Agent |
| MCP `requirements_*` | 经 `requirementsCall` 走同一个处理函数,**自动**跟着生效;`RESTRICTED_MEMBER_TOOLS` 不用改 |

可见性子句的示意(SQLite 写法,用 `json_each` 拆参与人)。PostgreSQL 后端(RFC-039)要换成 `jsonb_array_elements`,两种写法都要在测试里各跑一遍:

```sql
AND ( requirements.owner_json = :me_ref
   OR requirements.created_by = :uid OR requirements.created_by_json = :me_ref
   OR EXISTS (SELECT 1 FROM json_each(requirements.participants_json) p WHERE p.value = :me_ref)
   OR requirements.project_id IN (SELECT project_id FROM network_member_project_grants WHERE network_id = :net AND user_id = :uid) )
```

实现时先用 EXPLAIN 看这条子句的查询计划;比照 §8 做法,补一道性能守卫:300 张卡、20 个项目授权时,列表请求多出的耗时不超过 5 ms。

### 9.4 默认值与迁移(不收窄任何人)

- **老成员不变**:升级前已有的成员行由 `ALTER … DEFAULT 'all'` 落在 `all`,看到的、能做的都与今天一样,一个人都不会被收窄。
- **新成员默认 `scoped`**(和 `agent_access` 新成员默认 `granted` 同一个思路)。管理员建号、`POST /members`、邀请码加入都一样。新成员默认只看得到与自己相关的卡,没有任何项目授权。
  - **现状(Hub .74):默认暂时是 `all`**(`NEW_MEMBER_TASK_ACCESS`)。app ≤0.2.163 没有任务权限界面,从那些 app 加的成员默认 `scoped` 会一张卡都看不到,管理员也没法在那些 app 里放宽。等 owner 的设备都 ≥0.2.164 且确认后再改回 `scoped`。显式 `task_access: "scoped"` 一直有效。
- **要收窄老成员**:管理员在 UI 上把他切到「仅相关任务」,切换时对话框里预填「当前全部项目 + 可看」,不会一保存就把人清空。与 §4.3 的 G1 同一个做法。
- **升级前后**:owner/admin 的行为不变;没有数据迁移,只新增一列和一张空表。

### 9.5 API

以下接口都只接受用户令牌,调用者限于 owner/admin 和 Hub 管理员,与 agent-grants 相同。

- `GET/PUT /api/networks/:id/members/:user_id/task-grants`:
  - 请求体 `{ task_access?: 'all'|'scoped', project_grants?: [{project_id, can_edit}] }`,**整体替换**。
  - 不传的字段保持原样,旧客户端不会误清。
  - 任何一个项目不属于本网络,返回 400,整批都不写。
- `GET /api/networks/:id/members` 每个成员增加 `task_access` 和 `task_project_count` 两个字段。
- `/api/auth/me` 的 `networks[]` 增加 `task_access`,app 靠它显示只读提示和空态文案。

### 9.6 审计

- 新增事件:
  - `member_task_grants_changed`:授权变更,记 diff;
  - `requirement_deleted`:删卡,今天完全不留痕,这次补上;
  - `task_access_denied`:被拒的写入,同一 (用户, 卡) 每小时最多记一条。
- 全部事件都带 `network_id`,§4.4 的「网络负责人读本网络审计」能直接读到。

### 9.7 app

**成员弹窗 / 成员页**:在「可访问的 Agent」下面新增一段「任务权限」。

| | 桌面(DialogFrame 里的一个区块) | 手机(设置三级页「成员」里的卡片,微信式) |
|---|---|---|
| 范围 | 分段控件「全部任务 / 仅相关任务」,下面一行小字说明「相关 = 我负责、我参与、我建的,加上下面勾选的项目」 | 单选两行,选中的打 ✓;说明放在卡片页脚 |
| 项目 | 可搜索的项目清单:每行一个复选框 + 项目色点 + 名称 + 「可编辑」开关;viewer 不显示开关,显示「只读」 | 每个项目一行 ✓;另起一张「可编辑的项目」卡片,每个已选项目一行开关 |
| 成员行摘要 | 「全部任务」/「3 个项目」/「仅相关任务」 | 同左 |

**任务看板**(`scoped` 成员看到的变化):

- 只读的卡显示 🔒「只读」,编辑控件置灰。点了不会让用户先改完再被 403 退回来,而是一开始就不让编辑。
- 看不到删除按钮;项目管理入口也不显示。
- 看板为空时显示「还没有与你相关的任务」,而不是「还没有任务」。

**老 hub 兼容**:`task-grants` 返回 404 时,整段「任务权限」不显示,和 §8.5 的分组做法相同。

### 9.8 测试计划与发布

**测试**(hub 侧,`task-access-http.test.ts`,真实 `Bun.serve` + 临时库):

- **正向**:
  - 负责人、参与人、创建者都能看见自己的卡;
  - 项目授权 `can_view` 能看、`can_edit` 能改;
  - `all` 的老成员和 owner 行为与今天逐字相同;
  - MCP `requirements_list/get/update` 与 REST 结果一致。
- **反向**:
  - 看不见的卡:GET、PATCH、DELETE、勾子任务、`#N` 都返回 404,且与不存在的卡逐字节相同;
  - 只读的卡 PATCH 返回 403 `task_read_only`;
  - `scoped` 成员 upsert、管理项目都返回 403;
  - 往没授权的项目里建卡、`parent_id` 指向看不见的卡、`client_id` 撞上别人的卡,都返回与「不存在」相同的错误;
  - 列表、搜索、标签都不出现看不见的卡。
- **变异见证**:删掉可见性子句、删掉 404 同形、删掉 upsert 拦截,各自至少一条用例变红。
- **性能守卫**:见 §9.3。
- **app 侧**:ck 单测;在一次性 hub 上跑端到端:建 `scoped` 成员 → 只看到相关卡 → 授权项目 → 能看、能改 → 撤销;桌面、手机各测一套 boundingBox。

**分三步发布**,每一步都能单独发:

1. **hub**:`task_access` 列 + 项目授权表 + §9.3 的全部执行点 + 审计(含补上的删卡审计)+ 测试。旧 app 照常能用:`scoped` 成员只是看到的卡变少,改只读卡时拿到 403,旧 app 会把这个错误原样显示出来。
2. **app**:成员弹窗和成员页里的「任务权限」区块(桌面、手机分别做),加上看板的只读、隐藏删除、空态文案。
3. **可选**:评论功能(让「只能看 / 评论」补全),以及收紧 Agent 规则:节点令牌只能改负责 Agent 是自己或参与人里有自己的卡。

### 9.9 需要 Vincent 定的

1. 新成员默认 `scoped`(只看与自己相关的卡)?建议**是**,与 Agent 权限新成员默认零授权保持一致。
2. Agent 的改卡范围要不要收紧到「负责 Agent 是自己的卡」(第 3 步)?建议**先不收**,目前没有实际问题。
3. 参与人要不要能勾子任务(轻量参与)?~~建议先不能~~ —— **Vincent 2026-10-01 定:「参与人可以改，但是改了之后需要有个通知。」**
   参与人能改状态(列)和检查项(勾选 / 增 / 删 / 改字),其余字段仍只给负责人 / 创建者 / 可改项目授权。
   参与人(非负责人)改了,Hub 以他的名义给负责人、创建者、其他参与人各发一条私信(只发给人、去重、不发给自己;
   同一人对同一张卡 60 s 内的连续改动并成一条未读私信)。实现:`server/src/requirement-notify.ts`;
   每卡权限 `viewer_can` 对这类卡多带 `edit_fields: ["column", "checklist"]`。

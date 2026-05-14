# RFC-001：废弃 COMMHUB_AUTH_TOKEN，统一收敛到用户 Token

| 字段        | 内容                                   |
| ----------- | -------------------------------------- |
| 状态        | **已采纳** (Vincent, 2026-05-11)         |
| 提出        | 2026-05-11                             |
| 更新        | 2026-05-11（Dashboard 简化方案）         |
| 作者        | Vincent (sleep2agi)                    |
| 实施人      | 通信牛 / SDK马                          |
| 目标版本    | server v0.8.0 → v1.0                    |
| 讨论        | [#3](https://github.com/sleep2agi/agent-network/issues/3) |

## 摘要

当前 hub 里有三种 token：`utok_`（用户 token）、`ntok_`（节点-网络维度 token）、以及 `COMMHUB_AUTH_TOKEN`（服务级 master key）。master key 在 V3 鉴权之前就存在了，已经不再发挥独立价值 —— `role=admin` 的 `utok_` 可以完全覆盖它的所有合法用途。

> **状态（2026-05-12）**：本 RFC 已**采纳**。阶段 2 已在 v0.8.0 / v0.8.1 全部落地（COMMHUB_AUTH_TOKEN 软废弃 + admin `utok_` bootstrap + Dashboard cookie 透传 + 密码管理）。阶段 3（v1.0 硬下线）排队等周期。issue #3 已闭环。

## 动机

为什么现状不好：

1. **给永远用不到的用户增加认知负担。** 终端用户只需要学 `anet login`（拿到 `utok_`）和 `anet node create`（拿到 `ntok_`）。master token 只对多租户自托管的运维有意义 —— 而且就算在那种场景下，admin `utok_` 也能完全替代它。文档自己都不得不写"高级·只在你自部署 hub 时才相关"（`docs-site/docs/concepts/tokens.md:126`）。

2. **三个概念能合并成一个。** `requireAuth()`（`server/src/index.ts:98-112`）先调 `resolveToken()`，失败再退回到 `token === AUTH_TOKEN`。这条 fallback 是 `isLegacyAuthToken()`（`index.ts:93-96`）存在的唯一理由，也是 `/events/:alias` 里那段特殊分支（`index.ts:339-348`）存在的唯一理由，也是 `~/.anet/server/config.json` 里 `auth_token` 字段存在的唯一理由（`bin/cli.ts:1865, 1952, 2083`）。

3. **没有审计踪迹。** 用 `COMMHUB_AUTH_TOKEN` 鉴权过的请求没有 user、没有 network、没有 token 名。审计日志里这一行操作归属为空。任何通过 master token 走的操作，等于"匿名但被授权"。

4. **没有 role 绑定。** master token 是全开或全关。无法限制某个服务为 `read` 权限、或限制它只能访问某个 network。改用 admin `utok_` 配合 `scope` / role 强制校验（安全报告 R12 的要求），我们能拿到一个真正的权限模型。

5. **安全审计压力。** 现状在 `docs/open-source-security-risk-report.md` 里被三个 finding 点名：
   - **R3（Critical）** —— 开放模式启动的判定靠"`COMMHUB_AUTH_TOKEN` 没设"。一旦 `COMMHUB_AUTH_TOKEN` 拿掉，开放模式路径就坍缩成一个明确的 `--dev-open` flag，几乎不可能误触发。
   - **R4（Critical）** —— `requireAuth()` 接受 master token，导致 tmux WebSocket 没有绑定具体用户也能鉴过。把 tmux 接入绑死到 admin `utok_`，session 才能真正归属到人。
   - **R7（High）** —— 当调用方是 master token 时，MCP 读类 tool 不校验 network 成员关系，因为 master token 没有 user/network。把 master 这条路径删掉，强制每个调用方都带 `userId`/`networkId`，`canRead()` 才能处处生效。

## 现状

`COMMHUB_AUTH_TOKEN` 在系统里出现在 5 个地方：

1. **server 启动闸门。** `server/src/index.ts:11` 从 env 读取。`index.ts:22-25` 在它未设、且没传 `--dev-open` 的情况下拒绝启动。`index.ts:14` 的 banner 和 `index.ts:709-710` 的 `/health` 返回都会回声它的设置状态。

2. **`requireAuth()` 的 fallback。** `server/src/index.ts:107-109`：
   ```ts
   // Legacy: check global COMMHUB_AUTH_TOKEN
   if (!AUTH_TOKEN && DEV_OPEN) return null;
   if (token === AUTH_TOKEN) return null;
   ```
   就是这条路径让 master token 持有者能调 `/mcp`、`/events/:alias` 以及所有 `/api/*` 端点，而 `user_id` 始终没被解析出来。

3. **SSE 的 legacy 分支。** `server/src/index.ts:339-348` —— 仅当 `isLegacyAuthToken(req)` 为真时，SSE 订阅会跳过成员关系校验。这是删起来最干净的一段：拿掉 `COMMHUB_AUTH_TOKEN`，安全报告里的 R8（"SSE 不校验 token/network"）顺手就修了。

4. **CLI 生命周期。** `agent-network/bin/cli.ts` 在 4 个地方读写 master token：
   - `:1860` 把 `process.env.COMMHUB_AUTH_TOKEN` 当作 `anet hub start` 的 fallback。
   - `:1865, :1952` 把 `auth_token` 落到 `~/.anet/server/config.json`。
   - `:2083` 让 `anet hub config --token <t>` 覆盖它。
   - `:2103-2116` 通过 env 把它传给 Dashboard 子进程，让 Dashboard 能跟 hub 通信。

5. **文档。** `docs-site/docs/concepts/tokens.md`、`docs-site/docs/deploy/production.md`、`docs-site/docs/api/rest.md`、中英 CLI 指南、以及 docker 部署文档都引用了它。基本都面向自托管。

值得注意：agent 节点从不使用 master token。它们都拿 `ntok_`。删除 master 不会影响任何一个已部署的用户 agent。

## 设计方案

### 1. Admin 端点改用 admin role 的 `utok_`

hub 已经会给第一个注册用户颁 `role=admin`（`server/src/auth.ts:33-42`）。`requireAdminAuth()`（`server/src/index.ts:129-136`）也已经实现了正确逻辑：解析 token → 校验 `user.role === "admin"`。我们把覆盖面扩大 —— 凡是当前依赖 `COMMHUB_AUTH_TOKEN` 才能获得高权限的端点，都显式调 `requireAdminAuth()`。

举例：tmux WebSocket 当前走 `requireTmuxAccess` → `requireAdminAuth`，已经要求 admin `utok_`。本 RFC 之后，对兜底的 `/api/*` admin 块、以及任何此前靠 master token 无身份鉴权的路径，全部套用同一模式。

```ts
// Before
const authErr = requireAuth(req);   // accepts master token, no user
if (authErr) return authErr;

// After (for elevated endpoints)
const authErr = requireAdminAuth(req);   // resolved utok_, role=admin
if (authErr) return authErr;
```

对于非高权端点（`/mcp`、`/events/:alias`、REST 读类），`requireAuth()` 保留 `resolveToken()` 路径，删掉 master-token fallback。每次成功鉴权都会产出一个 `userId`，以及（如果用的是 `ntok_`）一个 `networkId`。

### 2. Dashboard 改为 thin proxy —— 不持有任何 token

经过 issue #3 讨论（maintainer 回复后），之前提议的"Dashboard 自己持有一个 service token"被**否决**。Dashboard backend 不持有任何凭证。

**唯一一套模型，同机部署 / 跨机部署都一样**：

```
1. 运维启动 Dashboard:    anet hub dashboard --hub https://hub.example.com
                          （Dashboard 只知道 hub URL。不落任何 token。）

2. 用户打开浏览器：       https://dashboard.example.com

3. 用户在 Dashboard 登录页提交 用户名 + 密码。

4. Dashboard backend POST 凭证到 hub /api/auth/login，
   拿回一个 `utok_`（里面已绑定用户 role），
   作为 HTTP-only 的 session cookie 写回浏览器，scope 限定到 Dashboard origin。

5. 之后每次 浏览器 → Dashboard 的请求：
   Dashboard backend 从 cookie 读出 `utok_`，
   作为 `Authorization: Bearer utok_…` 透传给 hub。

6. hub 按 `utok_` 内嵌的 role 决定授权结果。
```

**为什么这个方案比"持 service token"严格更好**：

- Dashboard 主机被攻破时，没有任何长期凭证可被偷走 —— 暴露的只是当前在线用户的 session cookie，并且每次 `anet login` 都会自动轮换。
- 每一次 hub 调用都能归属到一个真实用户。审计日志显示的是真实身份，而不是"Dashboard 干的"。原 Open Question 2 由此构造性消解。
- 跨机部署和同机部署是同一条路径 —— 指过去就行。无额外步骤、无 token 拷贝、无 `admin-utok.json` chmod。
- Dashboard 里不存在"service 身份"的代码分支 —— 测试面更小，配置出错点更少。

**`admin-utok.json` 文件仍然由 `anet hub start` 生成**（让 `anet hub admin reset` 这类本机 CLI 命令可以免交互鉴权），但 Dashboard 不读它。

### 3. Bootstrap

首次运行 `anet hub start` 当前已经会创建 admin 账户（`bin/cli.ts:1969-2001`）。我们再收紧一些：

- admin 创建后，额外创建一个具名 `utok_`（token name 比如 `admin-bootstrap`），落到 `~/.anet/server/admin-utok.json`，权限 `chmod 600`：
  ```json
  {
    "username": "admin_a1b2c3",
    "user_id": "u_...",
    "token": "utok_...",
    "created_at": "2026-05-11T..."
  }
  ```
- banner 继续显示 admin 用户名 + 一次性密码。
- banner 额外提示一句 `Admin token saved (used by dashboard)` —— 不打印 token 值。
- 不再向用户 shell 注入任何 env 变量。用户没有需要复制的东西。

### 最终下线的代码路径（v1.0 终态）

- `server/src/index.ts:11` 的 `AUTH_TOKEN` 常量。
- `isLegacyAuthToken()` 及其全部调用点。
- `requireAuth()` 里 `if (token === AUTH_TOKEN) return null;` 分支。
- `index.ts:339-348` 的 SSE legacy 分支。
- server config JSON schema 里的 `auth_token` 字段。
- `anet hub start` 的 `--token` flag（用 login 流程取代，admin token 内化为内部细节）。
- `COMMHUB_AUTH_TOKEN` env 变量：所有地方都不再读取；v0.8 警告，v1.0 完全忽略。

## 迁移计划

### 阶段 1 —— v0.7.x（✅ 已完成）

- ✅ `COMMHUB_AUTH_TOKEN` 行为保持不变。
- ✅ CLI 自动管理 `~/.anet/server/config.json` 里的 `auth_token`；用户从不手敲。
- ✅ **取消**此前计划的 `anet hub token` 子命令（既然要废弃这个概念，不再为它新增 CLI 接口）。
- ✅ 不新增任何提及 master token 的文档。

### 阶段 2 —— v0.8.0 / v0.8.1（✅ 已落地）

- 首次运行时 server 自动 bootstrap admin `utok_`（`admin-utok.json` 落盘）。
- tmux + admin REST 端点强制 `requireAdminAuth`；`requireAuth` 里的 master-token 分支**仍保留，但只允许 `/api/*` 读类**，附带 warning log：
  > `[commhub] master-token auth is deprecated and will be removed in v1.0. See RFC-001.`
- CLI：
  - `anet hub dashboard` 改用 `admin-utok.json` 里的 admin `utok_`（文件缺失时 fallback 到 `COMMHUB_AUTH_TOKEN`，附同样的 deprecation warning）。
  - `anet hub config --token` 落盘时打印 deprecation warning。
  - 启动时如发现 `config.json` 里有 `auth_token`，静默忽略（startup 阶段打一次 warning，hub 不再使用此值）。
- Dashboard 切换为 admin `utok_`。
- **默认开放模式取消。** `anet hub start` 不带 `--dev-open` 时一律 provision admin 用户 + token。"没设 token 就走开放模式"这条路径不复存在。R3 关闭。
- `COMMHUB_DEV_OPEN=1` 和 `--dev-open` 仍可用于"离线教程"场景，banner 改得更显眼。

### 阶段 3 —— v1.0（⏳ 计划中，等周期）

- 上文"最终下线的代码路径"全部删除。
- `~/.anet/server/config.json` 里出现 `auth_token` 视为未识别字段（warning + 忽略，严格模式直接拒绝）。
- `COMMHUB_AUTH_TOKEN` env 不再被读取。设置它没有任何效果。
- 文档里 master token 相关内容全部清掉。
- `SECURITY.md` 和安全风险报告里 R3 / R4 条目加脚注："已在 v1.0 通过 RFC-001 解决"。

## 用户密码管理（v0.8 一并上）

`COMMHUB_AUTH_TOKEN` 拿掉以后，user 密码 + `utok_` 是唯一的鉴权基线。原本零散的密码相关代码需要补齐成完整闭环，与本 RFC 同节奏在 v0.8 落地（不另开 RFC，体量太小）。

### A. 主动改密（已部分实现，补齐）

当前已有：
- 后端 `POST /api/auth/password`（`server/src/auth.ts:242`）。
- CLI `anet passwd`。
- Dashboard `/settings` 页有 Change Password 表单（`app/settings/page.tsx:162-189`）。

补齐项（v0.8）：
- CLI `anet passwd` 默认进交互（依次 prompt 旧密码 → 新密码 → 确认）；保留 `--old / --new` 给脚本调用。
- 改密成功后，**自动撤销该用户的所有其他 `utok_`**（即当前会话之外的，其他设备同步登出）。`ntok_` **不撤** —— 它是设备/节点维度的凭证，不绑定密码生命周期。
- Dashboard 改密成功后，前端轮换 session cookie（拿新 `utok_` 重新写 cookie），其他设备会在下次请求时收到 401。

### B. 忘记密码 → admin-assisted reset

新增本机 CLI 命令 `anet hub admin reset-user --username <u>`：

1. 直接读 SQLite，绕过 HTTP API。
2. 拒绝在非 hub 主机环境运行（与 `anet hub admin reset` 相同的本机闸门）。
3. 生成随机密码，更新 `users.password_hash`，打印新密码一次。
4. **撤销该用户全部 `utok_`**（强迫被重置用户重新 `anet login`）。
5. 在 `audit_log` 写一条 `password_reset_by_admin` 事件，记录操作 hub admin + 被重置 user。

不做邮件 reset（项目暂无邮件服务）。需要找回密码但又上不了 hub 主机的人，需要联系自托管 admin —— 这跟 local-first 定位一致。

### C. 邮件 reset

**暂不做。** 需要先接入邮件服务（SMTP / Resend / SES）。等 v0.9+ 真正有用户群体反馈需求时再做插件化设计。

### D. 密码强度

- 最小长度从 6 升到 **8**。
- 拒绝 top-1000 弱密码（embed 一个 ~10KB 字典）。
- 不强制大小写 / 数字 / 特殊字符（UX 太烦，企业 SSO 才需要）。

### E. token 撤销语义（最终决策）

| 触发场景 | utok_ 撤销范围 | ntok_ 撤销范围 |
|---|---|---|
| 用户改自己的密码（成功） | 撤销该用户所有 utok_，**保留**当前会话的那一张 | 不撤 |
| Admin reset 用户密码 | 该用户全部 utok_ 撤销 | 不撤 |
| 用户手动 `anet token revoke <id>` | 仅撤指定 token | 同 |
| 用户主动 `anet logout` | 撤销当前会话 utok_ | 不撤 |

`ntok_` 设计上是设备/节点凭证，密码事件不波及。需要撤 `ntok_` 时用户走 `anet token revoke` 或在 Dashboard `/settings/tokens` 显式操作。

### F. 实施范围（给实施方）

| 模块 | 改动 | 估算 |
|---|---|---|
| `server/src/auth.ts` | `changePassword()` 后调撤销其他 utok_；新增 `resetUserPassword()` 函数 | ~30 行 |
| `server/src/index.ts` | 改密接口返回新颁的 utok_（替当前会话） | ~10 行 |
| `agent-network/bin/cli.ts` | `anet passwd` 交互式 prompt；`anet hub admin reset-user` 子命令 | ~80 行 |
| `agent-network-dashboard/app/settings/page.tsx` | 改密成功后用新 utok_ 替换 sessionStorage / cookie | ~20 行 |
| `server/src/passwordStrength.ts` | 新文件：长度 + 字典校验；embed top-1000 弱密码 | ~50 行 |
| 测试 | server unit + CLI E2E + Dashboard Playwright | 1 套 |

预计 1-2 天工作量（通信牛 codex）。

## 兼容性

**不会破坏的**：

- 已经在跑的 `ntok_` agent 完全不受影响。`ntok_` 是 `api_tokens` 表里的一行，跟 master 完全独立。
- 已经在 `~/.anet/global.json` 里持有 `utok_` 的用户 CLI / Dashboard，继续工作。
- 运行 v0.5.x / v0.7.x 的 hub 在阶段 2 内仍接受老客户端的 `COMMHUB_AUTH_TOKEN` —— 只是会 log warning。
- hub 的 SQLite schema 不变。不需要迁移脚本。

**会破坏的**：

- **CI 脚本** 通过 `COMMHUB_AUTH_TOKEN=...` 配置鉴权的：v0.8 warning，v1.0 鉴权失败。迁移方式：`anet login` 拿到 admin `utok_`，存为 CI secret。
- **第三方集成** 把 master token 硬编码为服务凭证的：同上。
- **运维在 `~/.anet/server/config.json` 里写了 `auth_token` 的**：v0.8 静默忽略 + warning，v1.0 视为未识别字段。hub 已经不需要它，admin token bootstrap 是自动的。
- **默认开放模式部署**（比如用空 env 直接启 `commhub-server`）：没传 `--dev-open` 一律拒绝启动。`commhub-server` 自 v0.5.x 起其实就这样，是 `anet hub start` 在自动生成 master 替它兜底。v0.8 里这条 auto-gen 改成 admin user bootstrap。行为变化只影响"直接 `commhub-server` 起 + 无 env"的人 —— 他们会拿到清晰错误信息，提示去用 `anet hub start`。

## 恢复 / 边界情况

> **实施备注**：v0.8 阶段实际把"admin 自恢复"和"普通用户重置"合并为同一条命令 `anet hub admin reset-user --username <u>`（admin 可以传自己的 username 来重置自己）。下方设计稿区分两条命令是早期讨论，落地时归并了。最新 CLI 见 [/guide/cli](https://anet.sh/guide/cli)。

**admin 用户被误删，或 admin 密码丢失**：
新增一个本机 CLI 子命令 `anet hub admin reset`（落地后并入 `reset-user`），在 hub 主机上运行。它会：

1. 直接读 SQLite DB（`~/.commhub/commhub.db`），绕过 HTTP API。
2. 拒绝在非主机环境运行，除非显式传 `--i-am-on-the-hub-host`、或调用进程 `cwd` 指向 hub 数据目录。
3. 生成一个随机密码，更新 admin 行的 `users.password_hash`（如果 admin 行已不存在，则重建）。
4. 颁发一个新的 admin `utok_`，落到 `admin-utok.json`（chmod 600），并把新密码打印一次。
5. **不**撤销其他 admin token —— 留给运维自己用 `anet token revoke` 处理。

不提供网络化恢复路径。如果你拿不到 hub 主机的 shell，admin 就找不回 —— 这是有意为之，跟"local-first"的产品方向一致。

**普通用户忘记密码**：参见上文"用户密码管理 §B"，由 hub admin 用 `anet hub admin reset-user --username <u>` 重置。

**Dashboard 跨机部署**：直接 `anet hub dashboard --hub https://hub.example.com`。Dashboard backend 不持任何 token，每个浏览器 session 自己跟 hub 建立身份。无文件拷贝、无主机相关配置。（详见设计方案 §2。）

**Pre-V3 hub 的迁移**：任何早于 `api_tokens` 表的 hub 自 v0.5+ 起就已经不兼容；本 RFC 不改变这一点。

## 备选方案

1. **保留 `COMMHUB_AUTH_TOKEN`，只是在 CLI 层不可见。** 拒绝。它仍会以"无用户"形式出现在审计日志里、仍需要 `requireAuth` 里的特殊分支、仍会让读源码的贡献者困惑。我们的目标是删掉这个概念，不是把它藏起来。

2. **Dashboard ↔ hub 改用 mTLS / 证书鉴权。** 拒绝。anet 是 local-first 产品，绝大多数用户把 hub + dashboard 跑在同一台笔记本上。证书 provisioning 是过度工程，会在 token 路径之外再开一条并行鉴权路径。

3. **Per-instance service token（Dashboard 一个、CLI 一个等）。** 拒绝。anet 没有集群、没有 service mesh、没有 Kubernetes。只有一个 hub 和有限的几类 admin-equivalent 调用方。Admin `utok_` 加上按名命名的 admin token（`anet token create --name dashboard`）已经覆盖了任何合理粒度，不需要新发明一种 token 类型。

4. **给 Dashboard 颁发非 admin 的 `service` scope。** ~~v1.0 之前拒绝~~ —— 2026-05-11 已被更简单的"Dashboard 不持任何 token"方案取代（设计方案 §2）。Dashboard 现在是一个 thin cookie-forwarding 代理，根本不存在 service 身份去 scope。

## 待解决问题

1. **~~给 Dashboard 一个专用 service token~~** —— **已解决** 2026-05-11：Dashboard 不持任何 token（见设计方案 §2）。审计日志归属自动到真实用户头上。

2. **`anet hub admin reset` 放在哪里？** 两个候选：
   - 作为 `anet hub admin ...` 下的独立子命令。
   - 作为 `anet doctor --fix` 的一个 flag（"发现 admin 损坏，要重建吗？"）。
   倾向：独立 `anet hub admin reset` 子命令，让它在 `--help` 里能被看到、明确是恢复工具。`anet doctor` 只做检测 + 提示，不应静默改库。

3. **bunx 缓存老版 `commhub-server`。** CLI 通过 `PINNED_SERVER_VERSION`（`bin/cli.ts:2088`）来规避 bunx 缓存。v0.8 上线时，老 CLI 用户会拉到老 server。需要协调好版本 bump 节奏，或者接受一个 release 窗口期内老 server 仍接受 master token —— 反正 v0.8 的软废弃就是给这个 case 准备的。

4. **`anet hub start --token` flag。** 当前被部分 power user 和测试脚本使用。阶段 2 保留（warning）。阶段 3 删除。`tests/` 下有没有用到？实施方在 v1.0 前要 grep 并迁移。

## 审批

| 角色        | 姓名                | 状态     |
| ----------- | ------------------- | -------- |
| Maintainer  | Vincent (sleep2agi) | pending  |
| Implementer | 通信牛 / SDK马       | pending  |

实施跟踪方式：RFC 采纳后开一个 tracking issue 引用本 RFC；阶段 2 / 阶段 3 的 PR 都 link 回该 issue。

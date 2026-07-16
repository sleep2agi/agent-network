# 故障排查

按错误信息快速定位问题和解决方案。

如果问题集中在 `anet doctor`、Telegram channel、MCP 工具注入、codex-sdk 主动 `send_task`，优先看专项 runbook：[连接 / Channel / MCP 排障](/troubleshooting/connectivity-channels-mcp)。

::: tip 不是故障，只是想了解版本？
看 [版本号体系](/guide/versioning) 理清 npm 包版（`anet -v` 那几行）和 `v0.10.x` bundle release 的对应关系；想升级走 [升级指南](/guide/upgrade)。
:::

## 启动类错误（首次运行最常见）

### `anet hub start` -- `spawn bunx ENOENT`

```
Error: spawn bunx ENOENT
```

**原因**：本机没装 **Bun**。`commhub-server` 是 Bun-shebang TypeScript，`anet hub start` 底层用 `bunx --bun` 起它，没有 Bun 就崩在第一步。

**解决**：

```bash
npm i -g bun
# 或： curl -fsSL https://bun.sh/install | bash
bun --version        # 应输出 1.2.x 或更新
```

装好 Bun 再跑 `anet hub start`。完整前置见 [上手指南 · 前置](/guide/getting-started)。（[#235](https://github.com/sleep2agi/agent-network/issues/235) 跟进给启动前友好预检。）

---

### `anet node start` -- `agent-node is not installed or cannot report a version`

```
agent-node is not installed or cannot report a version. Run: anet upgrade
```

**原因**：`claude-agent-sdk` / `codex-sdk` 两个 runtime 依赖 `agent-node` 包。设计是首次 `node start` 由 npx 懒加载自动拉取，但当前版本的启动检查**不等它拉完**就报错退出（[#450](https://github.com/sleep2agi/agent-network/issues/450)，#237 同族）。

**解决**：先手动装一次再启动：

```bash
npm i -g @sleep2agi/agent-node
agent-node --version     # 应输出当前 latest 或更新
anet node start <name>
```

> `claude-code-cli` / `grok-build-acp` runtime 不吃这个坑（不走 `agent-node` SDK 适配路径）。

---

## 连接类错误

### `ECONNREFUSED` -- 连接被拒绝

```
Error: connect ECONNREFUSED 127.0.0.1:9200
```

**原因**：CommHub Server 没有运行。

**解决**：

```bash
# 检查 Server 是否在运行 (v0.10.11+ 推荐, 一行看清 PID + port + /health version)
anet hub status                # 默认端口 9200
anet hub status --port 9201    # 非默认端口

# 或老办法 curl /health (老版本兼容)
curl http://localhost:9200/health

# 如果没有运行，启动 Server
anet hub start --port 9200

# 如果端口不对，检查配置
cat ~/.anet/config.json
```

---

### `ETIMEDOUT` -- 连接超时

```
Error: connect ETIMEDOUT 203.0.113.10:9200
```

**原因**：网络不可达或防火墙阻止。

**解决**：

```bash
# 检查网络连通性
ping 203.0.113.10
telnet 203.0.113.10 9200

# 检查防火墙
sudo ufw status
sudo ufw allow 9200

# 检查云服务器安全组
# 确保入站规则允许 TCP 9200
```

---

### `SSE connection failed` -- SSE 连接失败

```
[agent-node] SSE connection failed, reconnecting in 3s...
```

**原因**：SSE 长连接断开，通常是网络波动。

**解决**：Agent 会自动重连（[#202](https://github.com/sleep2agi/agent-network/issues/202) 起：指数退避 `1s → 30s` 上限 + 重连即重 register + 1h 失败放弃，[详见 agent-node 断线重连](/guide/agent-node#断线重连)），通常无需手动干预。

如果持续失败：

```bash
# 检查 Server 是否在运行 (v0.10.11+ 推荐, 一行看清 PID + port + /health version)
anet hub status

# 或老办法 curl /health
curl http://localhost:9200/health

# 检查 Token 是否有效
curl -H "Authorization: Bearer ntok_xxx" http://localhost:9200/api/status

# 检查反向代理配置（如果有）
# Nginx 需要以下配置：
# proxy_read_timeout 86400;
# proxy_buffering off;
```

### Hub 重启后 Dashboard 看不到节点

**症状**：`anet hub stop` + `anet hub start`（或 hub 进程崩溃后重启）几秒钟后，Dashboard 看到所有节点 `offline` 或完全不在节点列表里。Agent 进程实际还活着。

**原因（v0.10.10 及以前）**：hub 重启会清空 sessions 内存表。老版本 `agent-node` 的 SSE 重连只恢复事件流，**不重发 register**——hub 端 sessions 表要等下次 3 分钟 heartbeat 才会重建，期间 Dashboard 看不到任何节点。

**解决**：[#202](https://github.com/sleep2agi/agent-network/issues/202) 起结构性修复，SSE 重连成功立即重发 register（idempotent upsert），Dashboard 30s 内自动恢复完整节点列表。**无需手动 `anet project restart`**，跟 `anet hub stop` / `hub status` 配套用 → hub 维护 SOP 一键完成。如果你 agent-node 较旧，跑 `anet upgrade` 升到 npm latest 即享受。

---

## 认证类错误

### `No hub configured. Pass --hub <url> or run 'anet init' first.`

**现象**：全新装后第一次 `anet login`（或照着 `anet hub start` 的提示跑 `anet login --username admin --password anethub`）直接报这个，登不进去。

**原因**：`anet hub start` 只起 hub，**不会**把 hub 地址写进全局配置；而 `anet login` 需要知道连哪个 hub —— 中间少了「设置 hub 地址」这一步（`anet init` 或 `--hub` 会做）。

**解决**：登录时直接带 `--hub`（本机 hub 默认 `127.0.0.1:9200`）：

```bash
anet login --hub http://127.0.0.1:9200 --username admin --password anethub
```

或先 `anet init --hub <url>` 设好 hub 再 `anet login`。连远程 hub 把地址换成对应 IP。

---

### 401 `auth required` / `invalid token` / `token required`

实际 server 返回三种 401 错码（**不是** `{"error": "unauthorized"}`；verify `grep error.*401 server/src/index.ts`）：

```json
{ "ok": false, "error": "auth required" }     // 多数 REST 端点缺 Authorization header
{ "ok": false, "error": "token required" }    // 部分认证端点（如 /api/auth/me）缺 token
{ "ok": false, "error": "invalid token" }     // token 字面对但 resolveToken 失败（被 revoke / 过期 / hub DB wipe）
```

**原因**：Token 无效或缺失。`invalid token` 常见于 hub DB 被 wipe（重置 commhub.db），原有 utok\_ / ntok\_ 全失效。

**解决**：

```bash
# 检查当前 Token / 用户身份（v0.8 推荐入口）
anet whoami

# 如果 Token 过期，重新登录
anet login

# 检查配置文件中的 Token
cat ~/.anet/config.json

# （旧路径，已不推荐）COMMHUB_AUTH_TOKEN 自 v0.8 起软废弃；v1.0 移除。
# 如果你只是想看身份，请用 anet whoami；如果环境里残留了这个变量请清掉，避免触发 deprecation warning。
```

---

### `permission_denied` -- 权限不足

```json
{"ok": false, "error": "permission_denied"}
```

**原因**：

1. **utok_ 调用 MCP 写操作**：utok_ 没有网络绑定，不能调 MCP 写操作
2. **viewer 角色尝试写操作**：viewer 只能读

**解决**：

```bash
# 情况 1：使用 ntok_ 而非 utok_
# Agent Node 必须使用 ntok_，token 来自 .anet/nodes/<name>/config.json 文件
# （agent-node CLI 不接受 --token flag；token 由 config.json 提供）
# 如果当前 node 的 token 是 utok_/atok_，跑 doctor 自动修：
anet doctor --fix

# 情况 2：提升角色
# 让 owner（不是 admin —— admin 改不了角色，PUT members 是 owner-only gate）
# 通过 REST 调用提升角色（CLI promote 子命令 v0.10.x 仍未提供 —— v0.9.x / v0.10.x scope chain 都未动 member role 管理；排到 v0.11+ / 未排期）：
NET=$(jq -r .network_id ~/.anet/config.json)
UTOK=$(jq -r .token ~/.anet/config.json)        # owner 自己的 utok_
curl -X PUT "$HUB/api/networks/$NET/members/<your_user_id>" \
  -H "Authorization: Bearer $UTOK" \
  -H "Content-Type: application/json" \
  -d '{"role": "member"}'
# 详见 [API — PUT members](/api/rest#put-api-networks-id-members-user-id)
# 或者：owner 创建新邀请码让你重新加入（拿到目标 role）
anet network invite --role member
```

---

### `license_expired` -- 授权过期（legacy 行为）

```json
{"ok": false, "error": "license_expired", "message": "Trial expired. Activate a license: anet activate <key>"}
```

::: info v0.8 起 anet 完全 Apache-2.0 OSS，没有真正的 license 销售
这条 license gate 是 V3 时代的遗留代码，仍在 `send_task` 路径里跑（verify [`server/src/tools.ts:616`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L616) `license_expired` emit；同文件 L611 `SELECT type, expires_at FROM licenses`），如果你的本地 SQLite 有过期 `licenses` 行就会触发。**v0.9.x / v0.10.x scope 都未动**（Recovery & Observability 主题为先），排到 v0.11+ / 未排期移除整段 license 检查。
:::

**原因**：本地 SQLite `licenses` 表里有一行 `expires_at < now()`。

**解决**：

```bash
# 方案 A（推荐）：直接清掉过期 license 行
sqlite3 ~/.commhub/commhub.db "DELETE FROM licenses WHERE expires_at < datetime('now');"

# 方案 B（legacy 命令，仅占位实现）：
anet license       # 查看
anet activate <key>   # v0.6 legacy 命令，写入新 license row（不验证 key，仅占位）

# 方案 C（离线 tutorial）：起 hub 时加 --dev-open 跳过鉴权（仅本机调试用）
anet hub start --dev-open
# Docker / systemd 场景没法加 CLI flag 时，用 env 变量等效开启：
# COMMHUB_DEV_OPEN=1 anet hub start
# （verify [`server/src/index.ts:13`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L13)：`--dev-open` flag 或 `COMMHUB_DEV_OPEN=1` 二选一即可）
```

---

### `password must be at least 8 characters` / `password is too common` -- 密码强度不达标（v0.8）

```json
{ "ok": false, "error": "password must be at least 8 characters" }
{ "ok": false, "error": "password is too common" }
{ "ok": false, "error": "new password must be at least 8 characters" }   // changePassword
{ "ok": false, "error": "new password is too common" }                   // changePassword
```

verify [`auth.ts:24-28 validatePasswordStrength()`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L24)。`label` 参数让 changePassword 把前缀加成 `new password`。

**原因**：v0.8 起 `register` / `anet passwd` / `anet hub admin reset-user` 都走同一 `validatePasswordStrength()` 校验：
- 长度 ≥ 8 字符
- 不在弱密码字典里（[`password-dict.ts WEAK_PASSWORDS`](https://github.com/sleep2agi/agent-network/blob/main/server/src/password-dict.ts) 含 `"password"` / `"12345678"` / `"qwerty123"` 等 top 弱密码）

**例外（仅 register 首位用户）**：[`auth.ts:43-44`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L43) 检测「首位注册的用户」时只校验 `length >= 4`（让 bootstrap `admin / anethub` 能成立）。`anet passwd` / `reset-user` **无此豁免**，永远强制 ≥ 8 + 非弱密码。

**解决**：

```bash
# 随机生成一个 16 字符强密码
openssl rand -base64 16

# 或用 pwgen
pwgen -s 16 1
```

::: warning 生产部署
任何 `--host 0.0.0.0` 公网部署，首次 admin 设默认 `anethub` 之后**立刻**改强密码：
```bash
anet login --username admin --password anethub
anet passwd                    # 改成强密码
```
:::

---

### 第二次 `anet hub start` 还重新 bootstrap admin？

第一次 `anet hub start` 已经建了 admin，再启动还输出 `Admin account created`？

::: tip bootstrap 是**非交互**的，没有 "Set up admin account" prompt
verify [`agent-network/bin/cli.ts`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts)：`anet hub start` 默认直接 POST `/api/auth/register` username=`admin` password=`anethub`（除非传 `--username` / `--password`）。**没有任何交互 prompt**，所以「反复 prompt」描述是旧 doc，已删。

幂等性靠 `~/.anet/server/admin-utok.json` 作 marker —— 文件在就跳过 register flow（输出 `✅ Admin already exists`），文件丢了就再跑 register（hub 端会因 `username already taken` 而返 `ℹ Admin account "admin" already exists`，不会重建）。
:::

**原因**：`~/.anet/server/admin-utok.json` 被删了 / hub `~/.commhub/commhub.db` 被清了 / 用了不同的 `HOME`（Docker 没挂卷）。

**确认状态**：

```bash
# 1. marker 文件在哪
ls -la ~/.anet/server/admin-utok.json   # 该文件存在 → 下次 start 跳过 register

# 2. hub 端 admin user 在不在
sqlite3 ~/.commhub/commhub.db "SELECT username, role FROM users WHERE role='admin'"
```

**两文件状态 vs `anet hub start` 行为**：

| `admin-utok.json` | `users` 表 admin row | `anet hub start` 输出 |
|---|---|---|
| 存在 | 存在 | `✅ Admin already exists (admin-utok.json found, user=...)` |
| 不存在 | 存在 | `ℹ  Admin account "admin" already exists`（hub 返 `username already taken`） |
| 不存在 | 不存在 | `✅ Admin account created` + `Admin token saved to ~/.anet/server/admin-utok.json` |
| 存在 | 不存在（db 被清） | `✅ Admin already exists` 但 `anet login` 会失败 —— 需 `rm admin-utok.json` 再 `anet hub start` |

**解决**：

```bash
# 状况：admin-utok.json 在但 login 失败
# → marker 跟 db 不同步，删 marker 让下次 start 重建 admin row
rm ~/.anet/server/admin-utok.json
anet hub start                  # 重新走 register flow
anet login --username admin --password anethub
```

---

### 429 速率限制（`too many requests` / `too many attempts`）

```
HTTP 429
{ "ok": false, "error": "too many requests, try again later" }     # register 命中
{ "ok": false, "error": "too many attempts, try again later" }     # login 命中
```

**原因**：同一 IP 在窗口内请求过多。

| 端点 | 限制 | 命中 message |
|------|------|---|
| `POST /api/auth/register` | 30 次/分钟 | `too many requests, try again later` |
| `POST /api/auth/login` | 10 次/分钟 | `too many attempts, try again later`（+ audit `login_rate_limited`） |

::: info v0.8 当前只有这两个 endpoint 做 IP rate limit
其他 endpoint **不做 IP rate limit**（`checkRateLimit` 函数 default=60 仅函数签名 default，[`index.ts` `checkRateLimit()`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts) 实际只在 register/login 两处调；详见 [安全设计 — 速率限制](/concepts/security#速率限制-rate-limiting)）。担心其他端点被写滥用，前置反向代理（nginx / Cloudflare）加 rate limit。
:::

**解决**：等 60 秒后重试。localhost / `::1` / `unknown` IP 免限制（[`index.ts` `checkRateLimit()`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)）。响应**无** `retry_after_seconds` 字段，**无** `Retry-After` header，窗口固定 60 秒。

---

## 任务类错误

### `task not found`

```json
{"ok": false, "error": "task not found"}
```

**原因**：

1. task_id 不正确
2. 任务在另一个网络中（ntok_ 绑定的网络不同）

**解决**：

```bash
# 确认任务存在
anet tasks

# 确认当前网络
anet whoami

# 检查任务详情
curl "http://localhost:9200/api/tasks?limit=10" -H "Authorization: Bearer ntok_xxx"
```

---

### `task status is X, not retryable`

```json
{"ok": false, "error": "task status is running, not retryable"}
```

**原因**：只有 `failed` / `expired` / `cancelled` 状态的任务可以重试。

**解决**：

::: tip
下面的 `cancel_task` / `retry_task` 是 server 端 MCP tool，调用走 REST `POST /mcp`（或 SDK 直连），**不是** Claude Code agent 的 stdio wrapper。channel-wrapper（[`channel/commhub-channel.ts`](https://github.com/sleep2agi/agent-network/blob/main/channel/commhub-channel.ts)）只暴露 5 个 `commhub_*` tool（`commhub_reply` / `commhub_report_status` / `commhub_send_task` / `commhub_send_message` / `commhub_get_all_status`）—— `cancel_task` / `retry_task` / `reassign_task` / `get_inbox` 是管理 / Dashboard 操作，不在 Claude Code chat agent 的 self-service 工具集里（[`commhub-channel.ts:136-203`](https://github.com/sleep2agi/agent-network/blob/main/channel/commhub-channel.ts#L136)）。
:::

```bash
# 先取消正在运行的任务（POST /mcp tool=cancel_task）
cancel_task(task_id="t_xxx", reason="需要重试")

# 然后重试（POST /mcp tool=retry_task）
retry_task(task_id="t_xxx")
```

---

### `task is terminal`

```json
{"ok": false, "error": "task is terminal (replied)"}
```

**原因**：任务已处于终态（replied / failed / cancelled / expired），不能再操作。

**解决**：如果需要重新执行，创建新任务：

```bash
commhub_send_task(alias="代码1号", task="重新执行: ...")
```

---

### `message not found or not yours`

```json
{"ok": false, "error": "message not found or not yours"}
```

**原因**：

1. message_id 不正确
2. 消息不属于当前 Agent（alias 不匹配）
3. 消息在另一个网络中

**解决**：

::: tip
`get_inbox` 是 server 端 MCP tool，调用走 REST `POST /mcp`（或 SDK 直连），**不是** Claude Code agent 的 stdio channel wrapper。channel-wrapper 只暴露 5 个 `commhub_*` tool（`commhub_reply` / `commhub_report_status` / `commhub_send_task` / `commhub_send_message` / `commhub_get_all_status`）；`get_inbox` 故意没在 wrapper 里 —— agent 通过 SSE 自动轮询 inbox，见 [`channel/commhub-channel.ts:136-203`](https://github.com/sleep2agi/agent-network/blob/main/channel/commhub-channel.ts#L136)。
:::

```bash
# 确认 inbox 中的消息（POST /mcp，tool=get_inbox）
get_inbox(alias="代码1号")
```

---

## 网络类错误

### `network name already exists`

```json
{"ok": false, "error": "network name already exists"}
```

**原因**：同一用户已经有同名网络。

**解决**：

```bash
# 查看已有网络
anet network ls

# 使用不同名称
anet network create my-other-network
```

---

### `network has N active session(s)`

```json
{"ok": false, "error": "network has 3 active session(s) — stop them first"}
```

**原因**：删除网络前必须先停止所有 Agent。

**解决**：

```bash
# 查看网络中的 Agent
anet status

# 停止所有 Agent
anet node stop 代码1号
anet node stop 代码2号
anet node stop 代码3号

# 然后删除（必须加 --force，否则只打印确认提示）
anet network delete my-network --force
```

---

### `quota exceeded: max N networks for free plan`

```json
{"ok": false, "error": "quota exceeded: max 2 networks for free plan"}
```

::: warning v0.8 仍 enforced（POST /api/networks，非 admin）
旧版 doc 说「v0.8 起不启用 plan 配额」**不准** —— verify [`auth.ts` `createNetwork()`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts)：仍然按 `users.plan || 'free'` 查 `QUOTAS` 表门控 `network create`。**仅 `users.role='admin'`（首位注册用户）豁免**（`plan = "admin"` 走 `QUOTAS.admin`）。其他用户 `plan='free'` 默认上限 `max_networks_owned=2`（v0.8 没改这个默认值）。跟 [Networks — 配额限制](/concepts/networks#quota-limits) 描述的「未启用 plan 区分」实际指的是 **dashboard 不显示 plan 升级 UI + 没 SaaS 计费**，不是「server 端不再做 quota 检查」。
:::

**触发条件**：non-admin 用户创建了 ≥ `max_networks_owned`（free=2）的网络。

**解决**：

```bash
# 方案 A（推荐）：让 hub 把该用户升 admin（任何已 hub 主机本机权限的 system admin 操作）
# 没有公开 endpoint, 只能 SQLite 直改：
sqlite3 ~/.commhub/commhub.db "UPDATE users SET role = 'admin' WHERE user_id = 'u_xxx';"
# 之后该 user.role='admin' → createNetwork plan='admin' → quota 走 QUOTAS.admin（基本无限）

# 方案 B：直接删多余的 network
anet network ls           # 看哪些可删
anet network delete <old-net> --force
```

::: tip 为什么 `users.plan='admin'` 不够
[`auth.ts:185`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L185) 实际 check 的是 `users.role === 'admin'`，不是 `users.plan`。直接 SQL `UPDATE users SET plan = 'admin'` 不生效；要走 `role` 列才有效（跟 audit log action `password_reset_by_admin` 等 system-admin gate 同款）。
:::

---

## Agent Node 错误

### `Node "代码1号" already exists` -- alias 本地冲突（`anet node create`）

```
Node "代码1号" already exists: .anet/nodes/代码1号/config.json
```

verify [`agent-network/bin/cli.ts`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts) + [`agent-network/bin/cli.ts`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts)：`anet node create` 在交互式 / 非交互式两条路径都用 `resolveNodeRef(id)` 检查本地 `.anet/nodes/<alias>/config.json` 是否已存在；命中就直接 `process.exit(1)` 不连 hub。

**原因**：当前项目目录 `.anet/nodes/` 下已有同名 node config 子目录。这是**本地文件冲突**，跟 hub 端 session 状态无关。

**解决**：

```bash
# 看本地哪些 node 已注册（按 .anet/nodes/ 目录扫）
anet node ls

# 方案 A：换名
anet node create 代码1号-v2

# 方案 B：删旧的再用同名（delete 必须加 --force，否则只打印确认提示不实际删除）
anet node delete 代码1号 --force
anet node create 代码1号
```

::: warning hub 端 alias 冲突是「静默接管」不报错
跟很多人想的不一样，hub server **没有** 「`alias is already taken`」错。如果你在不同机器 / 不同项目 dir 用同一个 alias 跑两个 agent（两条不同 `resume_id`），后启动那条 `report_status` 时会触发 [`server/src/tools.ts:127 DELETE FROM sessions WHERE alias = ?1 AND resume_id != ?2 AND network_id = ?3`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L127) **静默把旧 session 清掉**。旧 agent SSE 连接还在但不再收任务派发，dashboard 里旧那行直接消失。

**所以**：不要把「dashboard 看不到我的 agent」归因为「alias 冲突报错」—— 没有这个错，先排查同 alias 多机重复 start（用 `anet status` 看 `resume_id` 看版本是哪台机器）。
:::

---

### `settingSources` 相关错误

```
TypeError: Cannot read properties of undefined (reading 'settingSources')
```

**原因**：Claude Agent SDK 版本不兼容。

**解决**：

```bash
# 升级 agent-node
npm install -g @sleep2agi/agent-node@latest
```

---

### `ANTHROPIC_BASE_URL` 连接失败

```
Error: Failed to connect to api.minimaxi.com
```

**原因**：MiniMax / 其他兼容 API 地址不正确或网络不通。

**解决**：

```bash
# 检查 API 地址
echo $ANTHROPIC_BASE_URL

# 测试连通性
curl -I $ANTHROPIC_BASE_URL

# 确认 API Key 有效
curl -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" \
  $ANTHROPIC_BASE_URL/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"model":"<minimax-model-id>","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}'
# 把 <minimax-model-id> 替换为你 MiniMax 账号当前可用 model id（查 https://platform.minimaxi.com）
```

### Vendor API auth 失败（401 / `invalid_api_key` / `expired_token` / intern `A02xx` / `user_token_expired`）

agent 日志里出现：

```
[claude] ✗ FATAL: vendor API auth failed (...)
[anet] FATAL: Vendor API auth failed — ...
[anet]        → Refresh INTERN_S1_API_KEY at https://chat.intern-ai.org.cn and re-export it
```

**原因**：上游 vendor LLM API 返回 auth-class 错误（401/403、`invalid_api_key`、`authentication_error`、intern `A02xx` 系列码、OpenAI-compat `expired_token` / `unauthorized` 等）。

**v0.9.2 起 fast-fail 行为**（[#129](https://github.com/sleep2agi/agent-network/issues/129)，verify [`agent-node/src/cli.ts`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts)）：
- agent-node 用 `isAuthError(msg)` 启发式（正则：`(401|403)\b|invalid[_\s]?api[_\s]?key|authentication[_\s]?error|expired[_\s]?token|unauthor(iz|is)ed|A02\d{2}|user[_\s]?token[_\s]?expired`）检测到 auth 错误
- **短路 retry loop**（避免拿同一个坏 key 浪费 backoff window）—— v0.9.1 之前会跑满 3 attempts × 5min 一共 15min 才报错，v0.9.2 起 **<5s** 就 FATAL 返回
- 按 `ANTHROPIC_BASE_URL` 域名匹配出 **vendor-specific remediation hint**：
  - `intern-ai.org.cn` → `https://chat.intern-ai.org.cn`
  - `minimax` → `https://platform.minimaxi.com`
  - `anthropic` → `https://console.anthropic.com/settings/keys`
  - 其他 → generic「Refresh your vendor API key and re-export the ENV var」

**解决**（按 vendor 看 log 里的 URL，然后）：

```bash
# 1. 去 vendor 平台拿新 API key（log 里有 URL）

# 2. 更新 ENV var
export ANTHROPIC_AUTH_TOKEN='<新 key>'

# 3. 重启 agent 让新值生效（agent-node 在启动时读 process.env，不热加载）
anet node stop <alias>
anet node start <alias>

# 4. 如果用 envRef 模式 (推荐, 见 /concepts/security#vendor-凭据存储-envref-模式-v0-9-0):
#    config.json 不动 (它存的是 env var 名), 只需要把新值 export 到 process.env 再重启 agent
```

### Vendor API 超时（fan-out 高并发，#132 retry-with-backoff）

agent 日志里出现：

```
[claude] attempt 1/3 timed out after 300000ms; retry in 4000ms
[claude] attempt 2/3 errored: ...; retry in 8000ms
[claude] ✗ all 3 attempts failed; last: timed out after 300000ms
```

或最终：

```
执行出错: claude-agent-sdk 调用超时 (300s × 3 attempts) — vendor 长时间未响应, 检查 ANTHROPIC_BASE_URL endpoint 或 vendor 负载
```

**原因**：fan-out 高并发场景下（如 [#132 Tier 1](https://github.com/sleep2agi/agent-network/issues/132) 的 30-agent papercope demo），vendor API 单次 latency 从基线 1.57s 拉到 17-37s，请求在 vendor 队列里堆积。

**v0.9.2 起 retry-with-backoff** 行为（verify [`agent-node/src/cli.ts`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts)）：
- 每次 attempt 独立的 abort controller + timeout window（default `CLAUDE_TIMEOUT_MS=300000` 即 300s，[#132 ship](https://github.com/sleep2agi/agent-network/issues/132)）
- transient error / timeout 时 backoff `4s, 8s` + 0-1s jitter（jitter 散开 herd retries 避免一窝蜂打 vendor queue）
- 默认 `CLAUDE_MAX_RETRIES=2`（共 3 attempts 含 initial）—— 设 `0` 退回 v0.9.1 行为（no retry）
- **auth-class 错误不 retry**（fast-fail 见上方）

**调参**：

```bash
# config.json 字段
{
  "flags": {
    "claudeTimeoutMs": 600000,   // 单次超时拉到 600s
    "claudeMaxRetries": 5        // 重试 5 次（最多 6 attempts）
  }
}

# 或者 ENV
CLAUDE_TIMEOUT_MS=600000 CLAUDE_MAX_RETRIES=5 anet node start <alias>
```

仍然 timeout 的话，根本原因常是 vendor 容量不足 → 横向 sharding 到多个 vendor + 错峰（`--stagger` per `anet project up`，[#117](https://github.com/sleep2agi/agent-network/issues/117)）。

### `codex-direct-stdio` opt-in 路径错误（v0.10.0+，仅 `ANET_CODEX_STDIO_DIRECT=1` 时触发）

v0.10.0 [#141](https://github.com/sleep2agi/agent-network/issues/141) 引入的 codex direct stdio JSON-RPC 客户端路径绕开 `@openai/codex-sdk` wrapper —— 错误 surface 更直接（不经 wrapper buffer），但意味着你直接面对 `codex` 二进制 + `codex app-server` 协议。

**1. `Error: spawn codex ENOENT`（启用 opt-in 后立即失败）**

agent-node 找不到 `codex` 二进制 ——「opt-in 路径」**直 spawn**，没有 `@openai/codex-sdk` 兜底。

```bash
# 检查
which codex
# 若空：装一遍
npm install -g @openai/codex

# 或者 npm 全局 bin 不在 PATH 上 —— 参见 runtimes / codex-sdk § 前置 PATH 修复
```

退一步用默认 wrapper 路径（取消 env）：

```bash
unset ANET_CODEX_STDIO_DIRECT
anet node start <codex-node>
```

**2. `codex app-server` 子命令不存在 / `unknown subcommand: app-server`**

`codex app-server` 在老版本 codex CLI 上没有（[#141](https://github.com/sleep2agi/agent-network/issues/141) 验证基线 `codex 0.130.0+`）。升级：

```bash
npm install -g @openai/codex@latest
codex --version  # 期望 ≥ 0.130.0
codex app-server --help  # 应能 print subcommand help, 不报 "unknown subcommand"
```

升不动就回 wrapper：`unset ANET_CODEX_STDIO_DIRECT`。

**3. `JSON-RPC parse error` / `-32600` invalid request**

stdio 协议 mismatch —— 一般来自 codex CLI 比 anet 期望版本旧 / 新（experimental 状态下协议可能 breaking）。复现 + 修：

```bash
# 看协议握手
ANET_CODEX_STDIO_DIRECT=1 LOG_LEVEL=debug anet node start <codex-node> 2>&1 | grep -iE "initialize|protocolVersion|error"

# 若发现 protocolVersion mismatch
npm install -g @openai/codex@latest

# 临时回退用 wrapper：
unset ANET_CODEX_STDIO_DIRECT
```

如果 codex CLI 已经 latest 仍报错，开 issue 带这段 debug 输出 + `codex --version` —— [#141](https://github.com/sleep2agi/agent-network/issues/141) 仍在 preview-feedback 窗口（v0.11.0 计划 default flip），protocol breaking 是已知 risk + mitigation 方向。

### Dashboard agent hover card `process_telemetry` 字段全 `null`（v0.10.0 起 ship，dashboard 0.5.0+）

dashboard `≥ 0.5.0` 的 §3.E hover detail card 期望 agent-node `≥ 2.4.0`（[#142](https://github.com/sleep2agi/agent-network/issues/142) v0.10.0 ship 起 agent 心跳带 `process_telemetry`）+ commhub-server `≥ 0.8.2`（schema align）。三种可能：

- **agent-node 老于 2.4.0**：跑 `anet upgrade` 升级到当前 latest（满足 ≥ 2.4.0 最低要求即可）
- **commhub-server 老于 0.8.2**：升级 server 端（`bunx @sleep2agi/commhub-server@latest`）
- **agent 短期还没心跳**：`process_telemetry` 跟普通 host telemetry 一样需要至少 1 次心跳；新启动节点等 ~15s

verify 真实数据流：

```bash
curl http://localhost:9200/api/server/<host>/agents \
  -H "Authorization: Bearer ntok_xxx" | jq '.agents[0].process_telemetry'
# 期望非 null 的 rss_bytes / cpu_pct / uptime_seconds / in_flight_count
```

### `grok-build-acp` 节点任务挂死 / `session/prompt timed out after 300000ms` / JSON-RPC error 32603

**症状**：用 `grok-build-acp` runtime 创建的节点，CommHub 给它派一个稍长一点（> 5min）的任务，节点不报错也不回复，pane 卡在 `session/prompt` 调用上；agent-node 日志里能看到 `session/prompt timed out after 300000ms` 或 ACP server 回了 JSON-RPC `code: 32603`。

**根因**：agent-node 2.4.8 及以下对 ACP `session/prompt` 写死了 300 s 超时（沿用 codex-sdk wrapper 的旧值），但 grok-build-acp 后端是用户级长任务为主，5 min 是常态偏短。

**修复**：跑 `anet upgrade` 升到当前 latest（该 hotfix 自 `agent-node 2.4.9` / v0.10.13 起，之后版本都带）— 把 `session/prompt` 的 client-side 超时拉宽到 grok 后端的实际工作窗口，本机活体节点 47s / 5min / >10min 的任务都能正常完成。

```bash
# 1. 升级
anet upgrade            # 一键
# 或：npm install -g @sleep2agi/agent-node@latest

# 2. 重启 grok 节点
anet node stop grok-marketing && anet node start grok-marketing

# 3. 验证
anet --version          # agent-node ≥ 2.4.9
```

**真长任务仍超时（视频生成 / 大型 X 搜索）**：当前 latest 的 300 s 默认上限对一些视频或大批量场景仍偏短。用 `flags.grokAcpTimeoutMs`（config）或 `GROK_ACP_TIMEOUT_MS`（env，优先）调大：

```bash
# 临时（启 grok 节点前 export）
GROK_ACP_TIMEOUT_MS=900000 anet node start my-grok
```

```json
// 长期（写进 .anet/nodes/<alias>/config.json）
{
  "runtime": "grok-build-acp",
  "flags": { "grokAcpTimeoutMs": 900000 }
}
```

完整说明见 [runtimes → 长任务超时调整](/guide/runtimes#长任务超时调整-flags-grokacptimeoutms)。

::: warning startup log 以当前 latest 为准
旧版本 agent-node 启动日志**不打** `timeoutMs=<新值>` —— 值会读到但 `anet node start` 输出不一定反映。如果设了仍超时，多半是 config 写错位置或 env 字段名 typo；请先升级到 npm `latest`，再 [开 issue](https://github.com/sleep2agi/agent-network/issues/new) 上报。
:::

**仍卡死**，先排除：grok backend 端 quota 用尽（grok 自己的 `~/.config/grok-build/` log 会有提示）/ 节点 cwd 不在 user workspace 边界内（[#204](https://github.com/sleep2agi/agent-network/issues/204) isolated cwd 边界）/ `grok login` 凭据过期。

### 服务器负载异常 / claude session 越开越卡 / 一堆 zombie bun 占满 CPU

**症状**：服务器（hub 所在机）load average 持续偏高（>10×CPU 核心数），开新 claude / agent session 越来越慢、CommHub MCP 调用偶发超时。`top` 里看到一堆 `bun ... server.ts` 进程一直在跑，看起来"什么也没干"。

**根因**：插件目录 / agent workdir 被改名或删除后，老的 `bun` 子进程仍然死握着已经 `deleted` 状态的 cwd，每开一个新 session 就再 fork 一个 zombie。累积起来吃满 CPU。**生产实测**：86 个 zombie bun，load 92。

**检测**（一行命令）：

```bash
for pid in $(pgrep -f "bun.*server.ts"); do readlink /proc/$pid/cwd; done | grep deleted | wc -l
```

输出 `>5` 就明显异常。看到具体哪些 PID：

```bash
for pid in $(pgrep -f "bun.*server.ts"); do
  cwd=$(readlink /proc/$pid/cwd 2>/dev/null)
  [[ "$cwd" == *deleted* ]] && echo "PID $pid → $cwd"
done
```

**解法**：

```bash
# 杀掉所有 cwd 指向 deleted 目录的 bun 进程
for pid in $(pgrep -f "bun.*server.ts"); do
  cwd=$(readlink /proc/$pid/cwd 2>/dev/null)
  [[ "$cwd" == *deleted* ]] && kill -9 $pid
done

# 或直接全部 pgrep + kill（确保你知道在杀什么）
pkill -9 -f "bun.*server.ts"
```

之后重启所需的 agent / hub 进程即可。

**预防**：改 / 删插件目录或 agent workdir 之前，**先**把对应的 `bun` 子进程 kill 掉（`anet node stop <name>` 或手动 `kill`），再动目录。

---

## Docker 错误

### `service "seed" is not running`

Seed 容器是一次性的，执行完就退出（exit code 0），这是正常的。

```bash
# 检查是否成功
docker compose logs seed
# 应该看到: seed: wrote ntok_ to /shared/ntok
```

---

### Worker 容器反复重启

```bash
# 查看日志找原因
docker compose logs worker-1

# 常见原因：
# 1. Server 还没启动（健康检查未通过）
# 2. ntok_ 不存在（seed 失败）
# 3. Codex 认证缺失（~/.codex 未挂载）
```

---

### `permission denied` in Docker

```
Error: EACCES: permission denied, mkdir '/root/.claude'
```

**解决**：确保 tmpfs 挂载了 `.claude` 目录：

```yaml
tmpfs:
  - /root/.claude
  - /tmp
```

---

## 诊断工具

### anet doctor

全面检查系统状态：

```bash
anet doctor
```

检查项：全局配置 + auth token、hub 连通性（版本 / sessions / SSE）、每个节点配置健康度（旧字段给 `--fix` 迁移提示）、明文密钥卫生（[#125](https://github.com/sleep2agi/agent-network/issues/125)）、必需 CLI（Claude Code / Codex / Bun）。加 `--fix` 自动迁移可修的节点配置 + 重发被 hub 拒的 `ntok_`。

### 手动检查清单

```bash
# 1. Server 健康（含 SSE 连接数 + sessions / license / uptime，无需 auth）
curl http://localhost:9200/health
# 关注字段: ok / version / sessions_count / sse_connections / sse_sessions / uptime
# verify: server/src/index.ts:780-805

# 2. 认证有效 + 看所有 session 状态汇总
curl -H "Authorization: Bearer ntok_xxx" http://localhost:9200/api/status
# 返回 sessions[] 全列 + summary { idle, working, offline, total }
# ⚠ status query param 不生效 — server 端不按 status 过滤（server/src/index.ts:816-843）。
#   要筛 idle agent，本地用 jq： curl ... /api/status | jq '.sessions[] | select(.status=="idle")'

# 3. 数据库大小
ls -lh ~/.commhub/commhub.db

# 4. 任务 / 节点 / session 统计（非 SSE 连接数）
curl -H "Authorization: Bearer ntok_xxx" http://localhost:9200/api/stats
# 返回 tasks { total, by_status } / sessions { by_status } / nodes { total } / recent_tasks[5]
# verify: server/src/index.ts:1022-1058
```

::: tip 全 30+ endpoint 索引
跳 [REST API → 基础信息表](/api/rest) 看完整 endpoint 分类（11 类含 SSE / Tmux opt-in / Legacy 等）。
:::

### 日志级别

Agent Node 支持调整日志级别（**top-level 字段，不在 `flags` 里**）：

```json
// config.json (.anet/nodes/<alias>/config.json)
{
  "logLevel": "debug"   // debug / info / warn / error
}
```

verify [`agent-node/src/cli.ts`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts)：`LOG_LEVEL` 从 `opts["log-level"] || process.env.LOG_LEVEL || fileConfig.logLevel || "info"` 取，**只认 top-level `logLevel`**，写在 `flags.logLevel` 不生效。

也可以走环境变量或命令行：

```bash
LOG_LEVEL=debug anet node start <alias>
# 或
anet node start <alias> --log-level debug
```

## 还有问题？

**先试这几个 v0.8 自动修复工具**：

- `anet doctor` — 探测当前 hub / token / network 状态，问题分级输出
- `anet doctor --fix` — 自动 probe 过期 ntok_ 并重发；agent-node SSE 401 自动 reload
- `anet hub admin reset-user <username>` — 本机 owner 在 Hub 机器强制重置用户密码（忘密码场景）
- `anet passwd` — 交互改密码

**还不行**：

- **GitHub Issues**：[github.com/sleep2agi/agent-network/issues](https://github.com/sleep2agi/agent-network/issues) — 报 bug 或搜已知问题
- **GitHub Discussions**：[discussions](https://github.com/sleep2agi/agent-network/discussions) — 使用问题 / 设计讨论
- **查看源码**：所有错误消息可以在 `server/src/tools.ts` 和 `server/src/auth.ts` 中找到
- **FAQ**：[常见问题](/faq) — 模型选择 / 费用 / 升级注意

## 下一步

- [升级到 v0.8](/guide/upgrade#v0-7-v0-8-升级注意-最新) — 老用户升级路径 + 行为变化
- [安全设计](/concepts/security) — 排查鉴权问题前看一遍
- [架构概览](/guide/architecture) — 出问题时定位是哪一层
- [社区](/community) — 加群和讨论

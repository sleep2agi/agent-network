# 故障排查

按错误信息快速定位问题和解决方案。

## 连接类错误

### `ECONNREFUSED` -- 连接被拒绝

```
Error: connect ECONNREFUSED 127.0.0.1:9200
```

**原因**：CommHub Server 没有运行。

**解决**：

```bash
# 检查 Server 是否在运行
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

**解决**：Agent 会自动重连（指数退避 3s -> 60s），通常无需手动干预。

如果持续失败：

```bash
# 检查 Server 是否在运行
curl http://localhost:9200/health

# 检查 Token 是否有效
curl -H "Authorization: Bearer ntok_xxx" http://localhost:9200/api/status

# 检查反向代理配置（如果有）
# Nginx 需要以下配置：
# proxy_read_timeout 86400;
# proxy_buffering off;
```

---

## 认证类错误

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
# 让 owner（不是 admin —— admin 改不了角色，verify R149 PUT members owner-only gate）
# 通过 REST 调用提升角色（CLI promote 子命令排在 v0.9+）：
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
这条 license gate 是 V3 时代的遗留代码，仍在 `send_task` 路径里跑（`server/src/tools.ts:484`），如果你的本地 SQLite 有过期 `licenses` 行就会触发。**未来 v0.9+ 计划移除整段 license 检查**。
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
# （verify [`server/src/index.ts:12`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L12)：`--dev-open` flag 或 `COMMHUB_DEV_OPEN=1` 二选一即可）
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

**例外（仅 register 首位用户）**：[`auth.ts:43-44`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L43) 检测「首位注册的用户」时只校验 `length >= 4`（让 bootstrap `admin / anethub` 能成立）。`anet passwd` / `reset-user` **无此豁免**，永远强制 ≥ 8 + 非弱密码（跟 R193 chain 一致）。

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
verify [`agent-network/bin/cli.ts:2027-2078`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L2027)：`anet hub start` 默认直接 POST `/api/auth/register` username=`admin` password=`anethub`（除非传 `--username` / `--password`）。**没有任何交互 prompt**，所以「反复 prompt」描述是旧 doc，已删。

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
其他 endpoint **不做 IP rate limit**（`checkRateLimit` 函数 default=60 仅函数签名 default，[`server/src/index.ts:55`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L55) 实际只在 register/login 两处调；详见 R169 修正，[安全设计 — 速率限制](/concepts/security#速率限制-rate-limiting)）。担心其他端点被写滥用，前置反向代理（nginx / Cloudflare）加 rate limit。
:::

**解决**：等 60 秒后重试。localhost / `::1` / `unknown` IP 免限制（[`index.ts:57`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L57)）。响应**无** `retry_after_seconds` 字段，**无** `Retry-After` header，窗口固定 60 秒。

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

# 然后删除
anet network delete my-network
```

---

### `quota exceeded: max N networks for free plan`

```json
{"ok": false, "error": "quota exceeded: max 2 networks for free plan"}
```

::: warning v0.8 仍 enforced（POST /api/networks，非 admin）
旧版 doc 说「v0.8 起不启用 plan 配额」**不准** —— verify [`auth.ts:184-190 createNetwork()`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L184)：仍然按 `users.plan || 'free'` 查 `QUOTAS` 表门控 `network create`。**仅 `users.role='admin'`（首位注册用户）豁免**（`plan = "admin"` 走 `QUOTAS.admin`）。其他用户 `plan='free'` 默认上限 `max_networks_owned=2`（v0.8 没改这个默认值）。跟 [Networks — 配额限制](/concepts/networks#配额限制-v0-6-设计目标-当前未启用) 描述的「未启用 plan 区分」实际指的是 **dashboard 不显示 plan 升级 UI + 没 SaaS 计费**，不是「server 端不再做 quota 检查」。
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
anet network delete <old-net>
```

::: tip 为什么 `users.plan='admin'` 不够
[`auth.ts:185`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L185) 实际 check 的是 `users.role === 'admin'`，不是 `users.plan`。直接 SQL `UPDATE users SET plan = 'admin'` 不生效；要走 `role` 列才有效（跟 R195 audit log action `password_reset_by_admin` 等 system-admin gate 同款）。
:::

---

## Agent Node 错误

### `Node "代码1号" already exists` -- alias 本地冲突（`anet node create`）

```
Node "代码1号" already exists: .anet/nodes/代码1号/config.json
```

verify [`agent-network/bin/cli.ts:1067-1071`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L1067) + [`agent-network/bin/cli.ts:1189-1193`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L1189)：`anet node create` 在交互式 / 非交互式两条路径都用 `resolveNodeRef(id)` 检查本地 `.anet/nodes/<alias>/config.json` 是否已存在；命中就直接 `process.exit(1)` 不连 hub。

**原因**：当前项目目录 `.anet/nodes/` 下已有同名 node config 子目录。这是**本地文件冲突**，跟 hub 端 session 状态无关。

**解决**：

```bash
# 看本地哪些 node 已注册（按 .anet/nodes/ 目录扫）
anet node ls

# 方案 A：换名
anet node create 代码1号-v2

# 方案 B：删旧的再用同名
anet node delete 代码1号
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

### 手动检查清单

```bash
# 1. Server 健康（含 SSE 连接数 + sessions / license / uptime，无需 auth）
curl http://localhost:9200/health
# 关注字段: ok / version / sessions_count / sse_connections / sse_sessions / uptime
# verify: server/src/index.ts:718-733

# 2. 认证有效 + 看所有 session 状态汇总
curl -H "Authorization: Bearer ntok_xxx" http://localhost:9200/api/status
# 返回 sessions[] 全列 + summary { idle, working, offline, total }
# ⚠ status query param 不生效 — server 端不按 status 过滤（server/src/index.ts:750-768）。
#   要筛 idle agent，本地用 jq： curl ... /api/status | jq '.sessions[] | select(.status=="idle")'

# 3. 数据库大小
ls -lh ~/.commhub/commhub.db

# 4. 任务 / 节点 / session 统计（非 SSE 连接数）
curl -H "Authorization: Bearer ntok_xxx" http://localhost:9200/api/stats
# 返回 tasks { total, by_status } / sessions { by_status } / nodes { total } / recent_tasks[5]
# verify: server/src/index.ts:949-985
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

verify [`agent-node/src/cli.ts:187`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts#L187)：`LOG_LEVEL` 从 `opts["log-level"] || process.env.LOG_LEVEL || fileConfig.logLevel || "info"` 取，**只认 top-level `logLevel`**，写在 `flags.logLevel` 不生效。

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

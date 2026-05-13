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

### `401 unauthorized`

```json
{"error": "unauthorized"}
```

**原因**：Token 无效或缺失。

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
```

---

### `password too weak` / `password too short` -- 密码强度不达标（v0.8）

```
Error: password too short (min 8 chars)
Error: password is in the weak-password dictionary
```

**原因**：v0.8 起 `anet passwd` / `register` / `anet hub admin reset-user` 都强制：
- 长度 ≥ 8 字符
- 不在 top-1000 弱密码字典里（"password", "12345678", "qwerty123" 等）

**例外**：首次 `anet hub start` 提示设置 admin 时允许 ≥ 4 字符（让默认 `admin / anethub` 能成立）。

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

### `set up admin account` 反复 prompt（v0.8）

第一次 `anet hub start` 设了 admin 之后，第二次启动还反复让我设？

**原因**：v0.8.0 早期有过这个 bug，已在 v0.8.0 stable 修掉。如果还遇到说明 SQLite db 里没有 admin user 记录。

**解决**：

```bash
# 直接走默认 admin / anethub
anet hub start
# 看到 'Set up admin account (default: admin / anethub):' → 回车

# 或检查 db
sqlite3 ~/.commhub/commhub.db "SELECT username, role FROM users"
```

如果上一步 db 里完全没有 admin 记录，重新 bootstrap：

```bash
anet hub start                  # 自动建 admin / anethub
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
下面的调用走 REST `POST /mcp`，不是 agent 的 stdio wrapper。agent stdio wrapper 只暴露 5 个 tool（`reply` / `report_status` / `send_task` / `send_message` / `get_all_status`）；`cancel` / `retry` / `reassign` / `get_inbox` 属于管理 / Dashboard 操作，不对 agent self-service 开放。
:::

```bash
# 先取消正在运行的任务（POST /mcp，tool=cancel_task）
cancel_task(task_id="t_xxx", reason="需要重试")

# 然后重试（POST /mcp，tool=retry_task）
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
`get_inbox` 是走 REST `POST /mcp` 的管理 / Dashboard 操作，不是 agent stdio wrapper 暴露的 tool。agent stdio wrapper 只暴露 5 个 tool：`reply` / `report_status` / `send_task` / `send_message` / `get_all_status`。
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

### `quota exceeded`（legacy 行为）

```json
{"ok": false, "error": "quota exceeded: max 2 networks for free plan"}
```

::: info v0.8 起不启用 plan 配额
v0.6 时代设计过 Free / Pro / Admin 三档 plan 配额，但 **Apache 2.0 OSS 转向后已不启用**（`users.plan` 字段统一当 admin / unlimited 处理；`anet network create` / `anet node create` 不再做 plan 配额检查）。详见 [Networks — 配额限制](/concepts/networks#配额限制-v0-6-设计目标-当前未启用)。
:::

**触发条件**（少见）：你的 hub 跑在 v0.6 兼容代码路径上，且 SQLite `users.plan` 还是旧的 `free` 值。

**解决**：

```bash
# 方案 A（推荐）：把 plan 改为 admin 让 hub 不再卡配额
sqlite3 ~/.commhub/commhub.db "UPDATE users SET plan = 'admin' WHERE plan = 'free';"

# 方案 B：直接删多余的 network（如果你只是网络数量超了，不需要 plan 升级）
anet network delete old-network
```

---

## Agent Node 错误

### `alias 已被占用`

```
Error: alias "代码1号" is already taken
```

**原因**：同一网络中已有同名 Agent 在运行。

**解决**：

```bash
# 检查在线 Agent
anet status

# 使用不同名称
anet node create 代码1号-v2
anet node start 代码1号-v2

# 或停止旧的 Agent
anet node stop 代码1号
```

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
# 1. Server 健康
curl http://localhost:9200/health

# 2. 认证有效
curl -H "Authorization: Bearer ntok_xxx" http://localhost:9200/api/status

# 3. Agent 在线
curl -H "Authorization: Bearer ntok_xxx" "http://localhost:9200/api/status?status=idle"

# 4. 数据库大小
ls -lh ~/.commhub/commhub.db

# 5. SSE 连接数
curl -H "Authorization: Bearer ntok_xxx" http://localhost:9200/api/stats
```

### 日志级别

Agent Node 支持调整日志级别：

```json
// config.json
{
  "flags": {
    "logLevel": "debug"  // debug / info / warn / error
  }
}
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

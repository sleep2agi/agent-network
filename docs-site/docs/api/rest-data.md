# REST API：数据查询、任务与实时推送

本页是 [REST API 参考](/api/rest) 的一部分：读取状态、派发任务、MCP 端点和 SSE 事件流。基础约定（地址、认证、错误格式）见[总览](/api/rest)。

## 数据查询端点

### GET /api/status


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

获取所有 session 状态。

```bash
curl "http://localhost:9200/api/status?network_id=net_xxx" \
  -H "Authorization: Bearer ntok_xxx"
```

**查询参数**：

| 参数 | 说明 |
|------|------|
| `network_id` | 按网络过滤（绑了 `ntok_` 时此参数被强制覆盖为 token 自带的 network）|
| `status` | 按状态过滤（idle / working / offline） |

**响应**：

```json
{
  "ok": true,
  "sessions": [
    {
      "resume_id": "sdk-n_xxx",
      "alias": "代码1号",
      "status": "idle",
      "agent": "agent-node:codex-sdk",
      "model": "your-model-id",
      "task": null,
      "progress": null,
      "last_seen_at": "2026-04-12 10:00:00"
    }
  ],
  "summary": {
    "idle": 7,
    "working": 1,
    "offline": 2,
    "total": 10
  }
}
```

`summary` 字段是按 status 聚合的计数（[`server/src/server.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)）：`working` 类把 `working / blocked / error / waiting_input / running / busy` 都归一进去；`offline` 类是 server 端 `updated_at` 落后 10 分钟的 session（每次 GET 实时计算并写回 DB）；其他算 `idle`。

---

### GET /api/tasks


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

获取任务列表。

```bash
curl "http://localhost:9200/api/tasks?status=running&limit=10" \
  -H "Authorization: Bearer ntok_xxx"
```

**查询参数**：

| 参数 | 说明 |
|------|------|
| `network_id` | 按网络过滤（绑了 `ntok_` 时此参数被强制覆盖为 token 自带的 network）|
| `status` | 按状态过滤；任何 [Task 生命周期状态机](/concepts/task-lifecycle#状态说明) 状态都可传 |
| `to_name` | 按接收者过滤 |
| `from_name` | 按发送者过滤 |
| `limit` | 最大条数（默认 50） |

**响应**：

```json
{
  "ok": true,
  "tasks": [
    {
      "task_id": "t_a1b2c3d4",
      "from_node_id": null,
      "from_name": "指挥室",
      "to_node_id": "node_xxx",
      "to_name": "代码1号",
      "priority": "normal",
      "status": "replied",
      "content": "写一个 Python 快排算法",
      "result": "已完成，使用快排实现",
      "in_reply_to": null,
      "requires_response": "reply",
      "scope": "single",
      "created_at": "2026-04-12 10:00:00",
      "delivered_at": "2026-04-12 10:00:01",
      "started_at": "2026-04-12 10:00:02",
      "runtime_submitted_at": "2026-04-12 10:00:03",
      "consumed_at": "2026-04-12 10:00:04",
      "completed_at": "2026-04-12 10:00:15",
      "expires_at": "2026-04-12 11:00:00"
    }
  ],
  "count": 1,
  "stats": [
    { "status": "replied", "count": 85 },
    { "status": "running", "count": 5 }
  ]
}
```

字段对照 `tasks` 表 schema ([`server/src/db.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/db.ts))：主键是 `task_id` 不是 `message_id`；任务完成时间字段是 `completed_at` 不是 `replied_at`；TTL 字段是 `expires_at` 绝对时间不是 `ttl_seconds` 相对秒（`ttl_seconds` 仅 send_task **入参**用，写入时算成 `expires_at`）。`runtime_submitted_at` / `consumed_at` 是 token-bound agent-node 写入的两级运行时证据，和入队 `delivered_at`、进程 ACK、兼容 `started_at` 不同；详见 [Task 生命周期](/concepts/task-lifecycle#runtime_submitted_at-与-consumed_at两级运行时证据)。`anet tasks` CLI 用 `from_name` / `to_name` / `status` / `created_at` / `content` 渲染表格。

---

### GET /api/task/{task_id}


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

按 `task_id` 取**单个任务**的完整记录。路径同时接受 `/api/task/<id>` 与 `/api/tasks/<id>`（末尾 `s` 可选）。

```bash
curl http://localhost:9200/api/task/<task_id> \
  -H "Authorization: Bearer ntok_xxx"
```

**路径参数**：

| 参数 | 说明 |
|------|------|
| `task_id` | 任务 ID（URL 编码）；绑定 `ntok_` 时结果被强制限定在 token 自带的 network |

**响应（200）**：`task` 为 `tasks` 表整行（`SELECT *`，字段同上 [GET /api/tasks](#get-api-tasks)）。

```json
{
  "ok": true,
  "task": { "task_id": "...", "status": "replied", "from_name": "...", "to_name": "...", "content": "...", "created_at": "...", "completed_at": "..." }
}
```

**未找到（404）**：

```json
{ "ok": false, "error": "task_not_found", "task_id": "<task_id>" }
```

---

### GET /api/nodes


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

获取节点列表（持久化节点信息，区别于 session 的临时状态）。

```bash
curl http://localhost:9200/api/nodes \
  -H "Authorization: Bearer ntok_xxx"
```

**查询参数**：

| 参数 | 说明 |
|------|------|
| `node_id` | 按节点 ID 过滤 |
| `alias` | 按别名过滤 |
| `network_id` | 按网络过滤（ntok_ 强制 binding 时此参数被覆盖） |

**响应**：

```json
{
  "ok": true,
  "nodes": [
    {
      "node_id": "node_abc123",
      "node_name": "代码1号",
      "alias": "代码1号",
      "runtime": "claude-agent-sdk",
      "model": "your-model-id",
      "config_path": ".anet/nodes/代码1号/config.json",
      "channels": null,
      "server": "http://localhost:9200",
      "hostname": "dev-machine",
      "network_id": "net_xxxxx",
      "created_at": "2026-04-12 10:00:00",
      "updated_at": "2026-04-12 10:00:00"
    }
  ],
  "count": 1
}
```

::: info nodes vs sessions
`nodes` 表是**持久节点身份**（创建即写入，删 agent 才删），`sessions` 表是**运行时心跳状态**（agent 启动写入，10 分钟无心跳标 `offline`）。看 agent 是否在线用 [GET /api/status](#get-api-status)，看 agent 配置元数据用本 endpoint。
:::

---

### GET /api/host-supervisors

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts) · RFC-026 §9.2.2 / #338

列出本网络里的 **host_supervisor daemon**（`anet daemon` 起的那种节点）。这是 `list_host_supervisors` **MCP 工具的 REST 镜像**，给不走 MCP 的调用方用（Dashboard 的「建节点向导」选服务器就是读它）。

```bash
curl "http://localhost:9200/api/host-supervisors" \
  -H "Authorization: Bearer utok_xxx"
```

**网络怎么定**（不用传 `network_id`）：

| 情况 | 行为 |
|---|---|
| ntok 绑定了网络，或已显式指定并验证过访问权 | 用那个网络 |
| utok 用户**只属于 1 个**网络 | 用那个网络（安全的无歧义兜底） |
| 用户属于 **0 个或 ≥2 个**网络 | **400，不猜** |

🔴 **属于多个网络时不会替你挑一个** —— 返回 400，并用两个不同的 error 把原因分开，客户端据此可以恢复（显式带上 `network_id` 再来一次）：

| 状态 | 响应 | 何时 |
|---|---|---|
| 400 | `{"ok":false,"error":"network_id_required_multi","memberships":N}` | 属于 N ≥ 2 个网络 |
| 400 | `{"ok":false,"error":"missing_network_id","memberships":0}` | 没有可访问的网络 |

**响应**：

```json
{
  "ok": true,
  "daemons": [
    {
      "daemon_node_id": "node_daemon_xxxxx",
      "alias": "daemon",
      "hostname": "build-1",
      "online": true,
      "last_seen_at": "2026-08-30 10:00:00",
      "runtimes_supported": ["claude-agent-sdk", "codex-sdk", "grok-build-acp"],
      "allowed_secret_keys": [],
      "host_telemetry": {
        "alert_level": "green",
        "cpu_cores": 8,
        "mem_gb": 16,
        "ip_internal": "10.x.x.x"
      },
      "can_create_nodes": true
    }
  ],
  "count": 1
}
```

🔴 **`host_telemetry` 按角色遮蔽**：所有人都能看到 `alert_level`（`green` = 在线 / `gray` = 不在线）；**只有该网络的 `admin` / `owner`（或用 network token 调用）**才拿得到 `cpu_cores` / `mem_gb` / `ip_internal`。普通成员看到的 `host_telemetry` 里**只有 `alert_level`**，不是这些字段为 null。

🔴 **`can_create_nodes` / `create_nodes_blocked_reason`（daemon 建节点能力）**：daemon 通过 `report_status.host.daemon_capabilities` 上报，hub 原样镜像进这里 —— Dashboard「建节点向导」据此决定某台服务器能不能选、不能选时给出原因（`create_nodes_blocked_reason` 仅在 `can_create_nodes===false` 时出现）。
🔴 **只有 daemon 真的上报了才带这两个键**：agent-node 版本较旧、尚未上报 `daemon_capabilities` 的 daemon，响应里这两个键**整个缺席**（不是 `false`）。消费方必须把「键缺席」当作「未知、按可建处理」，**不能**把缺席当成 blocked 而误灰掉一台健康的老 daemon（`undefined ≠ false`）。

🔴 **`online` 的窗口是 5 分钟**，不是心跳周期本身。agent-node 的 `report_status` 每 **3 分钟**一次，窗口必须大于它 —— 否则每次心跳之后的 60~180 秒必然抖成 `offline`。

**只列"还有活 token"的 daemon**：SQL 里的 `EXISTS` 子查询要求存在未吊销的 `node:<alias>` token。吊销过（或行已被删）的不会出现；同一个 daemon 轮换过 token 也只出现一次。

**网络作用域**：走 REST auth pipeline 的 `restScope`（SEC-1）。


---

### DELETE /api/nodes/:ref

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

删除节点（hub server 端）—— 从 `nodes` 表删持久身份 + 从 `sessions` 表删运行时心跳记录（同一个 transaction），并向 alias channel 推 `node_deleted` SSE 事件。配套 PR #86「node delete cascade and node_deleted SSE」。

```bash
# :ref 接受 node_id / node_name / alias 任一（URL-encoded）
curl -X DELETE "http://localhost:9200/api/nodes/n_abc12345" \
  -H "Authorization: Bearer ntok_xxx"

# 中文 alias 要 URL-encode
curl -X DELETE "http://localhost:9200/api/nodes/%E4%BB%A3%E7%A0%811%E5%8F%B7" \
  -H "Authorization: Bearer ntok_xxx"
```

**路径参数**：`:ref` 在 server 端 [`server/src/server.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts) 用 OR 拼 `node_id = ? OR node_name = ? OR alias = ?` 找节点（网络作用域过滤后取 `updated_at DESC` 第一条）。

**响应**（成功，200）：

```json
{
  "ok": true,
  "deleted": true,
  "node_id": "n_abc12345",
  "node_name": "代码1号",
  "alias": "代码1号",
  "network_id": "net_xxxxx"
}
```

**SSE 副作用**：删完只向 `alias` 自身的 SSE channel 推 `node_deleted` event（如果还有订阅者）。当前 handler 没有向 network/user channel 再推一份；客户端不能依赖第二条删除广播。

```json
// node_deleted SSE event payload
{ "type": "node_deleted", "node_id": "n_abc12345", "node_name": "代码1号", "alias": "代码1号", "network_id": "net_xxxxx" }
```

**错误响应**：

| 状态 | `error` 值 | 触发条件 |
|------|------------|----------|
| 404 | `node not found` | `:ref` 在当前网络作用域内匹配不到 nodes 行 |
| 403 | `permission_denied` | 调用方在该 network 是 `viewer`，或 `ntok_` 锁定的不是这个 network |

**网络作用域**：跟 `GET /api/nodes` 一致 —— `ntok_` 锁 token 的 network；`utok_` 看到有权限的所有 networks 里的节点。

::: warning 跟 `anet node delete` 不一样
这个 REST endpoint 只删 hub server 端的 `nodes` / `sessions` 行；**不**删本地 `.anet/nodes/<alias>/` 配置目录，也**不**自动撤销 `ntok_`。从 hub 端清节点身份用本 endpoint；从 client CLI 一站式清干净（含本地 dir + tmux + 可选撤销 ntok_）用 `anet node delete <alias>`（详见 [CLI — `anet node delete`](/guide/cli#agent-node-管理)）。
:::

---

### PUT /api/nodes/:ref/avatar

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

设置或清除某个节点的自定义头像（#462）。**不走 RFC-024 的 config-apply 流水线**——头像是纯展示属性，不参与节点配置的版本协商。

```bash
# 设置头像
curl -X PUT "http://localhost:9200/api/nodes/n_abc12345/avatar" \
  -H "Authorization: Bearer ntok_xxx" \
  -H "Content-Type: application/json" \
  -d '{"avatar_url": "https://example.com/a.png"}'

# 清除头像（传 null 或空串）
curl -X PUT "http://localhost:9200/api/nodes/n_abc12345/avatar" \
  -H "Authorization: Bearer ntok_xxx" \
  -H "Content-Type: application/json" \
  -d '{"avatar_url": null}'
```

**路径参数**：`:ref` 与 `DELETE /api/nodes/:ref` 同规则，接受 `node_id` / `node_name` / `alias`（中文 alias 需 URL-encode），并做网络作用域过滤。

**权限**：与节点删除同一道门——需要该网络中**高于 `viewer`** 的成员角色，或 admin。master token 用不了（`requireAuth` 对任何非 GET 的 `/api/` 请求 401）。

**响应**（成功，200）：

```json
{
  "ok": true,
  "node_id": "n_abc12345",
  "alias": "代码1号",
  "avatar_url": "https://example.com/a.png"
}
```

**响应**（校验失败，400）：

```json
{ "ok": false, "error": "invalid_avatar_url", "reason": "avatar_url protocol must be http or https" }
```

#### 校验规则（[`avatar-validate.ts` ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/avatar-validate.ts)）

该函数是一条 **XSS 信任边界**——存进去的值最终会落到 dashboard 的 `<img src>`。规则按顺序：

| 检查 | 行为 |
|------|------|
| `null` / 空串 | 通过，存 `null`（即清除头像） |
| 非字符串 | 拒绝 |
| 长度 > 2048 | 拒绝 |
| 含空白或控制字符 | 拒绝（**在 `new URL()` 之前**做，因此 `java\tscript:` / `java\nscript:` 这类靠控制字符绕过 scheme 检查的写法会被挡住） |
| 非绝对 URL | 拒绝 |
| 协议不是 `http:` / `https:` | 拒绝（挡掉 `javascript:` / `data:` / `vbscript:` / `file:` / `blob:`） |
| 含内嵌凭证（`https://user:pass@host/…`） | 拒绝（**不静默剥离**——调用方应当知道自己传了带密码的 URL） |

**存的是规范化后的值（`URL.href`），不是原始输入。** 例如 `https://e.com/a".png` 会被存成 `https://e.com/a%22.png`，`<` `>` 反引号同理百分号编码。这样即使渲染端把它拼进 HTML 字符串而不是设 `.src`，也无法闭合属性。

> **服务端不会去 fetch 这个 URL**，所以没有服务端 SSRF。但残余风险仍在：任何有写权限的成员都能让所有看 dashboard 的人的浏览器去请求任意主机（暴露访问者 IP / Referer、可做追踪像素、可从访问者机器探测内网地址）。头像功能的这个取舍是明确接受的。

**读取**：`GET /api/nodes` 的返回里已加上 `avatar_url` 字段（未设置时为 `null`）。

---


### GET /api/servers

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

按**物理服务器**（`hostname` + `ip`）聚合 agent 列表 + host 实时遥测，给 dashboard 「服务器侧栏」用。Refs [issue #119](https://github.com/sleep2agi/agent-network/issues/119)。

```bash
curl http://localhost:9200/api/servers \
  -H "Authorization: Bearer ntok_xxx"
```

**返回前的副作用**：跟 `/api/status` 一样，先把 10 分钟以上没心跳的 session 标 `offline`（`UPDATE sessions SET status='offline' WHERE updated_at < cutoff`），再做聚合。所以本 endpoint 的 `agent_count` 反映**所有 session**（不限 status）；要排除 offline 自己在客户端过滤 `last_seen` 即可。

**响应**：注意是**裸数组**，不是 `{ ok: true, ... }` 包裹（跟同文件其他 endpoint 不同，是历史选择）。

```json
[
  {
    "hostname": "dev-machine",
    "ip": "192.168.1.42",
    "agent_count": 7,
    "cpu_load_1min": 0.42,
    "cpu_cores": 8,
    "mem_avail_gb": 12.3,
    "mem_used_gb": 19.7,
    "last_seen": "2026-05-15 11:23:45"
  }
]
```

| 字段 | 来源 | 说明 |
|------|------|------|
| `hostname` | agent-node `os.hostname()` | 没 telemetry 的老 agent 显示 `"unknown"` |
| `ip` | agent-node 首个 non-internal IPv4 | 没 telemetry 显示 `"unknown"` |
| `agent_count` | server 聚合时 `+1` | 该 host 上的 session 总数（含 offline） |
| `cpu_load_1min` | Linux `/proc/loadavg`；macOS/Win `os.loadavg()`（Windows 永远 `[0,0,0]` 主动转 `null`） | 同 hostname+ip 取**最新**那条 |
| `cpu_cores` | `os.cpus().length` | 同上 |
| `mem_avail_gb` | Linux `/proc/meminfo` MemAvailable；macOS/Win `os.freemem()` | GB, 0.1 精度 |
| `mem_used_gb` | `mem_total - mem_avail` | GB, 0.1 精度 |
| `last_seen` | `COALESCE(last_seen_at, updated_at)` | 该 host 下最新心跳时间 |

**网络作用域**：跟 `/api/status` 一样走 `addNetworkScope` —— `ntok_` 强制锁定该 token 的 network，`utok_` 看到自己有权限的所有 networks。

::: info 数据来源
host telemetry 由 agent-node 在每次 `report_status` 时带上（[issue #119](https://github.com/sleep2agi/agent-network/issues/119) step 1，agent-node v2.3.8+）。老 agent 不带 telemetry 字段时 SQL `NULL`，`hostname`/`ip` 渲染成 `"unknown"`、其他字段为 `null`。server 端 schema 是 silent-drop unknown keys，可以独立升级 agent / server。
:::

---

### GET /api/server/:host/health

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts) · v0.10.0 / `commhub-server@0.8.2`

取**单台物理服务器**的当前健康快照 + 24h 分桶历史 telemetry。Refs [issue #99](https://github.com/sleep2agi/agent-network/issues/99)（守护节点 Phase 1 scaffold）。

::: tip 需要 `agent-network@2.2.1+`
通过 `anet hub start` 默认路径要拿到这个 endpoint，**agent-network 必须 ≥ 2.2.1**（v0.10.1 hotfix [`PINNED_SERVER_VERSION`](/changelog#v0-10-1-—-hotfix-pinned-server-version-跟-v0-10-0-ship-chain-bump-2026-05-17-✅-stable) `0.8.0` → `0.8.2`）。老版本（含 2.2.0）`anet hub start` 仍跑 `commhub-server@0.8.0`，本 endpoint 不存在 → **404**。绕开方案：手动 `bunx --bun @sleep2agi/commhub-server@latest --host 127.0.0.1` 起新版 server。
:::

```bash
curl http://localhost:9200/api/server/dev-machine/health \
  -H "Authorization: Bearer ntok_xxx"

# host 含特殊字符（如 IP `192.168.1.42` 不用 encode；hostname 含空格 / `/` 需 urlencode）
curl "http://localhost:9200/api/server/$(python3 -c 'import urllib.parse; print(urllib.parse.quote("my host"))')/health" \
  -H "Authorization: Bearer ntok_xxx"
```

**路径参数**：

| 参数 | 说明 |
|------|------|
| `:host` | `hostname` 或 `ip`（任一匹配即可，URL-encoded）|

**返回前的副作用**：跟 `/api/servers` 一样先把 10 分钟无心跳 session 标 `offline`，再做查询。

**响应**：

```json
{
  "ok": true,
  "host": "dev-machine",
  "hostname": "dev-machine",
  "ip": "192.168.1.42",
  "agent_count": 7,
  "alert_level": "green",
  "alerts": [],
  "latest": {
    "cpu_load_1min": 0.42,
    "cpu_cores": 8,
    "cpu_pct": 5.3,
    "mem_total_gb": 32.0,
    "mem_used_gb": 19.7,
    "mem_avail_gb": 12.3,
    "disk_total_gb": 500.0,
    "disk_used_gb": 213.5,
    "disk_avail_gb": 286.5,
    "last_seen": "2026-05-16 18:23:45"
  },
  "history": {
    "5m":  [{ "ts": "...", "cpu_pct": 5.1, "mem_used_gb": 19.5, ... }, ...],
    "1h":  [{ "ts": "...", "cpu_pct": 4.8, "mem_used_gb": 18.9, ... }, ...],
    "24h": [{ "ts": "...", "cpu_pct": 4.2, "mem_used_gb": 17.6, ... }, ...]
  }
}
```

| 字段 | 说明 |
|------|------|
| `host` | 请求路径里传入的 host 值 |
| `agent_count` | 该 host 上活跃 session 数（窗口取最新一行的 `COUNT(*) OVER ()`）|
| `alert_level` | `green` / `yellow` / `red`（取 `serverAlertLevel(latest)` 计算；`disk_avail_gb < 1 → red` / `< 5 → yellow`）|
| `alerts` | 当前命中告警列表，`alert_level != green` 时非空 |
| `latest` | 该 host 最近一次心跳的瞬时 telemetry（CPU / mem / disk + `last_seen`）|
| `latest.disk_total_gb` / `disk_used_gb` / `disk_avail_gb` | **v0.10.2 起**（agent-node `2.4.1+`，[`host-telemetry.ts readDiskStats()`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/host-telemetry.ts)）—— 通过 `execFileSync('df', ['-k', '/'])` 采样，POSIX `-k` Linux + macOS 同 parse 路径；Windows / 解析失败 graceful `null`（dashboard 渲染 `—` 不误导成 0）。老 agent (`< 2.4.1`) 不带字段时三字段都 `null` |
| `history.5m` | 最近 5min，**1 min bucket**（取自 `agent_telemetry` 历史表）|
| `history.1h` | 最近 1h，**5 min bucket** |
| `history.24h` | 最近 24h，**1 hour bucket**；v0.10.2 起 bucket 内附 `disk_avail_min` / `disk_used_max` 字段（极值聚合，verify [`server/src/server.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)）|

**404**：`{ "ok": false, "error": "server not found" }` —— 该 host 没有任何（活跃或离线）session 命中。

**网络作用域**：同 `/api/servers`，`ntok_` 锁 token network；`utok_` 看所有有权限 networks。

---

### GET /api/server/:host/agents

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts) · v0.10.0 / `commhub-server@0.8.2`

取**单台服务器上的 agent 列表** + per-agent 进程 telemetry（rss / cpu / uptime / in-flight count）。Refs [issue #99](https://github.com/sleep2agi/agent-network/issues/99) + [issue #142](https://github.com/sleep2agi/agent-network/issues/142) per-agent process telemetry。

```bash
curl http://localhost:9200/api/server/dev-machine/agents \
  -H "Authorization: Bearer ntok_xxx"
```

**响应**：

```json
{
  "ok": true,
  "host": "dev-machine",
  "agent_count": 2,
  "agents": [
    {
      "alias": "代码1号",
      "runtime": "claude-code-cli",
      "raw_agent": "claude-code-cli",
      "model": null,
      "status": "idle",
      "task": null,
      "progress": 0,
      "last_seen": "2026-05-16 18:23:45",
      "health": "online",
      "hostname": "dev-machine",
      "ip": "192.168.1.42",
      "telemetry": {
        "cpu_load_1min": 0.42, "cpu_cores": 8, "cpu_pct": 5.3,
        "mem_total_gb": 32.0, "mem_used_gb": 19.7, "mem_avail_gb": 12.3,
        "disk_total_gb": 500.0, "disk_used_gb": 213.5, "disk_avail_gb": 286.5,
        "process_rss_bytes": 245678912, "process_rss_mb": 234.3,
        "process_cpu_pct": 3.1, "process_uptime_seconds": 1842,
        "process_in_flight_count": 0
      },
      "process_telemetry": {
        "rss_bytes": 245678912, "rss_mb": 234.3,
        "cpu_pct": 3.1, "uptime_seconds": 1842, "in_flight_count": 0
      }
    }
  ]
}
```

| 字段 | 说明 |
|------|------|
| `agents[].runtime` | `normalizeRuntime(agent)` 归一化后的 runtime ID（`claude-code-cli` / `claude-agent-sdk` / `codex-sdk`）|
| `agents[].raw_agent` | 原 `agent` 字段（未归一化），方便排查 |
| `agents[].health` | `agentHealthChip(status, last_seen)` 健康灯（`online` / `idle` / `offline` / 等）|
| `agents[].telemetry` | 该 agent 心跳带上的 host-level + process-level 完整 telemetry（reading-friendly 视图）|
| `agents[].process_telemetry` | per-agent 进程 telemetry（`rss_bytes` / `rss_mb` / `cpu_pct` / `uptime_seconds` / `in_flight_count`，[issue #142](https://github.com/sleep2agi/agent-network/issues/142) ship in `agent-node@2.4.0`，server schema align in `commhub-server@0.8.2`）|

**404**：`{ "ok": false, "error": "server not found" }` —— 该 host 没匹配到任何 session。

**网络作用域**：同 `/api/server/:host/health`。

---

### GET /api/messages


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

获取最近 inbox 消息列表。

```bash
curl "http://localhost:9200/api/messages?limit=100" \
  -H "Authorization: Bearer ntok_xxx"
```

**查询参数**：

| 参数 | 说明 |
|------|------|
| `since` | 起始时间，默认最近 1 小时 |
| `limit` | 最大条数，默认 100，最大 500 |

**响应**：

```json
{
  "ok": true,
  "messages": [
    {
      "id": "m_abc123",
      "from_alias": "代码1号",
      "to_alias": "指挥室",
      "type": "reply",
      "priority": "normal",
      "content": "[代码1号] 已完成，使用快排实现",
      "created_at": "2026-04-12 10:00:15",
      "network_id": "net_xxxxx"
    },
    {
      "id": "m_def456",
      "from_alias": "指挥室",
      "to_alias": "代码1号",
      "type": "task",
      "priority": "normal",
      "content": "写一个快排算法",
      "created_at": "2026-04-12 10:00:00",
      "network_id": "net_xxxxx"
    }
  ]
}
```

字段对照 server SELECT ([`server/src/server.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)) `id, session_name as to_alias, from_session as from_alias, type, priority, content, created_at, network_id` —— 主键字段是 `id` 不是 `message_id`，含 `priority` + `network_id` 两个之前 doc 漏掉的字段。

::: info 当前 schema 限制
SELECT 暂未包含 `in_reply_to` 字段；轮询匹配回复消息时按 `from_alias` + `type='reply'` + recency 启发式匹配（详见 `cli.ts` 注释）。
:::

---

### GET /api/messages?scope=user

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts) · 自 `@sleep2agi/commhub-server` `0.9.0-preview.41` 起

**按用户读的收件箱**，与上面那节按 alias 寻址的分支是两条路：上面那条给 Dashboard 读全网 inbox，这条给**某个人**读自己的私信（桌面端未读角标的数据源）。

```bash
curl "http://localhost:9200/api/messages?scope=user&unacked=1&limit=50" \
  -H "Authorization: Bearer utok_xxx"
```

🔴 **收件人取自鉴权上下文，不接受 query 指定。** 传 `?user_id=<别人>` **不会生效** —— 否则任何人都能读走别人的私信。没有用户上下文时返回 **401** `{"ok":false,"error":"auth_required"}`。

**查询参数**：

| 参数 | 说明 |
|------|------|
| `scope=user` | **必须**，否则走上面那条按 alias 的分支 |
| `unacked=1` | 只返回未 ack 的（**严格等于 `1`** 才生效） |
| `limit` | 最大条数，默认 100，最大 500 |

**响应**：

```json
{
  "ok": true,
  "messages": [
    {
      "message_id": "dm_abc123",
      "network_id": "net_xxxxx",
      "user_id": "u_xxxxx",
      "from_session": "代码1号",
      "kind": "dm",
      "title": "构建失败",
      "content": "……",
      "severity": "info",
      "meta_json": null,
      "acked": 0,
      "created_at": "2026-08-30 10:00:00",
      "acked_at": null
    }
  ],
  "unread": 3,
  "pending_count": 3,
  "unread_by_agent": { "代码1号": 2, "代码2号": 3 },
  "unread_total": 5
}
```

**`unread_by_agent` / `unread_total`(#1828)**:按 `from_session` 分的未读数,来源是**两张表**——`user_inbox`(agent 主动发给用户的,acked=0)加 `inbox` 里 `session_name = 你的用户名`、`type ∈ reply/task/message`、acked=0 的行(agent 对你任务的回复;这些行原本没人 ack)。`unread_total` 是两者之和。客户端角标应优先读 `unread_by_agent`。🔴 你的用户名恰好也是本 scope 内某个节点的 alias 时,`inbox` 那半边**整体不算**(那些行是节点的待办,不是你的)。

🔴 **`unread` 与 `pending_count` 恒等** —— 是**同一个数的两个名字**（`unread` 给角标读，`pending_count` 与上面 alias 分支的字段名保持一致），**一处计算**，不是两处实现。**不要拿它们互相比对**去判断状态。

字段对照 server SELECT：`message_id, network_id, user_id, from_session, kind, title, content, severity, meta_json, acked, created_at, acked_at`，按 `created_at DESC` 排序。主键是 **`message_id`**（不是上面那节的 `id`）。

**数据源**：`user_inbox` 表，主键 `message_id`（同一条 send 重投是幂等的），索引 `idx_user_inbox_user_acked(user_id, acked, created_at)`。

**网络作用域**：与 alias 分支复用同一个 `addNetworkScope` 助手 —— 列表与未读数用**同一个 `user_id` + 同一个 scope 助手**计算，避免两处口径漂开。

::: danger 回读脱敏（redact-at-read）
写入方是 agent，**不受信任**。回读时对 `content` / `title` / `meta_json` 做凭据形状遮蔽，**存储侧留原文**：

| 形状 | 说明 |
|---|---|
| `(ntok_\|utok_\|atok_)[A-Za-z0-9_-]{6,}` | 本仓自己的 token |
| `(github_pat_)[A-Za-z0-9_]{20,}` | GitHub fine-grained PAT |
| `(ghp_)[A-Za-z0-9]{20,}` | GitHub classic PAT |
| `(xox[bpoars]-)[A-Za-z0-9-]{10,}` | Slack |
| `(sk-)[A-Za-z0-9_-]{16,}` | OpenAI 风格 |

替换成 `<前缀>***redacted***` —— **保留前缀**，让读者知道被遮的是哪一类凭据。
:::

---

### GET /api/node-create-requests

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

读一条 `create_node` 请求的结果 —— daemon 通过 `ack_create_request` 写回的 `status` / `error`。桌面向导用它把「子节点起不来」的原因显示出来,而不是只等注册超时。

```bash
curl "http://localhost:9200/api/node-create-requests?request_id=cr_59723b24-…" \
  -H "Authorization: Bearer utok_xxx"
```

**响应**:`{"ok":true,"request":{"request_id","daemon_node_id","child_name","network_id","runtime","model","status","error","created_at","delivered_at","acked_at"}}`。`status` ∈ `pending` / `delivered` / `started` / `failed` / `rejected` / `runtime_capability_check_failed`;`error` 是 daemon 回的原文(最长 1000 字),没有则 `null`。

| 状态 | 响应 | 何时 |
|---|---|---|
| 401 | `{"ok":false,"error":"auth_required"}` | 没有用户上下文 |
| 400 | `{"ok":false,"error":"request_id_required"}` | 缺 `request_id` |
| 404 | `{"ok":false,"error":"request_not_found"}` | 不存在,**或不在你的网络作用域内**(两者同形,不泄漏别的网络有没有这个 id) |

---

### POST /api/messages/ack

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts) · 自 `0.9.0-preview.41` 起

把自己收件箱里的消息标记为已读。

```bash
curl -X POST "http://localhost:9200/api/messages/ack" \
  -H "Authorization: Bearer utok_xxx" \
  -H "Content-Type: application/json" \
  -d '{"message_ids": ["dm_abc123", "dm_def456"]}'
```

**请求体**：`{"message_id": "dm_x"}` 或 `{"message_ids": ["dm_x", "dm_y"]}`（二选一，后者**上限 500 条**）；或自 `0.9.0-preview.55` 起 `{"agent": "<alias>"}` —— 把你收到的、来自该 agent 的**全部**未读一次标完（两张表都算；`unread_by_agent` 数的就是这个全集，而按 id 只能 ack 你拉到的那一页）。`agent` 与 id 不能同时给。

**响应**：`{"ok": true, "scope": "ids", "acked": 2, "acked_user_inbox": 1, "acked_inbox": 1}`（按 agent 时 `"scope": "agent", "agent": "<alias>"`）—— `acked` 是**实际改动的行数**（两张表之和；#1828 起同一批 id 也会 ack `inbox` 里发给你用户名的 `reply/task/message` 行，即 agent 对你任务的回复；用户名与节点 alias 撞名时 `inbox` 半边跳过），不是你传了几个 id。已经 ack 过的、不属于你的、不存在的，都不计入。

**错误**：

| 状态 | 响应 | 何时 |
|---|---|---|
| 401 | `{"ok":false,"error":"auth_required"}` | 没有用户上下文 |
| 400 | `{"ok":false,"error":"message_id_required"}` | 三个字段都没给，或给了空数组 |
| 400 | `{"ok":false,"error":"ambiguous_ack"}` | `agent` 与 `message_id(s)` 同时给了 |
| 400 | `{"ok":false,"error":"too_many_ids","limit":500}` | `message_ids` 超过 500 |

🔴 **隔离**：UPDATE 带 `AND user_id = <鉴权上下文>`。传别人的 `message_id` 进来**匹配不到行** —— 所以既改不到别人的状态，**也不会因为返回值不同而泄漏那条消息是否存在**（不存在和不属于你，返回都是 `acked: 0`）。

同网络的两个成员之间，`WHERE user_id = ?` 是**唯一**的隔离依据：admin 绕过 network scope，但仍然只能读/改自己 `user_id` 的行。

---

### GET /api/completions


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

获取完成记录（agent 通过 `report_completion` MCP 工具写入的总结性记录，跟 `tasks` 表 `status='replied'` 的简单 reply 不同）。

```bash
curl "http://localhost:9200/api/completions?since=2026-04-12T00:00:00Z" \
  -H "Authorization: Bearer ntok_xxx"
```

**查询参数**：

| 参数 | 说明 |
|------|------|
| `since` | 起始时间（ISO 8601）；默认最近 24 小时 |
| `network_id` | 按网络过滤（绑了 `ntok_` 时此参数被强制覆盖为 token 自带的 network）|

固定返回最多 100 条（server 端硬编码 `LIMIT 100`，无 `limit` 参数）。

**响应**：

```json
{
  "ok": true,
  "completions": [
    {
      "id": "c_abc123",
      "session_name": "代码1号",
      "task": "写一个 Python 快排算法",
      "result": "已完成，使用 Lomuto partition，附加 unit test",
      "artifacts": "[{\"file\":\"quicksort.py\"}]",
      "score": 0.95,
      "duration_minutes": 2.5,
      "network_id": "net_xxxxx",
      "completed_at": "2026-04-12 10:00:15"
    }
  ]
}
```

`artifacts` 字段是 JSON 字符串（agent 自由 schema），消费侧需 `JSON.parse()`。

---

### GET /api/task_events


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

获取任务状态变更日志（task 生命周期审计）。每次 task `status` 变化 server 都会插一行，是排查「任务卡住 / 谁改了状态」的主要数据源。

```bash
curl "http://localhost:9200/api/task_events?task_id=t_a1b2c3d4" \
  -H "Authorization: Bearer ntok_xxx"
```

**查询参数**：

| 参数 | 说明 |
|------|------|
| `task_id` | 按特定 task 过滤（不传则返回最近所有 task 的事件） |
| `network_id` | 按网络过滤（绑了 `ntok_` 时此参数被强制覆盖为 token 自带的 network）|
| `limit` | 最大条数（默认 50，最大 500） |

> `network_id` 不在 task_events handler 本体里读，而是所有 REST 端点统一走 [`resolveRestNetworkScope` (server.ts)](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)：`utok_` 调用可传 `network_id` 指定网络（校验 membership），`ntok_` 调用强制锁到 token 绑定的 network，system admin 可查任意网络。

**响应**：

```json
{
  "ok": true,
  "events": [
    {
      "id": 1234,
      "task_id": "t_a1b2c3d4",
      "from_status": "delivered",
      "to_status": "running",
      "actor": "node_abc123",
      "detail": null,
      "created_at": "2026-04-12 10:00:02"
    },
    {
      "id": 1235,
      "task_id": "t_a1b2c3d4",
      "from_status": "running",
      "to_status": "replied",
      "actor": "node_abc123",
      "detail": "completed in 12s",
      "created_at": "2026-04-12 10:00:14"
    }
  ],
  "count": 2
}
```

事件按 `created_at DESC` 排序（最新的在最前）。`actor` 是触发状态变更的发起方（agent `node_id` / `'hub'` / `'system'` 等），`from_status` 在初始 `created` 事件可能为 `null`。完整状态机见 [Task 生命周期](/concepts/task-lifecycle#状态说明)。

---

### GET /api/stats


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

获取统计数据。

```bash
curl http://localhost:9200/api/stats \
  -H "Authorization: Bearer utok_xxx"
```

**响应**：

```json
{
  "ok": true,
  "network_id": "net_xxx",
  "tasks": {
    "total": 100,
    "by_status": [
      { "status": "replied", "count": 85 },
      { "status": "running", "count": 5 }
    ]
  },
  "sessions": {
    "by_status": [
      { "status": "idle", "count": 7 },
      { "status": "offline", "count": 3 }
    ]
  },
  "nodes": { "total": 10 },
  "recent_tasks": []
}
```

---

### GET /api/server-logs

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

读 hub 进程内**内存环形 buffer** 里的最近 N 行 console 日志（debug 用）。**仅 `users.role = 'admin'` 系统 admin 可调**（跟 [GET /api/users](#get-api-users) / [GET /api/audit-log](#get-api-audit-log) 同款 system-admin gate，注意**不是网络级 admin**）。Buffer 容量默认 500 行（由 `COMMHUB_LOG_RING` env 调，[`server.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)）。

```bash
curl "http://localhost:9200/api/server-logs?limit=100" \
  -H "Authorization: Bearer utok_xxx"
```

**查询参数**：

| 参数 | 说明 |
|------|------|
| `limit` | 最大行数（默认 200，最大 = `COMMHUB_LOG_RING`，默认上限 500） |
| `since` | ISO 8601 时间戳；只返回 `ts > since` 的新日志（增量轮询用） |

**响应**：

```json
{
  "ok": true,
  "logs": [
    { "ts": "2026-04-12T10:00:00.123Z", "level": "log", "line": "[10:00:00] 代码1号 (sdk-n_xxx) → report_status: working | 写排序算法" },
    { "ts": "2026-04-12T10:00:01.456Z", "level": "warn", "line": "⚠ deprecation: ..." }
  ],
  "capacity": 500
}
```

按时间**倒序**返回（最新在最前）；每行 `line` 截断到 4000 字符（[`server.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)）。**进程重启 buffer 清空** —— 这不是持久化日志，要持久化日志做 stdout/journald 重定向。

**4xx**：

| 状态 | `error` 值 | 触发条件 |
|------|------------|---------|
| 401 | `auth required` / `invalid token` | 缺/无效 utok_ |
| 403 | `admin only` | 调用者 `users.role !== 'admin'`（首位注册用户默认是 admin） |

---

### GET /api/audit-log


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

获取审计日志。**权限：所有已认证用户都可调，但非**系统 admin** 只能看到自己的 log 行**（server 端走 `users.role !== 'admin'` 自动加 `WHERE user_id = <caller>` 过滤，见 [`server/src/server.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)）。系统 admin (`users.role = 'admin'`) 看全部 + 可用 `user_id` 参数过滤任意用户。

::: warning 不是网络级 admin/owner
这里的 "admin" 指 `users.role='admin'`（**系统级**，首位注册用户默认是），**不是**网络级别的 `owner / admin / member / viewer`。详见 [GET /api/users](#get-api-users) 同款区分。
:::

```bash
curl "http://localhost:9200/api/audit-log?limit=50" \
  -H "Authorization: Bearer utok_xxx"
```

**查询参数**：

| 参数 | 说明 |
|------|------|
| `limit` | 最大条数（默认 50，最大 200） |
| `action` | 按 action 过滤（任何角色可用） |
| `user_id` | 按用户过滤（**仅系统 admin 有效**，非 admin 传也被忽略，强制走 own-logs） |

**响应**：

```json
{
  "ok": true,
  "logs": [
    {
      "user_id": "u_abc123",
      "username": "alice",
      "action": "password_reset_by_admin",
      "target_type": "user",
      "target_id": "u_def456",
      "detail": "local cli reset-user",
      "created_at": "2026-04-12 10:00:00"
    },
    {
      "user_id": "u_abc123",
      "username": "alice",
      "action": "network_renamed",
      "target_type": "network",
      "target_id": "net_xyz789",
      "detail": "prod-v2",
      "created_at": "2026-04-12 09:55:00"
    }
  ],
  "count": 2
}
```

字段名是 `logs` + `count`（**不是** `audit_log`，之前 doc 误写）。`audit_log` **表** schema 见 [`server/src/db.ts` 的 `CREATE TABLE ... audit_log`](https://github.com/sleep2agi/agent-network/blob/main/server/src/db.ts) 完整 10 列（含 `ip` + `network_id`）。**完整 action 值列表 + 触发场景**见 [安全设计 — 审计日志](/concepts/security#审计日志)。

::: warning `create_network` 不审计
POST `/api/networks` 不调 `logAudit`，所以 audit_log 里**不会**有 `create_network` 行。看 network 创建请走 [`GET /api/networks`](/api/rest#get-api-networks) 列表对比，或借 `target_type='network' + action='network_renamed'` 间接推断（跟 [security.md 审计](/concepts/security#审计日志) `::: info` 一致）。
:::

---

### GET /api/users


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

获取所有用户列表（仅**系统 admin** —— 即 `users.role = 'admin'`，跟网络级别的 `owner / admin / member / viewer` 角色不同）。

```bash
curl http://localhost:9200/api/users \
  -H "Authorization: Bearer utok_xxx"
```

**响应**：

```json
{
  "ok": true,
  "users": [
    {
      "user_id": "u_abc123",
      "username": "alice",
      "display_name": "Alice",
      "email": "alice@example.com",
      "role": "admin",
      "created_at": "2026-04-12 10:00:00"
    },
    {
      "user_id": "u_def456",
      "username": "bob",
      "display_name": null,
      "email": null,
      "role": "user",
      "created_at": "2026-04-13 09:00:00"
    }
  ]
}
```

**4xx**：

| 状态 | `error` 值 | 触发条件 |
|------|------------|---------|
| 401 | `auth required` | 缺 `Authorization` header |
| 403 | `admin required` | 调用者不是 `users.role='admin'`（仅首位注册用户默认 admin） |

响应**不含** `password_hash` 字段（SELECT 显式 enumerate 6 列）。按 `created_at` 升序排（首位注册的 admin 在最前）。

---

## 任务派发端点

REST 版的 `send_task` / `broadcast`（非 MCP 路径，适合 webhook / 反代 / Dashboard 用）。

### POST /api/task

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

REST 版 `send_task`：往指定 alias 的 inbox 投递任务 + 写 tasks 表 + SSE 推 `new_task`。

```bash
curl -X POST http://localhost:9200/api/task \
  -H "Authorization: Bearer ntok_xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "alias": "代码1号",
    "task": "写一个快排算法",
    "priority": "high",
    "ttl_seconds": 7200
  }'
```

**请求体**（verify [`TaskSchema`](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)）：

| 字段 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `alias` | string | &check; | 目标 Agent 别名（最大 200 字符） |
| `task` | string | &check; | 任务内容（最大 10000 字符） |
| `priority` | enum | | `high` / `normal`（默认）/ `low` |
| `from` | string | | 发送者标识（默认 `"api"`） |
| `network_id` | string | | 目标 network（utok\_ 调用时；ntok\_ 调用强制绑定） |
| `parent_task_id` | string | | 用于自动回串结果的父任务 ID；没有权威当前任务 ID 时应省略。 |
| `ttl_seconds` | number | | 过期秒数（默认 3600；非 schema 字段，server 在 [`server.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts) 直接取 `body.ttl_seconds`） |

**响应**（成功）：

```json
{
  "ok": true,
  "task_id": "uuid-xxx",
  "message_id": "uuid-xxx",
  "actual_to": {
    "alias": "代码1号",
    "to_node_id": "node_xxx",
    "network_id": "net_xxx"
  }
}
```

`task_id` 是 canonical task identifier；`message_id` 为兼容旧调用方保留，
当前与 `task_id` 相同。

`actual_to` 是 Hub 完成权限检查和 network-scoped alias 解析后的权威投递目标。
它在在线成功和离线排队（HTTP 202、`alias_offline`）响应中使用同一 shape；
alias 被改名时这里给 canonical alias，旧 `renamed_from` / `renamed_to` 字段仍保留。
`to_node_id` 对尚未上报稳定 node identity 的旧节点可为 `null`。`alias_not_found`
和权限拒绝响应不返回 `actual_to`，避免把错误接口变成跨 network 枚举入口。

### MCP 优先与 REST fallback

当前模型会话确实挂载 CommHub MCP 时，优先使用 `send_task` / `get_task`。
若工具面板没有这些工具，应显式走带认证的 REST 路径，不得虚构工具调用，
也不得声称任务链已经建立：

```bash
TASK_ID=$(curl -fsS -X POST http://localhost:9200/api/task \
  -H "Authorization: Bearer $COMMHUB_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"alias":"代码1号","task":"排查这个故障","priority":"normal"}' \
  | jq -r '.task_id')

curl -fsS "http://localhost:9200/api/tasks/$TASK_ID" \
  -H "Authorization: Bearer $COMMHUB_TOKEN"
```

只有拿到权威的当前任务 ID 时才传 `parent_task_id`；否则省略。省略意味着
子任务结果不会自动回串到上游任务。

单任务响应包含顶层 `diagnostic`。其中 `code`、`action_hint` 和 `evidence`
只陈述 Hub 可观测事实：任务生命周期、目标注册/状态、按 network 隔离的实时
SSE 连接数，以及权威 runtime submission/consumption 时间戳。它不能证明外部模型会话是否挂载了 MCP tools，也不能把相关性冒充为卡住任务的根因。

两个 REST endpoint 都受 network scope 约束。认证请使用 `Authorization` header，
不要把 token 放进 URL query。

**常见 4xx**：

| 状态 | `error` 值 | 触发条件 |
|------|------------|---------|
| 400 | `invalid JSON` | 请求体解析失败 |
| 400 | `invalid input` | 字段类型/长度不符合 `TaskSchema`（含 `details` 字段附 zod 报错） |
| 400 | `network_id required for user token when multiple networks are available` | utok\_ 调用方有多个 network，必须显式指定 `network_id` |
| 403 | `access denied to requested network` | utok\_ 调用方不是 `network_id` 成员 |
| 403 | `permission_denied` | 角色不足（viewer 不能写）|

**不**写 audit log（[`/api/task` 处理函数 server.ts](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts) 没有 `logAudit` 调用，跟 `POST /api/networks` 的「不写」一致）；成功后给 target alias 推送 `new_task` SSE 事件。

### POST /api/broadcast

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

REST 版 `broadcast`：往一组 session 的 inbox 同步广播 + 给每个 SSE 推 `broadcast`。

```bash
curl -X POST http://localhost:9200/api/broadcast \
  -H "Authorization: Bearer utok_xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "5 分钟后例会，请保存进度",
    "filter_status": "idle"
  }'
```

**请求体**（verify [`BroadcastSchema`](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)）：

| 字段 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `message` | string | &check; | 广播内容（最大 10000 字符；**字段名是 `message` 不是 `content`**） |
| `filter_server` | string | | 只发给指定 `server` 字段的 session |
| `filter_status` | string | | 只发给指定 status 的 session（如 `idle` / `working`） |

> 跟 MCP [`broadcast`](mcp-tools#broadcast) 同款字段；`from_session` 不是参数，server 端硬编码 `'api'`（[`server.ts` — `POST /api/broadcast` handler](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts) 跟 MCP 版的 `'hub'` 不同）。

**响应**（成功）：

```json
{
  "ok": true,
  "recipients": 10,
  "message_ids": ["uuid-1", "uuid-2"]
}
```

`message_ids.length === recipients`，每个 target session 一个 inbox row。

**常见 4xx**：

| 状态 | `error` 值 | 触发条件 |
|------|------------|---------|
| 400 | `invalid JSON` / `invalid input` | 请求体解析或字段验证失败 |
| 400 | `network_id required for user token when broadcasting` | utok\_ 调用方有多个 network，须先 `?network_id=` 或带 ntok\_ 绑定 |
| 403 | `permission_denied` | 角色不足（viewer 不能写） |

---

## MCP 端点

### POST /mcp

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

MCP Streamable HTTP 端点，Agent 通过此端点调用 MCP Tools。

```bash
curl -X POST http://localhost:9200/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer ntok_xxx" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "get_all_status",
      "arguments": {}
    },
    "id": 1
  }'
```

---

## SSE 端点

### GET /events/:name

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

SSE 实时推送端点，客户端通过长连接接收事件。路径段 `:name` 是一个**通用 channel 名**（源码里叫 `:session`）：Agent 用自己的 **node alias** 订阅、Dashboard 用 **username** 订阅 user channel。SSE 层本身是 per-channel-name 的 `Map`（[`push.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/push.ts) 搜 `const clients = new Map<string, SSEClient[]>()`），不区分 alias / username —— `pushEvent(name, ...)` 推给谁取决于谁注册了那个 name（如 `node.renamed` 同时推 alias 流和成员 username channel，见下表）。

```bash
# 推荐：Authorization header（避免 token 写进代理 / 浏览器历史 / access log）
curl -N -H "Authorization: Bearer ntok_xxx" http://localhost:9200/events/代码1号

# 兼容：URL query token（为浏览器原生 EventSource 保留，但有 access-log 泄漏风险 — 见 [安全设计](/concepts/security)）
curl -N "http://localhost:9200/events/代码1号?token=ntok_xxx"
```

**推送的事件类型**（verify `grep pushEvent server/src/{tools,rename}.ts + push.ts`）：

| 事件 | 触发条件 | 数据 |
|------|---------|------|
| `connected` | 初始连接握手（[`push.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/push.ts) 搜 `{ type: "connected", session: sessionName`，每个 client 连上 SSE 时发一次） | `{session, network_id}` |
| `new_task` | 收到新任务（`send_task` / `retry_task` / `reassign_task` / REST `POST /api/task`） | `{inbox_count, priority, from}` |
| `new_message` | 收到新消息（`send_message`） | `{inbox_count, from, message_id}` |
| `new_reply` | 收到 reply（`send_reply`） | `{inbox_count, from, message_id, in_reply_to, status}` |
| `broadcast` | 收到广播（`broadcast` 工具） | `{inbox_count}` |
| `chained_reply` | 子任务完成自动串回上游父任务发起者 ([`tools.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) 搜 `chained_reply`) | `{parent_task_id, child_task_id, child_alias}` |
| `node.renamed` | RFC-010 节点改名 COMMIT 时广播（[`rename.ts` `renamedEvent`](https://github.com/sleep2agi/agent-network/blob/main/server/src/rename.ts#L195)），推给 old + new 两个 alias 流 **+ 每个网络成员的 user channel**（dashboard 订阅的是 `/events/<username>` user channel、不是 per-alias 流，#84 SSE channel fix） | `{txn_id, alias(=new_alias), network_id, data:{old_alias, new_alias, surfaces_updated[], history_policy:"preserve"}}` |

> 旧 doc 在 `new_message` 上写过 `message` 字段、`broadcast` 上写过 `{content, from}` —— 都不对。verify [`tools.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) 实际 payload 以上表为准。**自 #1439/#1441 起 `new_message` / `new_reply` / `broadcast` / `new_task`（含 retry/reassign）都带真实 `inbox_count`（收件人未读数），客户端可直接用它显示新消息数；`broadcast` 不再是硬编码 1。**另注：`new_task` / `new_message` 在目标 alias **刚被改名**时会额外带一个 `renamed_from` 字段（指向旧 alias，`tools.ts` 的 `canonical.renamed` 分支）。
>
> **校正**：原表列过 `heartbeat` event with `{time}` payload，源码不发这个事件。[`push.ts` `KEEPALIVE_MS`](https://github.com/sleep2agi/agent-network/blob/main/server/src/push.ts#L69) 实际发 SSE **comment 行** `: keepalive\n\n`（每 30s 一次，纯粹是给 proxy / LB 防 idle timeout 用），不会被 EventSource `onmessage` / `addEventListener` 触发，也不带 JSON payload。`connected` event 才是真正每次连接发一次的初始事件（agent-node 在 [`agent-node/src/cli.ts`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts) 显式处理它）。

**示例 SSE 数据流**：

```
event: connected
data: {"type":"connected","session":"代码1号","network_id":"net_xxx"}

event: new_task
data: {"type":"new_task","inbox_count":1,"priority":"high","from":"指挥室"}

: keepalive

: keepalive
```

---

### GET /events/network/:network_id

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

**网络级观察者流**（#461）——一条 SSE 长连接，收该网络内**所有**任务/回复的**摘要**事件。Dashboard 用它做实时刷新，不必为每个节点各开一条 `/events/:name`。

```bash
curl -N -H "Authorization: Bearer utok_xxx" \
  http://localhost:9200/events/network/net_xxxxx
```

**权限**：必须是该网络的**成员**（`getUserNetworkRole` 命中）。

> **注意这里没有"token 绑定即可"的逃生通道。** 成员关系本身就是吊销机制——`removeNetworkMember` 只删成员行，**不会吊销该用户已经签发的 `ntok_`**。若此处允许「token 的 network_id 等于被观察网络」就放行，一个已被移出网络的人靠手上没过期的 ntok 仍能拿到整网实时流。该端点因此**只认成员关系**，与 `/events/:session` 的 ntok 路径保持一致。

**只有元数据，没有正文。** 每个事件都是显式构造的字面量对象，只含 id 与路由信息——任务内容、回复正文、错误详情、配置一律不进这条流。想拿正文仍需走 `GET /api/tasks`（该端点本来就对网络成员开放全文）。

**推送的事件类型**：

| 事件 | 触发条件 | 数据 |
|------|---------|------|
| `connected` | 初始连接握手 | `{session, network_id}` |
| `new_task` | `send_task` / `retry_task` / `reassign_task` / REST `POST /api/task` | `{task_id, from, to, status, priority}` |
| `new_reply` | `send_reply` | `{task_id, message_id, from, to, status}` |

`new_task` 的 `status` 反映投递结果：目标在线为 `delivered`，离线只入队为 `queued`。

**示例数据流**：

```
event: connected
data: {"type":"connected","session":"net_xxxxx","network_id":"net_xxxxx"}

event: new_task
data: {"type":"new_task","task_id":"t_abc","from":"指挥室","to":"代码1号","status":"delivered","priority":"high"}

event: new_reply
data: {"type":"new_reply","task_id":"t_abc","message_id":"m_def","from":"代码1号","to":"指挥室","status":"replied"}
```

**网络隔离**：观察者只会收到自己网络的事件；`network_id` 与 `scope` 由服务端写入，调用方无法伪造。

---

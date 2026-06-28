# RFC-026 — Dashboard 远程创建节点 + Host-Daemon

**作者**: 通信工程马
**状态**: Draft v1（design-first，待 通信龙 review → Vincent 拍）
**关联**: #260（dashboard 真生效系列）、RFC-024（config-apply，本 RFC 的姐妹）、RFC-014（host telemetry，本 RFC 的复用底座）
**目标 ship**: P1 MVP `v0.12-preview.X` 单机闭环；P2/P3 后续
**长度承诺**: 该 RFC 限定 design，**任何代码改动不在本 RFC 内**

---

## 0. TL;DR

Vincent 原需求 #③：**dashboard 上「新建节点」+ 「选服务器」一整套**。今天 anet 没有「远程在某台机器上代为起进程」的能力，节点必须人在那台机器上手动 `anet node create + start`。本 RFC 设计一条**最小入侵、复用 RFC-014/RFC-024 既有底座、安全边界明确**的链路：

> **「Host-Daemon = 一个特殊角色的 anet 节点」**——它不是新二进制、不是新协议，只是一个常驻 `anet node start` 进程，多挂了 1 个 `create_local_node` MCP 工具。Dashboard 选服务器 → hub 调该 daemon 的 `create_local_node` → daemon fork-exec `anet node create + start` 生出真节点子进程 → 子进程拿独立 ntok 注册回 hub → dashboard 看到新节点。

**为什么选这个形态**：
- 复用已有的 SSE doorbell（RFC-024）+ ntok auth + supervisor wrap（RFC-024 W1）+ host telemetry（RFC-014）→ 几乎不加新基础设施
- 「daemon = 特殊节点」让安装路径 = `npm i -g @sleep2agi/agent-node` 一句话，不引入第二个 binary 的分发负担
- 子进程的 ntok 由 hub 现场 mint 给 daemon 转发，**daemon 永远拿不到用户 utok**——安全边界最强

MVP（P1）只做单机本机 daemon 闭环（dashboard 列「本机」一个服务器，证 chain），然后 P2 多机选择 + role gate，P3 一整套可选项 + 反向操作（停/删节点）。

---

## 1. 现状审计

### 1.1 RFC-014（host telemetry）现状

| 能力 | 现状 | 给本 RFC 的价值 |
|---|---|---|
| 每个 agent-node 周期 `report_status.host` 上报 hostname / ip / cpu / mem / disk | ✅ shipped v0.10.0/0.11.0 | **「在线服务器列表 = 已注册 daemon 的 host 列表」可直接基于此数据** |
| `/api/server/:host/health` 返回 alert_level + history | ✅ shipped | dashboard「服务器卡片」可直接显示健康状态，不重新设计 |
| 每个 host 可能跑多个节点 | 现状如此 | daemon 是 host 上的 1 个**特殊**节点；普通节点照常 |

**结论**：RFC-014 已经把「per-host 心跳 + 资源 + 健康」的协议、表、UI 都做完。本 RFC 不重写。

### 1.2 RFC-024（config-apply）现状

| 复用点 | 本 RFC 用法 |
|---|---|
| SSE doorbell `pushEvent(alias, {type: "config_update"})` | 改成 `{type: "create_node"}` 唤醒 daemon |
| MCP tools/call 通用调用 + tools 注册体系 | 新增 `create_local_node` 工具 |
| W1 supervisor wrap（exit 75 自动 respawn） | daemon 进程本身就跑在 W1 下；fork 出的子节点也跑 W1 |
| 单飞 unique index + reaper 60s 超时 | 复用为「同一 daemon 同一 node_name 单飞」 |
| `report_status.config_snapshot` content-match finalize | 复用为「create 完成 = 子节点首次 report_status 收到 = update applied」 |

**结论**：RFC-024 留下的「派单 + 应用 + 终态」骨架可以直接长出「create 任务」这一条新分支。

### 1.3 现有 `anet node create + start` CLI

```
anet node create <name> [--runtime ...] [--model ...] [--channels ...]
  → 写 .anet/nodes/<name>/config.json
  → 把 alias 注入 ~/.anet/global/aliases
  → 不启动进程

anet node start <name>
  → 读 config.json
  → launchAgent(name) → spawn `agent-node` 子进程
  → W1 supervisor wrap，exit 75 自动 respawn
```

agent-node 启动后即向 hub `register()` + `reportStatus("idle")`，**完全是 self-bootstrapping**，hub 只是被动接收。

本 RFC 的「daemon 代为创建」= **daemon 进程内 spawn `anet node create + start`**，对子节点而言跟人手敲完全等价。

---

## 2. Host-Daemon 架构

### 2.1 总览（一图）

```
┌────────────┐        utok        ┌────────┐
│  Dashboard │ ─────────────────► │  Hub   │
└────────────┘   create_node      └────────┘
                                       │
                                       │ SSE doorbell {type: create_node, payload}
                                       ▼
                                  ┌────────────────────────────┐
                                  │ Host-Daemon (alias=         │
                                  │  daemon-<hostname>)         │
                                  │ ntok=daemon-only, scope=host│
                                  ├────────────────────────────┤
                                  │ MCP tool: create_local_node│
                                  │  • 验证 payload 来自 hub    │
                                  │  • mint child ntok via hub  │
                                  │  • fork-exec:               │
                                  │     anet node create <n>    │
                                  │     anet node start <n>     │
                                  │  • 子进程 W1 wrapped         │
                                  │  • ack hub: child_node_id   │
                                  └────────────────────────────┘
                                       │
                                       │ spawn (W1 wrap)
                                       ▼
                                  ┌────────────────────────────┐
                                  │ 普通 agent-node 子进程      │
                                  │ alias = 用户填的 name        │
                                  │ ntok = hub mint 的新 ntok    │
                                  │ register → hub               │
                                  │ report_status → hub          │
                                  └────────────────────────────┘
```

### 2.2 Daemon 形态：特殊节点而非新 binary

**Daemon = 一个跑在每台「可创建节点的服务器」上的 anet 节点**，跟普通节点同一个 `@sleep2agi/agent-node` 二进制；唯一区别：

- alias 固定为 `daemon-<hostname>`（dashboard 据此识别 host）
- config.json 多一行 `role: "host_supervisor"`
- 启动时挂载一个**额外**的 MCP 工具集合 `create_local_node` / `stop_local_node` / `list_local_nodes`（仅当 role=host_supervisor 才注册）
- `report_status.host` 多带一个 `daemon_capabilities` 字段：`{can_create_nodes: true, allowed_runtimes: [...], max_concurrent_children: N}`

**为什么不做独立 binary**：
- 分发：`npm i -g @sleep2agi/agent-node` 一句话覆盖 daemon + 普通节点两个角色，少一条 install 路径
- 升级：preview/latest npm 同 channel，不维护第二个 release pipeline
- 监控：daemon 自身的 host telemetry / health / alert 全部白送（沿用 RFC-014）
- 代码：本 RFC 真正新增的逻辑 = 1 个工具注册 + ~150 LOC fork-exec 编排，不是新进程

### 2.3 Daemon 安装 + 启动

**目标用户**：管理员在「希望被 dashboard 列入候选服务器」的机器上跑 1 次

```bash
# 一键脚本（本 RFC 设计；P1 提供）
curl -fsSL https://anet.sh/install-daemon | bash -s -- \
    --hub https://hub.example.com \
    --token utok_admin_xxx \           # 管理员 utok，**仅用于现场 mint 一个 daemon-only ntok**
    --network net_xxx \                # 此 daemon 服务哪个 network
    --hostname-alias my-server-01      # 可选；默认用 os.hostname()

# 脚本内部：
# 1) 校验 npm/node 版本（>= node 22）
# 2) npm i -g @sleep2agi/agent-node (复用 RFC-024 已发版的)
# 3) 调 hub /api/auth/node-token 现场 mint 一个 ntok（标 role=daemon, scope=host_supervisor）
#    → 然后**销毁原 utok 输入**（不持久化）
# 4) 写 ~/.anet/daemon/config.json （ntok + role=host_supervisor + hub + alias=daemon-<host>）
# 5) 启动 systemd unit `anet-host-daemon.service`（或 launchd / NSSM 跨平台 fallback）
# 6) 进程内自动 `anet node start daemon-<host>`（普通节点的代码路径）
```

**关键点**：管理员的 utok 只在这一次 mint daemon-ntok 时用一次，**不写盘**。daemon 之后跟 hub 通信全凭 daemon-ntok（只能创建节点 + 心跳，不能代用户调任何业务工具）。

### 2.4 Daemon ↔ Hub 的注册与发现

**注册**：daemon 起来 = 一个普通 `report_status`，唯一不同是 `daemon_capabilities` 字段。Hub 见到该字段 → 在 `nodes` 表的 `daemon_capable=1` flag + `daemon_alias` 索引登记。

**Dashboard 取「可用服务器列表」**：复用 RFC-014 的 `/api/server/:host/health`，扩展加 1 字段：

```json
{
  "host": "my-server-01",
  "alert_level": "green",
  "latest": {...},
  "history": {...},
  "daemon": {
    "alias": "daemon-my-server-01",
    "node_id": "node_xxx",
    "online": true,
    "allowed_runtimes": ["claude-agent-sdk", "codex-sdk", "grok-build-acp"],
    "current_children": 3,
    "max_concurrent_children": 20
  }
}
```

`daemon` 字段缺失 = 这台 host 没装 daemon → dashboard 创建按钮 grey 掉 + 提示「该服务器未启用远程创建」。

### 2.5 创建流程（hub 视角）

1. **Dashboard** POST `/mcp` `tools/call` `create_node`（**新工具，hub-side**，不是 daemon 上的）：
   ```json
   {
     "daemon_node_id": "node_xxx",        // 目标 daemon
     "node_spec": {
       "name": "demo-bot",                 // 子节点 alias
       "runtime": "claude-agent-sdk",
       "model": "claude-opus-4-6",
       "flags": {"permissionMode": "default", "maxTurns": 50, ...},
       "channels": [],                     // 可选；P3 才接
       "env_refs": ["ANTHROPIC_API_KEY"]   // 仅传引用，hub 端解 envRef
     },
     "network_id": "net_xxx"
   }
   ```

2. **Hub** 串行 5 件事：
   - SEC-2 检查（详见 §4）：调用者 role ≥ admin？目标 daemon 在调用者 network？请求的 runtime 在 daemon allowed_runtimes 里？
   - 单飞检查（复用 RFC-024 reaper 模式）：同 daemon + 同 child name 不能并发
   - 现场 mint child-ntok：`createNetworkTokenForNode(network_id, name)` → 拿 `ntok_xxx`
   - envRef 解：把 `env_refs: ["KEY1"]` 从 network 级 secret vault 取出真值，组装 `env_blob = {KEY1: "..."}`（**只在这一次内存里，不入 hub 日志**）
   - 写 `node_create_requests` 表（status=pending）+ pushEvent doorbell to daemon

3. **Daemon** 收 SSE `{type: "create_node", request_id: ...}` → 内部循环：
   ```ts
   const { request_id } = sseEvent;
   const req = await mcpCall("get_create_request", { request_id });
   // req = { node_spec, child_ntok, env_blob, expires_at }
   if (Date.now() > req.expires_at) { ack({status: "expired"}); return; }
   if (!ALLOWED_RUNTIMES.includes(req.node_spec.runtime)) {
     ack({status: "rejected", error: "runtime_not_in_local_allowlist"}); return;
   }
   if (currentChildren >= MAX_CHILDREN) {
     ack({status: "rejected", error: "max_children_exceeded"}); return;
   }
   try {
     execFileSync("anet", ["node", "create", req.node_spec.name, ...flags]);
     writeFileSync(`.anet/nodes/${name}/.env.local`, formatEnv(req.env_blob));  // 600 perm
     const child = spawn("anet", ["node", "start", name], { detached: true, ... });
     await ack({status: "started", child_node_id: req.node_spec.name, child_pid: child.pid});
   } catch (e) {
     await ack({status: "failed", error: redact(e.message)});
   }
   ```

4. **子进程** `anet node start` 起来 → register → first `report_status` 到 hub → **hub content-match 把 `node_create_requests.status` 标 `succeeded`**（复用 RFC-024 finalizePendingMatchingUpdates 同款模式）。

5. **Dashboard** 轮 `GET /api/nodes/<network>?recently_created=true` 或新 endpoint `/api/node-create-requests/<request_id>` → 看到 succeeded + child node 出现 → 渲染新节点卡片。

---

## 3. Dashboard 创建流程 + 可选项

### 3.1 创建向导（3 步）

```
[Step 1 — 选服务器]
┌──────────────────────────────┬──────────────────────────────┐
│ ● my-server-01  (上海)        │ ○ my-server-02  (北京)        │
│   ✓ green · 8c / 16GB / 220GB │   ⚠ yellow · 4c / 8GB / 30GB │
│   3 / 20 nodes running        │   18 / 20 nodes running       │
│   runtimes: ✓ claude ✓ codex  │   runtimes: ✓ claude          │
└──────────────────────────────┴──────────────────────────────┘
  ○ my-laptop (未装 daemon — 装一下) [复制安装命令]

[Step 2 — 配置节点]
  名字:     [demo-bot              ]
  Runtime:  (○) claude-agent-sdk
            ( ) codex-sdk
            ( ) grok-build-acp     ← grey, 服务器未启用
  Model:    [claude-opus-4-6      ▼]
  Flags:    ☑ permissionMode = default   maxTurns: [50] budget: [5] timeout: [600]
  Channels: ☐ Telegram (P3, 暂不接)
  Secret:   ☑ ANTHROPIC_API_KEY (该 network 已配)

[Step 3 — 确认]
  「在 my-server-01 上以 admin 身份创建 demo-bot (claude-agent-sdk + claude-opus-4-6)，
    使用 network net_xxx 的 ANTHROPIC_API_KEY」
                                        [取消]  [创建并启动]
```

### 3.2 创建后流程

- Dashboard 进入「正在创建…」（max 30s ceiling，跟 config-apply 同款）
- 进度文案：`已派单 daemon → daemon 已 fork → 子进程已起 → 子节点已 register → ✓ 已创建`（用 hub 的 `node_create_requests.status` + 子节点 first report 两个信号合成）
- 失败：error 文案映射（详见 §4 error catalog）+ 「重试」按钮

### 3.3 可选项的版本切分（细节见 §5）

| 选项 | P1 MVP | P2 | P3 |
|---|---|---|---|
| 选服务器 | ❌ 只本机 | ✅ 列表 | ✅ 列表 + role 过滤 |
| Runtime | claude only | ✅ 3 种 | ✅ 3 种 |
| Model | 1 个默认 | ✅ 各 runtime 默认列表 | ✅ + 自定义 |
| Flags | RFC-024 6 字段 | RFC-024 6 字段 | + per-runtime 扩展 |
| Channels | ❌ | ❌ | ✅ Telegram/IM 绑定 |
| envRef | ✅ network vault | ✅ + per-secret picker | ✅ + per-node override |

---

## 4. 安全边界（**本 RFC 最重要章节**）

> 「在别人机器上远程起进程」=「远程执行」的近亲。任何不严的边界都是后门。下面每一条都是必须立的红线。

### 4.1 谁能创建节点（authorization 三层）

**4.1.1 Role gate**（hub-side enforce，dashboard UI 是辅助）：

| Role | 创建节点权限 |
|---|---|
| `owner` | ✅ 任意 daemon、任意 runtime、任意 flag |
| `admin` | ✅ daemon 在本 network、runtime 在 daemon allowlist、flag 在 RFC-024 SEC-2 允许范围 |
| `member` | ❌ 直接拒（403 `insufficient_role_for_create_node`） |
| `viewer` | ❌ 直接拒 |

理由：创建节点 = 拉新资源 + 烧 API 配额，比单点改 flag 影响大一档；最低门槛 admin。

**4.1.2 Daemon allowlist**（daemon-side enforce）：

daemon 配置 `allowed_runtimes`、`max_concurrent_children`、`allowed_secret_keys`，hub 派进来超出范围一律 reject。理由：即使 hub 被攻破，daemon 本机管理员仍能限制「能在我机器上起什么」。

**4.1.3 Network scope**：

daemon 注册时绑定 1 个 `network_id`，hub 派任务前必须验证「调用者 utok 当前 network == daemon 的 network」（RFC-024 SEC-1 相同的防护带模式）。

### 4.2 Daemon 防被滥用「在你机器上起任意进程」

**4.2.1 daemon-ntok 权限最小化**：

daemon-ntok 在 hub `tokens` 表标 `role=host_supervisor` + `scope=daemon-only`。**它只能调** `register / report_status / get_create_request / ack_create_request`，**调任何业务工具一律 403**（hub 端 tool registration 强制 role check）。即使 daemon 进程被入侵，劫持者拿 daemon-ntok 也不能 send_task / 创建任意 task / 看别人 inbox。

**4.2.2 fork-exec 命令固定**：

daemon 内部 fork 走的命令是**硬编码白名单**：
```ts
const FORK_WHITELIST = new Set(["anet"]);
const FORK_ARGS_PATTERN = /^node (create|start|delete) [a-z0-9_-]+( --[a-z-]+(=[a-zA-Z0-9_-]+)?)*$/;
```
hub 派进来的 `node_spec.name` 严格 `/^[a-z][a-z0-9_-]{0,63}$/`，runtime / model / flag 都白名单 enum 校验。**不存在任意 shell 字符串拼接**。

**4.2.3 工作目录隔离**：

daemon 的 `WORK_DIR = ~/.anet/daemon/workspaces/<network_id>/` 固定；fork 出的子进程 cwd 强制在该目录下；不允许 dashboard 指定 cwd（哪怕 owner 也不行）。

**4.2.4 资源上限**：

daemon 配置 `max_concurrent_children`（默认 20）+ 每子进程 systemd-style cgroup（v2 P2 加）；超限 reject。理由：阻止「用 daemon 当 cryptominer 拉起器」攻击。

### 4.3 跨租户隔离（SEC-1 等价）

- daemon 注册绑死 1 个 network；不允许跨 network 创建
- hub 在 `node_create_requests` 表存 `network_id` 字段，每次 ack/status 查询都 `AND network_id = caller_net` 防护带
- 子进程 mint 的 ntok 同样 `network_id` scope，子进程没法跨 network send_task

**测试**：等同 RFC-024 SEC-1 测试集移植，新增 2 个用例：
1. netA 的 admin 不能在 netB 的 daemon 上创建节点
2. netA 的 daemon 不能创建 netB 的子节点（即使 hub 端被注入 cross-net spec）

### 4.4 Secrets / envRef 不明文过 hub

**核心原则**：用户 API key、token 等 secret **永不在 hub 日志里**、**永不在 hub<->daemon SSE 帧里明文出现**、**永不在 dashboard cookie/local-storage 里**。

实现：

1. **hub 端 secret vault**（已有 `network_secrets` 表，本 RFC 复用）：每 network 一份；admin 通过单独 endpoint `POST /api/networks/<id>/secrets` 写入；hub 内存级解密后立刻 zero-fill key buffer

2. **dashboard 不传 secret 值，只传 key 名**：`env_refs: ["ANTHROPIC_API_KEY"]`。hub 在派单时从 vault 取真值，组装一次性 `env_blob` 

3. **`env_blob` 经 short-lived encrypted SSE 帧到 daemon**：
   - 复用现有 SSE 鉴权（Bearer daemon-ntok over TLS）
   - 额外在 hub <-> daemon 之间 ECDH 协商一个 ephemeral session key（首次 daemon 注册时 hub 推 hub-pub-key，daemon 反推 daemon-pub-key），用该 key 把 env_blob AES-GCM 加密
   - daemon 解密 → 写入子节点 `.env.local`（chmod 600）→ 内存 zero-fill
   - 数据库里 `node_create_requests.env_blob` 字段加密存储；request ack 后立即删

4. **日志脱敏**：hub log + daemon log 对 `env_blob` 字段一律 redact 成 `<env-blob redacted, keys=[K1,K2]>`

5. **「禁止用户在 dashboard 输入裸 secret」**：UI 只暴露 secret picker（从 vault 选 key），不提供 textfield 写入；硬要写入只能走单独的 secret-vault 管理页（独立 endpoint，独立 audit）

### 4.5 Audit

每次 `create_node` 必写 audit log（hub 已有 `audit_log` 表）：

```
ts | actor_utok_id | actor_user_id | daemon_node_id | child_name | runtime | env_keys (names only) | result
```

dashboard 一个 admin-only 页直接查 audit。理由：远程拉起进程是高风险动作，事后必须可追溯。

### 4.6 Error catalog（dashboard ↔ hub ↔ daemon）

| code | source | UI 文案 |
|---|---|---|
| `insufficient_role_for_create_node` | hub | 「需要 admin 权限才能创建节点」 |
| `daemon_offline` | hub | 「目标服务器 daemon 离线，请稍后重试或联系管理员」 |
| `daemon_max_children` | hub or daemon | 「该服务器节点数已达上限 (N/N)，请选其它服务器」 |
| `runtime_not_in_local_allowlist` | daemon | 「该服务器未启用 runtime: codex-sdk」 |
| `secret_not_found` | hub | 「该 network 未配置 secret: ANTHROPIC_API_KEY，请先在 secret vault 添加」 |
| `node_name_conflict` | hub | 「节点名 demo-bot 已存在，请换名」 |
| `node_name_invalid` | hub | 「节点名只能用小写字母 / 数字 / `_` / `-`」 |
| `child_register_timeout` | hub | 「子进程已起但 30s 内未注册回 hub，请到服务器查日志」 |
| `cross_network_node` | hub | 「无权限：该服务器不在你的 network」 |
| `daemon_internal` | daemon | 「daemon 执行失败：<redacted>」（详情仅写 audit log） |

---

## 5. 分阶段

### P1 MVP — 本机 daemon 闭环（ETA ~3-4d 实际工程）

**目标**：证 chain 通；不做选择 UI；只能在「跑 dashboard 的本机」起节点。

- agent-node 加 `role=host_supervisor` config + `create_local_node` MCP 工具
- hub 加 `create_node` 工具 + `node_create_requests` 表 + 派单 + content-match 终态
- dashboard 加 1 个「在本机创建节点」按钮（写死本机 daemon，绕过选服务器 UI）
- §4.1 / 4.2 / 4.3 / 4.5 全开（4.4 简化：用 NETWORK_SECRETS 表直接传 plaintext via TLS，**不上 ECDH**——单机够用）
- Docker e2e：scenario 1 创建成功 + scenario 2 SEC role-gate 挡 member + scenario 3 daemon_max_children 挡

**ship**：作为 v0.12-preview.X 发，docs 标 EXPERIMENTAL。

### P2 — 多机选服务器（ETA ~1w）

- daemon 安装脚本 + systemd unit + 跨平台 fallback
- dashboard Step 1 服务器列表 + alert chip + runtime 过滤
- §4.4 升级到 ECDH ephemeral session key
- per-host audit page
- e2e: 跨 host network-scope 防护带 + secret 不明文流转测试

**ship**：v0.13-preview.X

### P3 — 一整套配置 + 反向操作

- channel 绑定（Telegram / Feishu）
- per-secret picker + per-node env override
- dashboard 「停 / 删 / 重启」节点 → 反向走 daemon
- 一键模板（demo bot / monitor bot / ...）

**ship**：v0.14-preview.X

---

## 6. 未决问题（待 review 拍）

1. **daemon 升级语义**：daemon 自我升级（`npm i -g @sleep2agi/agent-node@latest`）会不会顺带把子进程的二进制也换掉？子进程 W1 respawn 是否吃新版本？建议：子进程 PINNED 到 spawn 时的 npm 版本，避免「daemon 升级当晚所有子进程一起换」。
2. **daemon 自身的 SEC-2 配置如何被改**：dashboard 上能不能改 daemon 的 `max_concurrent_children`？倾向**不能**——daemon 自身配置只能本机管理员手动改 + `systemctl restart`，dashboard 只能读不能写（同 §4.2.1 最小权限原则）。
3. **anet hub 把 host telemetry 暴露在公网 dashboard 上是否泄漏**：服务器 hostname / IP / 资源用量给所有 network member 看的话，可能泄漏内网拓扑。建议默认只对 admin/owner 可见，member 看脱敏版（host 名 + green/yellow/red 不见 IP / 数字资源）。
4. **secret rotation**：daemon 长跑下 vault secret 轮换，子进程是否需要重启吃新值？倾向：复用 RFC-024 config-apply restart 链路，secret 轮换 → hub 给每个用到该 secret 的子节点派 restart_node。
5. **daemon 之间的隔离**：同 host 多个 daemon（多 network 服务）是否允许？建议：**每 host 最多 1 个 daemon**（多 network 用 daemon role 升级支持 multi-network 注册，避免端口/PID 文件竞争）。

---

## 7. 不在本 RFC 范围

- dashboard 「停 / 删 / 重启」反向操作 → P3
- 跨 host 节点迁移 → 不做（重新创建更简单）
- agent-node 二进制以外的 runtime（如 raw bash 进程）→ 不做（不符合产品定位）
- 自动扩缩容（按负载自动 daemon→拉起节点）→ 商业版话题，开源不做

---

## 8. Review checklist（给 reviewer）

- [ ] §2.2 daemon = 特殊节点 vs 独立 binary 选择是否同意
- [ ] §4.1 role gate 三层是否够（admin 是不是太松？要不要 owner-only?）
- [ ] §4.2 fork-exec 白名单 + WORK_DIR 隔离是否够（还需不需要 chroot/container?）
- [ ] §4.4 ECDH 在 P2 才上是否可接受（P1 单机不上对吗？）
- [ ] §5 P1 MVP scope 是否合适（再砍还是再加？）
- [ ] §6 未决 5 点 reviewer 各拍 1 个 verdict

---

**作者**: 通信工程马 · 2026-06-28
**Review 期望**: 通信龙 first pass → Vincent 拍 → 派工实施

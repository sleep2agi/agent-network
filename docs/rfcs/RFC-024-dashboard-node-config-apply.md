# RFC-024 — Dashboard 改 node 配置「真生效」(v0.11 旗舰 P1)

**Owner**: 通信工程马 (impl) · 通信N站马 (frontend) · 通信龙 (gate) · 通信牛 (design co-review)
**Status**: draft v1 (design-first per #260; doc-only PR for review before impl)
**Date**: 2026-06-28
**Refs**: [#260](https://github.com/sleep2agi/agent-network/issues/260) (v2 design 起点) · [#262](https://github.com/sleep2agi/agent-network/issues/262) (v0.11 roadmap) · dashboard PRs [#9/#10/#11](https://github.com/sleep2agi/agent-network-dashboard/pulls)

## 0. TL;DR

Vincent greenlight: dashboard 节点设置面板里改 `model` + 6 个 flags 必须**真生效**到运行中的节点 — 不只是前端模拟。N站马 前端 100% 完成 (PR #9/#10/#11), 三个 endpoint 用 mock 模式 ship, 等后端 swap 一行常量即可联调。

设计核心 (沿用 #260 v2 + 通信龙 2026-06-28 关键纠正):
1. **节点自有配置 + hub 门铃 + 节点自应用** — 不新造控制通道, 复用 SSE doorbell + MCP pull
2. **Supervisor-wrapper + sentinel-exit** 取代 Node execve-self (后者 fragile) — 复用刚 ship 的 `superviseChild()` helper (PR #284)
3. **分级 apply 降重启面**: `maxTurns/budget/timeout` 热重载 (零重启), `model/permissionMode/DSP/teammateMode` restart-required (sentinel re-spawn)
4. **多层守护**: 两层 schema 校验 + 原子写 + .prev 备份 + crash-loop guard + boot self-heal
5. **范围 P1**: model + 6 flags only; channel binding (A) / ops button (D) / runtime / hub 留 P2

doc-only PR ETA 出后等 review → Vincent confirm re-exec 时序 → impl 拆 backend hub + node + frontend swap 三组并行.

---

## 1. Audit findings

### 1.1 #260 已有 v2 design

s2agi 在 #260 评论里给了 4 段 design (Part I 配置 + Part II 创建节点 + v2 折入通信牛 co-review). 本 RFC **沿用 v2 方向**, 不重写, 落 P1 impl 细节. v2 已 review 通过的核心契约:
- SSE doorbell `{type:"config_update", update_id}` (payload-free)
- MCP `update_node_config` (utok_) / `get_config_update` (ntok_) / `ack_config_update` (ntok_)
- `report_status` 扩展带 masked `config_snapshot` (dashboard 不碰本地文件就能显示当前值)

### 1.2 launchAgent 现状 (`agent-network/bin/cli.ts:2647`)

```
launchAgent(id, forceNewSession)
  └─ spawn("agent-node" | "npx -y @sleep2agi/agent-node@preview", agentArgs, {stdio:"inherit"})
       └─ child.on("exit", code => { rm .pid; if (code) process.exit(code); resolve() })
       └─ child.on("error", err => { rm .pid; log; resolve() })
```

✓ Parent process 已存在 + 写 .pid + #138 fix 保 parent 不抛 child
✗ 没 supervisor loop — child 死 parent 死
**→ 这里就是要升级成 superviseChild 包裹的关键点**

### 1.3 agent-node config-loading 现状 (`agent-node/src/cli.ts`)

- `fileConfig` 在启动时 `loadJson(--config 参数)` 一次, 不热加载
- 个别字段 (token) 已有 `reloadNodeToken()` (cli.ts:~2990, 401 SSE 触发) — 热加载的 precedent
- 6 flags 当前都是 init-time const (从 `fileConfig.flags?.X` 读). 热加载需把 `maxTurns/budget/timeout` 改成 mutable obj per-think 读

### 1.4 hub 现状

- `nodes` 表 (v3 schema, `server/src/db.ts:~120`) 存 alias/network_id/hub_url/...; **不含** `desired_config` / `config_revision` 列 → 需 migration
- `pushEvent(sessionName, event, networkId?)` (`server/src/push.ts:330`) — SSE doorbell 推送, 已成熟 (用于 `new_task` / `broadcast` / 跨租户隔离), 直接复用
- MCP tool 实现 pattern in `server/src/tools.ts` (~700 行, 含 `report_completion` / `send_task` / `register` 等 ~30 工具) — 加 3 个新工具按现有 pattern

### 1.5 Dashboard frontend (PR #9/#10/#11) 契约 — **已 ship mock 模式**

```
GET  /api/anet/node-config?node_id=<id>
     → { node_id, model, flags: {permissionMode, dangerouslySkipPermissions, teammateMode, maxTurns, budget, timeout}, mock?: true }

POST /api/anet/node-config
     body: { node_id, model?, flags?: {...} }
     → { applyId, status: "pending", mock?: true }

GET  /api/anet/node-config?apply_id=<id>
     → { status: "pending" | "applied" | "rejected" | "timeout", error?: string }
```

- Frontend 1.5s poll, 30s ceiling
- Flags whitelist hardcoded (UI 不能 smuggle 额外 key)
- 三 `HUB_*_PATH` 常量在文件顶部, 后端 ready 一行 swap

---

## 2. 契约 (后端落地)

### 2.1 SSE doorbell (复用现有 `pushEvent`)

```json
{ "type": "config_update", "update_id": "cu_<uuid>" }
```

Payload-free per #260 v2 (节点 pull 拿完整 patch). 复用现有 `pushEvent(alias, event, networkId)` — 零新基础设施.

### 2.2 MCP tools (新 3 个)

| Tool | Caller | 入参 | 出参 | 鉴权门 (network-scoped, **每条都必查**) |
|---|---|---|---|---|
| `update_node_config` | utok_ (dashboard) | `{ node_id, base_revision, patch: {model?, flags?} }` | `{ update_id, revision: number }` 或 409 | (a) caller utok_ 有效 + (b) **`node.network_id == caller.effectiveNetId`** (同 #275 防护带, 即使 dashboard 已 enforce 也必再查 — dashboard 可绕过) + (c) role gate (role≠viewer 起步; 安全敏感 flag 见 §4 「min role」列) + (d) base_revision 匹配当前 (else 409 revision_conflict) + (e) flag allowlist + (f) enum/range validate + (g) 单飞 (同 node 已有 pending → 409 update_in_flight) |
| `get_config_update` | ntok_ (node 自己) | `{}` | `{ update_id, patch, apply_mode, base_revision } \| null` | (a) caller ntok_ 解析出 callerAlias + (b) **拉的 update.node_id ↔ callerAlias 必匹配** (节点拉不到别 network 节点的 update) + (c) update.network_id 也必匹配, 防 SQL JOIN 跑偏 |
| `ack_config_update` | ntok_ | `{ update_id, status: "applied"\|"rejected"\|"restarting"\|"timeout", new_revision?, error? }` | `{ ok }` | (a) caller ntok_ → callerAlias + (b) **update.node_id ↔ callerAlias 匹配** (别 network 节点不能 ack 它的 update) + (c) update_id 仍为当前 pending (else stale ignored, 不报错) |

**SEC-1 (cross-tenant write 防护带)**: 上面 (b) 每条都必须 hub-side 校验. 不可仅靠 dashboard `/api/anet/node-config` 路由先做一次 — 浏览器侧可被绕 (curl 直接打 hub MCP endpoint). 这条跟 #275 跨租户 `parent_task_id` 写防护带同源, **每个新工具都必须独立 re-check**.

**`apply_mode`** 是 hub 校验时按字段 tier 矩阵决定的提示 (`hot` / `restart`), 节点据此走不同 path. 节点也可自己 fallback 保护 (e.g. 永不 hot-apply model).

### 2.3 Apply lifecycle (FE 看到的状态机)

```
saving → applying → applied      // 成功
                  → rejected     // 校验失败 / crash-loop / unsupported field
                  → timeout      // 30s 未 ack (节点 offline / 卡 in-flight)
       → error                   // POST 失败 (4xx/5xx, 不到 hub)
```

---

## 3. Schema migration

### 3.1 `nodes` 表加列

```sql
ALTER TABLE nodes ADD COLUMN config_revision INTEGER DEFAULT 0;
-- 当前 last-known-good revision; 每次 node ack applied 时由 hub 提升
ALTER TABLE nodes ADD COLUMN config_snapshot TEXT;
-- 节点 report_status 时上报的 masked config (secrets 不进库), dashboard GET ?node_id 直接读
```

### 3.2 新 `node_config_updates` 表 (pending + history)

```sql
CREATE TABLE node_config_updates (
  update_id        TEXT PRIMARY KEY,
  node_id          TEXT NOT NULL,
  network_id       TEXT NOT NULL,           -- 跨租户隔离 (#275 防护带)
  patch_json       TEXT NOT NULL,            -- {model?, flags?}
  apply_mode       TEXT NOT NULL,            -- "hot" | "restart"
  base_revision    INTEGER NOT NULL,
  status           TEXT NOT NULL,            -- "pending" | "applied" | "rejected" | "restarting" | "timeout"
  error            TEXT,                     -- when status=rejected/timeout
  created_at       INTEGER NOT NULL,         -- ms
  created_by_token TEXT NOT NULL,            -- utok name (audit)
  acked_at         INTEGER,
  new_revision     INTEGER                   -- set when status=applied
);
CREATE INDEX idx_ncu_node_status ON node_config_updates(node_id, status);
CREATE INDEX idx_ncu_network ON node_config_updates(network_id);
```

每节点同时只允许 1 个非终态 update — 第 2 个 POST 时 hub 返 409 `update_in_flight` (per 通信牛 v2 [牛3] 单飞), dashboard 在 toast 里显示「上一次设置还在生效中, 请稍候」.

Migration 跟现有 `must_change_password` (P0-2 PR #264) 同 pattern — `try { ALTER TABLE ... } catch (e) { if (!/duplicate column|already exists/i.test) throw }` 兼容 0.8.8 → 0.9.x 升级.

---

## 4. 分级 apply 矩阵 (per 通信龙 2026-06-28 关键纠正 + SEC-2 role-gating)

| 字段 | 当前如何使用 | 类别 | 应用路径 | **Min role to change** | Reasoning |
|---|---|---|---|---|---|
| `model` | claude SDK options 启动时一次, codex Codex.startThread, grok runtime args | **restart-required** | sentinel re-spawn | `member` (运行成本影响, 不是提权) | SDK 实例已 bound 到 model, 切换需新进程 |
| `flags.permissionMode` | claude SDK options 启动一次 | **restart-required** | sentinel re-spawn | **`admin`** (提权 — 决定 agent 跟工具/文件如何交互) | SDK options 不可热改 |
| `flags.dangerouslySkipPermissions` | claude SDK / codex Codex options 启动一次 | **restart-required** | sentinel re-spawn | **`admin`** (从远程把节点开成 skip-permissions = 提权红线; 必须最严 role) | 同上 |
| `flags.teammateMode` | claude SDK options 启动一次 | **restart-required** | sentinel re-spawn | **`admin`** (改 agent 主动 dispatch 边界, 跨 agent 触达面影响) | 同上 |
| `flags.maxTurns` | per-think SDK options (option.maxTurns 每次 query 传) | **hot-reloadable** | 写文件 + in-process reload | `member` (用量节流) | 已 per-call 读, 改 mutable obj 即可热 |
| `flags.budget` | per-think 计数 (agent-node 本地节流, 非 SDK) | **hot-reloadable** | 同上 | `member` (用量节流) | 同上 |
| `flags.timeout` | resolveTimeoutMs 启动时 read env/flag; CLAUDE_TIMEOUT_MS 是 module-level const | **restart-required** (今天) | sentinel re-spawn | `member` (vendor 响应等待) | 现有 const 读不可热. (P2: 改成 per-think 读后转 hot) |

**SEC-2 — Security-sensitive flag role gating (硬保证)**:

权限/边界类 flag (`permissionMode` / `dangerouslySkipPermissions` / `teammateMode`) **必须** `admin` role 才能远程改. 默认 hub 校验 (per §2.2 (c)): patch 含任一 security-sensitive flag → caller role 必须 `admin`, 否则 reject 403 `insufficient_role_for_security_flag`. Hub-side enforcement, dashboard 也应同步 gate (UI 灰掉) 但 hub 不信 dashboard 已 gate.

理由: 从 dashboard 远程把节点翻成 `dangerouslySkipPermissions=true` 等于把"任意 tool call 自动 approve"远程开启. 这是 v0.11 公网时代必须挡的提权向量 — 跟 [B1] telegram allowFrom fail-closed (#276) 同源 (默认安全 + 显式提权要 admin).

**核心收益**: 用户改 maxTurns/budget 一类 token 节流配置秒级生效零重启; 改 model/权限模式接受 5-10s 重启等待 — 大多数日常调整是前者. 安全 flag 提权操作通过 role 拦住非 admin 用户.

`apply_mode` 由 hub 校验时按 patch 字段计算: 任一字段是 restart → mode=restart; 全 hot → mode=hot.

---

## 5. 时序图

### 5.1 Restart path (model / permissionMode / DSP / teammateMode / timeout)

```
Dashboard              hub (commhub-server)              agent-node (parent supervisor)         agent-node (child)
   │                          │                                       │                                  │
   │ POST node-config         │                                       │                                  │
   │ {patch, base_rev}        │                                       │                                  │
   │─────────────────────────▶│                                       │                                  │
   │                          │ validate role + tier + enum/range     │                                  │
   │                          │ INSERT node_config_updates(pending,   │                                  │
   │                          │   apply_mode=restart)                 │                                  │
   │                          │ pushEvent(alias, {                    │                                  │
   │                          │   type:config_update, update_id})     │                                  │
   │                          │──────────────────────────────────────▶│ SSE event                        │
   │ {applyId, pending}       │                                       │                                  │
   │◀─────────────────────────│                                       │                                  │
   │                          │                                       │ child invokes MCP                │
   │                          │◀──────────────────────────────────────│ get_config_update                │
   │                          │   returns patch + apply_mode=restart  │                                  │
   │                          │──────────────────────────────────────▶│                                  │
   │                          │                                       │ child:                           │
   │                          │                                       │  - re-validate enum/range        │
   │                          │                                       │  - drain in-flight think         │
   │                          │                                       │    (wait CLAUDE_TIMEOUT_MS,      │
   │                          │                                       │     hard-cap 60s)                │
   │                          │                                       │  - cp config.json .prev          │
   │                          │                                       │  - atomic write config.json      │
   │                          │                                       │    (.tmp + rename)               │
   │                          │                                       │  - .restart-intent file written  │
   │                          │◀──────────────────────────────────────│ ack_config_update(restarting)    │
   │                          │   status="restarting" stored          │                                  │
   │ GET ?apply_id            │                                       │                                  │
   │ (1.5s poll)              │                                       │                                  │
   │─────────────────────────▶│                                       │                                  │
   │ {status: pending}        │                                       │                                  │
   │◀─────────────────────────│                                       │ process.exit(75)  ─────────────▶ EXIT
   │                          │                                       │                                  │
   │                          │                  parent superviseChild │                                  │
   │                          │                  sees exit code 75 →   │                                  │
   │                          │                  re-spawn child + rewrite .pid + arm 30s stable timer    │
   │                          │                                       │ NEW CHILD: ───────────────────▶  │
   │                          │                                       │  - read config.json (new)        │
   │                          │                                       │  - validate; on fail → exit 76   │
   │                          │                                       │    (parent rollback .prev)       │
   │                          │                                       │  - boot OK, SSE connect          │
   │                          │◀──────────────────────────────────────│ register + report_status         │
   │                          │                                       │   carries new config_snapshot    │
   │                          │ promote config_revision = new         │                                  │
   │                          │◀──────────────────────────────────────│ ack_config_update(applied,       │
   │                          │ stable-timer 30s 后 promote LKG       │   new_revision)                  │
   │ GET ?apply_id            │                                       │                                  │
   │─────────────────────────▶│                                       │                                  │
   │ {status: applied}        │                                       │                                  │
   │◀─────────────────────────│                                       │                                  │
   │ toast: ✓ 配置已生效      │                                       │                                  │
```

### 5.2 Hot path (maxTurns / budget)

```
Dashboard              hub                                agent-node
   │ POST                    │                                       │
   │────────────────────────▶│                                       │
   │                          │ validate, INSERT pending,             │
   │                          │ apply_mode=hot                        │
   │                          │ pushEvent doorbell                    │
   │                          │──────────────────────────────────────▶│
   │ {pending}                │◀── get_config_update ─────────────────│
   │                          │── patch + apply_mode=hot ────────────▶│
   │                          │                                       │ - validate
   │                          │                                       │ - atomic write config.json
   │                          │                                       │ - update in-process mutable
   │                          │                                       │   flags obj (no restart)
   │                          │◀── ack(applied, new_revision) ────────│
   │ GET ?apply_id 1.5s       │ status="applied"                      │
   │────────────────────────▶│                                       │
   │ {applied}                │                                       │
```

Hot path 5-10× 快, 适合频繁调试 (调 maxTurns 时不希望节点重启抛掉对话 history).

---

## 6. 守护机制 (硬保证 — 永不 brick 节点)

### 6.1 两层校验

- **Hub 校验** (写 update 前): role gate + node 在 user network + flag allowlist + enum/range
- **Node 校验** (写 config 前): 同 allowlist + 同 range + 二次 enum 验
- 任一层不过 → reject + 节点继续跑旧 config + dashboard 显示原因

### 6.2 原子写

参考 `writeAccessJsonAtomic` (agent-network/bin/cli.ts:1543, #261 P0-1 catch) 同 pattern:
```ts
const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
writeFileSync(tmp, JSON.stringify(merged, null, 2) + "\n");
renameSync(tmp, path);
```
Ctrl-C / 磁盘满 / 并发写都不会留半 config.

### 6.3 .prev backup

写新 config 前 `cp config.json config.json.prev` (atomic copy). 新 config 失败时回滚.

### 6.4 Boot self-heal

启动时 `loadJson(config)` 抛错 OR validate 不过 → 检查 `config.json.prev` 存在且 valid → 自动 copy 回 config.json + 大声 `warn` log + 继续启动. 坏 config 永远不能 brick 节点 (符合 v2 §3 [v2-§3-4]).

### 6.5 Crash-loop guard

借用刚 ship 的 `superviseChild` (PR #284) stable-timer:
- 父 spawn 新 child 后 arm 30s timer
- 新 child 30s 内退出 (非 sentinel 75) → 推断 config 改坏 → 父自动 `cp .prev config.json` + 重 spawn (一次重试)
- 再崩 → 停止 supervisor loop + ack rejected("crash-loop after config change") — 不进入无限重启
- 30s 后还活 → 提升 config 为 last-known-good (lkg) + 之后任何崩溃只 respawn 同 config, 不回滚

符合 v2 §3 [v2-§3-5] + 通信牛 [牛9].

### 6.6 Drain in-flight task

收到 restart-required apply, child 进 drain:
- 标 thinkQueue 为 "draining" — 不接新 task
- 等当前 in-flight think 完 (有 timeout, hard-cap 60s)
- 60s 后强制退 (write final ack 之前)
- v0.11 不实现 "warm handoff" (新进程拿旧 think 状态续) — 太复杂, P2 探

### 6.7 Sentinel exit code

`process.exit(75)` 是 restart 信号 (`EX_TEMPFAIL` BSD 习惯, 给监督进程"暂时性失败请重试"语义). 父 superviseChild loop 只对 code === 75 重 spawn; 其他 code → 走现有 exit 路径 (parent exit code 同).

无 supervisor wrapper 跑的 bare agent-node (用户直接 `bun run agent-node ...` 而不是 `anet node start`): config_snapshot 上报 `config_update_capable: false`, dashboard 显示"该节点不支持远程重启 — 用 anet node start 启动"提示, POST 时 hub 直接 reject.

---

## 7. 测试计划

### 7.1 Unit (agent-node + server)

```
server/src/tools.test.ts (扩):
  - update_node_config rejects non-network user
  - update_node_config rejects bad flag key (allowlist)
  - update_node_config rejects out-of-range value
  - update_node_config 409 on revision_conflict
  - update_node_config 409 on update_in_flight
  - get_config_update returns null when no pending
  - ack stale update_id ignored (no state change)
  - apply_mode computed: any restart field → restart

  # SEC-1 cross-tenant write防护带 (跟 #275 cross-tenant-injection.test.ts 同 pattern)
  - update_node_config: netA user → netB node = 403 cross_network_node
  - get_config_update: netA node ntok_ → cannot pull netB node's update
  - ack_config_update: netA node ntok_ → cannot ack netB node's update
  - update_node_config: utok_ w/ default network (null) → cannot touch named-network node
  - update_node_config: utok_ w/ named network → cannot touch default-network node
  - 同 network 内 cross-node: netA member 改 netA node-1 (其它人的) — allowed only if has network-wide write role

  # SEC-2 role gating for security-sensitive flags
  - update_node_config: member role + patch={flags:{permissionMode:"default"}} = 403 insufficient_role
  - update_node_config: member role + patch={flags:{dangerouslySkipPermissions:false}} = 403
  - update_node_config: member role + patch={flags:{teammateMode:true}} = 403
  - update_node_config: admin role + same security patch = 200 ok
  - update_node_config: member role + patch={model, flags:{maxTurns:10}} (no security flag) = 200 ok

agent-node/src/runtime/config-apply.test.ts (新):
  - tier classifier (hot vs restart per field)
  - validate (allowlist + enum)
  - atomic write (no tmp leak on success/error)
  - .prev backup (rotate)
  - boot self-heal (corrupt config + .prev valid → restored)
  - boot self-heal (corrupt config + .prev corrupt → fatal)
  - hot apply: writes config + updates mutable flags obj + no exit
  - restart apply: drain + write + exit 75
```

### 7.2 Docker e2e

```
tests/docker-e2e/config-apply.test.ts (新):
  - 启 hub (P0-2 random admin) + 1 node + dashboard mock client
  - POST hot patch (maxTurns) → ack applied < 3s → verify config.json + in-process mutable flag
  - POST restart patch (model) → ack restarting → exit 75 → re-spawn → ack applied < 15s → /health version 不变 PID 变
  - POST bad patch → 400 rejected
  - POST revision conflict → 409
  - Kill child during drain → parent 重试 → eventual ack
```

### 7.3 Vincent UAT 模板

```
- [ ] Dashboard 改 maxTurns 5 → 10 → save → toast 5s 内变 ✓
- [ ] Dashboard 改 model → save → toast 15s 内变 ✓ (节点重启了一次)
- [ ] Dashboard 同时改 model + maxTurns → restart 路径 (混合 patch 走更严格 mode)
- [ ] Dashboard 改 permissionMode → save → 之后所有 think 用新权限 ✓
- [ ] 故意改 model 到不存在 vendor → toast 显示 rejected 原因
- [ ] 节点 offline 状态改配置 → toast 显示 timeout
- [ ] 两 dashboard 客户端同时改同一节点 → 第 2 个收到 409 update_in_flight
```

---

## 8. Vincent confirm checklist (merge 前)

| 项 | 默认 | 备选 |
|---|---|---|
| **re-exec 信号码** | `process.exit(75)` (BSD EX_TEMPFAIL) | 76? 自定义? |
| **drain in-flight think hard-cap** | 60s | 30s / 90s / 跟 CLAUDE_TIMEOUT_MS 同 |
| **`config.json.prev` 保留代** | 1 代 (单文件 rotate) | N 代 (`.prev.N`) — v0.12 可加 |
| **Crash-loop ceiling** | 30s 内再崩 → reject | 阈值 / 重试次数可调 |
| **Hot vs restart 分类** | 见 §4 矩阵 | model 是否可热? 当前判否, 求证 |
| **Bare 节点行为** | hub reject + dashboard 提示 | 给 daemon-less 节点降级一个 "guidance" 提示 |
| **dashboard apply timeout** | 30s ceiling | 跟 hub poll 同 / 长一些 |
| **SEC-2 — 谁能远程改 security-sensitive flag** (`permissionMode` / `dangerouslySkipPermissions` / `teammateMode`) | `admin` role 起步 | `owner` only? 完全禁远程 (CLI-only)? |
| **SEC-1 — network 跨边界例外** | 严禁 (即使 owner 跨 network 也拒) | owner 可跨网 (信任顶 role)? |
| **`model` 是否算 security flag** | 不算 (运行成本影响, 不提权) | 也算 (能引上无审 vendor 也算风险面)? |

---

## 9. P1 工序 (file:line anchors)

### Hub (server)

| ID | 改 | 文件 | LOC est |
|---|---|---|---|
| B1 | `update_node_config` MCP tool | server/src/tools.ts:~700 (跟 register/send_task 同 pattern) | ~80 |
| B2 | `get_config_update` + `ack_config_update` MCP tools | 同 | ~60 |
| B3 | Schema migration | server/src/db.ts:~120 (跟 must_change_password 同 try/catch) | ~25 |
| B4 | `pushEvent(alias, {type:"config_update", update_id})` 接 B1 | server/src/index.ts:~1900 (跟 new_task pushEvent 同) | ~5 |
| B5 | `/api/nodes/<id>/config` GET (dashboard 读 snapshot) | server/src/index.ts | ~30 |
| B6 | `report_status` 扩展带 config_snapshot | server/src/tools.ts | ~15 |

### Agent-node

| ID | 改 | 文件 | LOC est |
|---|---|---|---|
| N1 | SSE event handler 加 `config_update` 分支 | agent-node/src/cli.ts:~3146 (跟 new_task/broadcast 同) | ~10 |
| N2 | `processConfigUpdate(updateId)` — pull + validate + write + apply | agent-node/src/runtime/config-apply.ts (NEW) | ~150 |
| N3 | Tier classifier (`flags.maxTurns/budget` 改 mutable obj, per-think 读) | agent-node/src/cli.ts (find call sites) | ~40 |
| N4 | Atomic write + .prev backup + boot self-heal | agent-node/src/runtime/config-apply.ts | (in N2) |
| N5 | Sentinel exit 75 path | agent-node/src/cli.ts shutdown extend | ~15 |
| N6 | `config_snapshot` build (masked) — report_status 上报 | agent-node/src/cli.ts (reportStatus) | ~25 |

### Frontend (mock → live swap)

| ID | 改 | 文件 | LOC est |
|---|---|---|---|
| F1-swap | `HUB_GET_PATH` / `HUB_UPDATE_PATH` / `HUB_APPLY_STATUS_PATH` 三常量改成真 path | app/api/anet/node-config/route.ts | 3 行 |
| F2-banner | 去掉 "后端未接入·模拟" banner (mock=true 走 live 后自动消失) | NodeSettingsPanel.tsx | (已 PR #11 自适应) |

### Wrapper (parent launchAgent supervisor)

| ID | 改 | 文件 | LOC est |
|---|---|---|---|
| W1 | 把 launchAgent spawn child 用 `superviseChild` (PR #284) 包裹, code 75 重 spawn + 重写 .pid + 30s stable timer | agent-network/bin/cli.ts:2782 | ~60 |

---

## 10. P2 future scope (out of v0.11)

- **Channel binding (A)** — telegram/feishu/wechat 绑定 (`channels[]` 字段 + per-channel sub-config)
- **Ops button (D)** — restart / stop / new-session / 重置 token
- **Runtime 改** (claude-agent-sdk ↔ codex-sdk ↔ grok-build-acp) — 加双重 confirm + verify after start
- **Hub 改** — 切 hub URL 加 reachability check + 二次 confirm
- **True hot-reload for model/systemPrompt** — 把 SDK 重新 instance per-think (大改, 性能影响要测)
- **多代 .prev rotate (`.prev.N`)** — 跨多次坏 config 仍可回到更早 good
- **Cross-machine create node (Part II from #260)** — host-daemon, 走 RFC-025 (本 RFC 不含)

---

## 11. Risks

| 风险 | 缓解 |
|---|---|
| Restart 期间丢 in-flight task | drain timeout (60s) + 上层 task 已落 hub `inbox` 表, 父 supervisor 重 spawn 后 child 自动 processInbox 重拾 |
| .prev 没法回滚 (磁盘满 / 权限) | atomic write 用 tmp+rename 已能 catch 大半 IO 错; 真 IO 错由 superviseChild `onError` 路径 surface + reject ack |
| **跨租户 update_node_config (恶意 utok 直接打 hub MCP, 绕过 dashboard 鉴权)** | SEC-1 — 每条新 MCP tool hub-side 必查 `node.network_id == caller.effectiveNetId` + node-pull/ack 工具校验 `update.node_id ↔ callerAlias`. 跟 #275 跨租户 parent_task_id 写防护带同 pattern; §7 cross-tenant test 案例 pin 6 路. **绝不可仅靠 dashboard 路由先 gate** — curl 直接打 hub `/mcp` endpoint 是真攻击面 |
| **远程 dashboard 把节点开成 `dangerouslySkipPermissions=true`** = 提权红线 | SEC-2 — security-sensitive flag 必 admin role 才能改 (§4 matrix); hub 收 update 时校验 caller role; non-admin 拒 403. dashboard UI 也应灰掉这几个 input field, 但 hub 不信 dashboard 已 gate |
| Update ID 被截获重放 | update_id 是 hub mint UUID + node_id 绑定; ack 时 hub 校验 update 仍是该 node pending; 重放 stale |
| Bare agent-node (无 supervisor) 收到 restart patch | config_update_capable=false 上报, hub POST 直接 reject |
| 节点 offline 期间累积多个 update | `update_in_flight` 单飞拒第二个; 后续 update 操作者要等前面 timeout 或显式 supersede (P2) |
| Dashboard 鉴权穿透 → hub 必须自己 re-check | hub 端 MCP tool 永不假设上游路由已校验; 每条 tool 自己跑 caller→token→user→role→network_id 校验链 (同现有 send_task / cross-tenant pattern) |

---

## 12. Out of scope

- Creating new nodes from dashboard (Part II from #260, 走 RFC-025 — 需 host-daemon, P3)
- Server-level config (hub 的 config, 走 anet hub config CLI)
- Renaming nodes (RFC-013 另线)
- Secrets editing from dashboard (env._envRef 必须留在 host, 不进 hub DB — v2 §「永不可改」)

---

## 13. Open questions (for reviewer)

1. Sentinel code 75 是否冲突现有 exit code 习惯? (我没在 codebase grep 到, 但 BSD EX_TEMPFAIL 75 是规范)
2. Drain hard-cap 60s 合理? Vincent 跑 30-agent fan-out 时单 think 可达 37s (per CLAUDE_TIMEOUT_MS comment), 60s 留 ~60% headroom
3. P1 范围只 model + 6 flags 是否含 `systemPrompt`? (v2 P1 列 systemPrompt, 通信龙 dispatch 没明示; 默认按 dispatch 不含)
4. `apply_mode=hot` 时如果 patch 全是 hot 字段但其中 maxTurns 当前在用 (mid-think) — 是 wait 完 think 再 hot-apply 还是立即覆盖让下一 think 用新值? (倾向后者: per-think 读 mutable 自然过渡)
5. Hub 校验通过但 node 校验失败 (allowlist drift) 怎么处理? — node ack rejected("validate_local_fail"), hub 标记并 cache 该 node 的 allowlist mismatch 让 dashboard 显示 (alert operator 升级 schema)

---

🤖 Generated with [Claude Code](https://claude.com/claude-code) — pending design review by 通信龙 + 通信N站马 + Vincent confirm on §8 items before impl.

# RFC-027: 节点下线 / 删除 (Stop & Delete Node)

**状态**: 草稿 v1 (design-not-impl)
**作者**: 通信工程马 · 2026-06-29
**派工**: 通信龙 task `a2f244af-0494-40ab-9a5e-dd59ed554656` (RFC-026 P2 设计 lock 后接续)
**Review 路径**: v1 通信龙 first-pass → v2 折反馈 → 通信牛深审 → v3 折 → 通信龙 final → Vincent 拍 → P1 impl 排期
**关联**: RFC-024 (config-apply + restart_node) · RFC-026 (create-node + host-daemon) · #301 Vincent「🔴 下线/删除:后端待设计」

---

## 0. TL;DR

节点生命周期最后一块 — **stop** (停进程保配置) + **delete** (停 + 删配置 + hub 注销 + revoke ntok)。两工具,语义独立,审计独立,破坏性二次确认。复用 RFC-026 §4.4.8 sweeper + §C4 token-bound revoke + RFC-026 §4.3 SEC-1 + RFC-024 restart_node 同款 SSE doorbell + #305 spawn 跟踪。零新基础设施,纯反向操作 surface。

---

## 1. 现状审计

### 1.1 已 ship 的节点生命周期片段

| 阶段 | RFC | 状态 |
|---|---|---|
| **create** | RFC-026 P1 | ✅ ship (v0.11-preview2.4, hub create_node 工具 + daemon SSE doorbell + 11 e2e scenarios) |
| **edit** (config 修改 + 热应用) | RFC-024 PR A/B | ✅ ship (`upsert_node_config` + apply_mode hot/restart) |
| **restart** (重启进程) | RFC-024 + #284 fold | ✅ ship (`restart_node` 工具 + W1 supervisor exit 75 sentinel) |
| **discover server** (P2 多机) | RFC-026 §9 (本月 lock) | 🟡 设计 lock, impl preview3 |
| **stop** (停进程保配置) | **RFC-027** (本) | ❌ 未设计 |
| **delete** (彻底移除) | **RFC-027** (本) | ❌ 未设计 |

### 1.2 现存 ad-hoc 删除路径 (要替换)

- **用户手工**: `pkill -f 'agent-node.*--alias X'` + `rm -rf .anet/nodes/X/` + sqlite3 手 DELETE nodes 行 → 危险, 易残留 orphan ntok / dangling DB 行 / dashboard 仍渲染。
- **anet CLI `anet node delete`** (本地): 只删本机 config dir, 不通知 hub, hub 那边 nodes 行常年留, 用户在 dashboard 还看到「假活」节点。
- **dashboard ⋮ 菜单**: #301 占位 disabled, 没接后端。

这三个都不够 — 删除是分布式动作 (hub + daemon + child + dashboard 视图), 不能任一面单独决定。RFC-027 把它收成一条 race-free 通路。

### 1.3 复用清单 (不重造)

| 来源 | 机制 | 本 RFC 用法 |
|---|---|---|
| RFC-026 §2.5 | SSE doorbell pushEvent 派单 | hub 派 `stop_node` / `delete_node` 给 daemon (新事件 type) |
| RFC-026 §4.3 | SEC-1 跨 tenant 隔离 | 只能停/删调用者所属 network 的节点 |
| RFC-026 §4.4.8 | sweeper + child ntok 元数据 (request_id/token_id/revoked_at) | delete 时主动调 sweeper 的 revoke helper, 非 orphan-only |
| RFC-026 §6 #2 | dashboard 不能改 daemon 配置 | 延伸: dashboard 也不能误用 child-delete 路径删 daemon 自身 |
| RFC-024 | apply_mode + restart_node 同款 finalize 模式 | stop 完成靠 daemon ack + hub 收到 ack 后 transition 状态 |
| #305 | spawn 跟踪 + survival check | daemon 已记 spawn 后 child PID 到本地 log, 本 RFC 扩成 in-memory children_map |
| RFC-025 m1 | cron-lite | 30d backup sweeper 用 (D7) |

---

## 2. 反向操作架构

### 2.1 总览 (一图)

```
┌──────────────────┐
│   Dashboard ⋮    │  user click 「停止」 / 「删除」 (modal 二次确认)
└────────┬─────────┘
         │ POST /mcp tools/call stop_node / delete_node
         ▼
┌──────────────────────────────────────────────────────────────┐
│                       HUB                                     │
│  ① SEC-1 + role gate (caller is admin/owner of node.network) │
│  ② 拒删 daemon 自身 (force-required, 走独立路径)              │
│  ③ in-flight 检查 (default refuse if 任务 pending, force ok) │
│  ④ DB transition: nodes.lifecycle_state = 'stopping' (lock)   │
│  ⑤ inbox enqueue 路径检查 lifecycle_state, 拒 'stopping'/'deleting'│
│  ⑥ pushEvent SSE {type: 'stop_node', request_id, child_node_id} │
│     payload 不含 secret/path; daemon 现场用自己的 children_map  │
└────────────────────┬─────────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────────┐
│                       DAEMON                                  │
│  ① get_stop_request(request_id) → {child_node_id, action,     │
│     delete_config, grace_seconds, force, requesting_token}    │
│  ② 自身 children_map 查 PID + SIGTERM(pid)                    │
│  ③ wait grace_seconds (default 10), pid 还在 → SIGKILL        │
│  ④ pid 真 reaped 后:                                          │
│     - if action='delete' AND delete_config=true:               │
│       mv .anet/nodes/<name>/  →  ~/.anet/deleted/<ts>-<name>/  │
│       chmod 700  (D7 nit: 保密 + secret 不泄露)               │
│     - delete children_map[child_node_id]                       │
│  ⑤ ack_stop_request(status='stopped', exit_signal=SIGTERM|9,  │
│     in_flight_at_action=N, backup_path=...)                    │
└────────────────────┬─────────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────────┐
│                       HUB (finalize)                          │
│  ① 收 ack_stop_request → DB transaction:                      │
│     - if action='stop': nodes.lifecycle_state='stopped'        │
│     - if action='delete':                                      │
│         revoke api_tokens.revoked_at=now WHERE node_id=X        │
│         DELETE FROM nodes WHERE node_id=X                       │
│         (audit_log row 留, 节点行删)                            │
│  ② audit_log INSERT (actor + child + action + signal + ...)    │
│  ③ pushEvent {type:'node_deleted'/'node_stopped'} → dashboard SSE│
│  ④ dashboard 移除/置灰节点卡片                                  │
└──────────────────────────────────────────────────────────────┘

# daemon 30d 后:
# cron-lite job 扫 ~/.anet/deleted/<ts>-*/ , ts < now-30d 则真 rm -rf
# (彻底删, 不留残, D7 nit)
```

### 2.2 两工具语义 (D1)

```typescript
// hub-side, 注册在 server/src/tools.ts
server.registerTool("stop_node", {
  description: "Stop the agent-node child process; keep config dir intact. Reversible via restart_node.",
  inputSchema: z.object({
    child_node_id: z.string().regex(/^node_[a-z0-9_-]+$/),
    daemon_node_id: z.string().regex(/^node_daemon_[a-z0-9_-]+$/),  // C2 token-bound routing
    force: z.boolean().optional().default(false),                    // override in-flight refuse
    grace_seconds: z.number().int().min(5).max(60).optional(),       // override daemon default
  }).strict(),
}, handler);

server.registerTool("delete_node", {
  description: "Stop child + revoke its ntok + delete hub nodes row + (default) backup config dir to ~/.anet/deleted/<ts>/ for 30d.",
  inputSchema: z.object({
    child_node_id: z.string().regex(/^node_[a-z0-9_-]+$/),
    daemon_node_id: z.string().regex(/^node_daemon_[a-z0-9_-]+$/),
    force: z.boolean().optional().default(false),
    grace_seconds: z.number().int().min(5).max(60).optional(),
    delete_config: z.boolean().optional().default(true),              // false = keep config dir
    confirm_alias: z.string(),                                        // dashboard 二次确认输入的名字, hub 校验匹配
  }).strict(),
}, handler);
```

**为什么两工具而非一带 `action` enum**:
- 语义独立, MCP 工具描述读者一眼看明白「stop = 停进程, delete = 彻底删」
- audit 工具名直接区分, 不用看 args
- 未来 stop 可能加 `pause/resume` 派生工具 (跟 RFC-024 restart_node 同模式), 不必塞进 delete 命名空间
- 破坏性级别不同: stop 是低破坏可逆, delete 是高破坏需 confirm_alias 输入 — 强制工具签名差异化让客户端误调 stop 不会触发 delete

### 2.3 race-free 删除状态机 (D5)

```
[active] ──stop_node──▶ [stopping] ──daemon ack──▶ [stopped]
                                                     │
                                                     restart_node
                                                     │
                                                     ▼
                                                  [active]

[active] ──delete_node──▶ [deleting] ──daemon ack──▶ (DELETED, row gone)
[stopped] ──delete_node──▶ [deleting] ──daemon ack──▶ (DELETED, row gone)
```

`nodes.lifecycle_state` 字段 (新加 ALTER COLUMN, 同 RFC-024 模式幂等 try/catch):
- `active` (默认 / 当前所有现存 row)
- `stopping` — hub 已派 stop 给 daemon, 等 ack
- `stopped` — daemon ack 完成, child 进程已死, config 保留
- `deleting` — hub 已派 delete 给 daemon, 等 ack
- (deleted = DB row 不存在)

**race 防护**: 步骤 ④ (DB transition lifecycle_state) 在 ⑥ pushEvent 之前 + ⑤ inbox enqueue 路径同步检查 lifecycle_state — 这样 SIGTERM 已发到 daemon 后, hub 不会再把新任务塞 child inbox。窗口 = 0。

**幂等**: 重复 stop_node 同一已 `stopped` 节点 → 拒 `node_not_active`; 重复 delete_node 同一已 `deleting` 节点 → 拒 `node_already_deleting`. dashboard ⋮ 菜单按 lifecycle_state 改成 「重启 / 删除」 (节点已 stopped 时不显示「停止」)。

### 2.4 daemon-side 停进程算法 (D2 + D3)

```typescript
// agent-node/src/runtime/stop-daemon.ts (new file, 类比 probe-daemon.ts)

interface ChildEntry { pid: number; started_at: number; child_node_id: string; alias: string; }
const childrenMap = new Map<string, ChildEntry>();  // key: child_node_id

// RFC-026 P1 daemon spawn 路径已有 PID, 加一行:
function recordSpawnedChild(child_node_id: string, alias: string, pid: number) {
  childrenMap.set(child_node_id, { pid, started_at: Date.now(), child_node_id, alias });
}

// daemon 重启恢复: 启动时 scan 自己负责的 child nodes 表 (where daemon_node_id=self)
// + ps -ef grep `agent-node.*--alias <alias>` 拼回 children_map (best-effort)
async function rebuildChildrenMapOnBoot() {
  const myChildren = await callHub("list_my_children", { daemon_node_id: self.node_id });
  for (const c of myChildren) {
    const pids = await pgrep(`agent-node.*--alias ${c.alias}`);
    if (pids.length === 1) childrenMap.set(c.child_node_id, { pid: pids[0], started_at: 0, ...c });
    else if (pids.length > 1) warn(`multiple pids for ${c.alias}, leaving children_map untouched`);
  }
}

// stop algorithm
async function handleStopDoorbell(event: { request_id: string }, deps: Deps) {
  const req = await callHub("get_stop_request", { request_id: event.request_id });
  if (!req?.ok) { warn(`get_stop_request failed`); return; }
  const { child_node_id, action, delete_config, grace_seconds = 10, force } = req;

  const entry = childrenMap.get(child_node_id);
  if (!entry) {
    return ackStop({ status: "noop_not_my_child", reason: "child not in my children_map" });
  }

  // SIGTERM → grace → SIGKILL
  let exit_signal: string | null = null;
  try {
    process.kill(entry.pid, "SIGTERM");
    exit_signal = "SIGTERM";
    const reaped = await waitForExit(entry.pid, grace_seconds * 1000);
    if (!reaped) {
      process.kill(entry.pid, "SIGKILL");
      exit_signal = "SIGKILL";
      await waitForExit(entry.pid, 5_000);  // SIGKILL grace 5s
    }
  } catch (e: any) {
    if (e.code === "ESRCH") {
      // already dead between map lookup and SIGTERM
      exit_signal = "ALREADY_DEAD";
    } else throw e;
  }

  // delete_config branch (D7): mv -> ~/.anet/deleted/<ts>-<name>/ + chmod 700
  let backup_path: string | null = null;
  if (action === "delete" && delete_config) {
    backup_path = path.join(os.homedir(), ".anet/deleted", `${Date.now()}-${entry.alias}`);
    await fs.mkdir(path.dirname(backup_path), { recursive: true, mode: 0o700 });
    await fs.rename(`.anet/nodes/${entry.alias}`, backup_path);
    await fs.chmod(backup_path, 0o700);   // 锁权限, secret 不泄露 (D7 nit)
  }
  childrenMap.delete(child_node_id);

  await ackStop({
    status: "stopped", exit_signal, in_flight_at_action: 0,
    backup_path, action, delete_config,
  });
}
```

**关键不变量**:
- 永不 fork/exec 其他二进制, 只 `process.kill` 已 spawn 子进程的 PID (RFC-026 §4.2 攻击面延伸不开)
- backup_path 用 `Date.now()-<alias>` 命名, 即使同名 alias 多次 delete-recreate 不冲突 (scenario K)
- chmod 700 让 secret/env_refs 文件保持 owner-only 可读 (D7 nit)
- `noop_not_my_child` 不报 error: 可能是 daemon 重启后 map 没恢复, hub 重试 / sweeper 接管 (degraded 而非 fail)

### 2.5 30d backup sweeper (D7)

```typescript
// agent-node/src/runtime/deleted-sweeper.ts (cron-lite, RFC-025 m1 复用)

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

async function sweepDeleted() {
  const dir = path.join(os.homedir(), ".anet/deleted");
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const now = Date.now();
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const m = ent.name.match(/^(\d+)-/);
    if (!m) continue;
    const ts = parseInt(m[1]);
    if (now - ts < RETENTION_MS) continue;
    // 真删, 无残留 (D7 nit)
    await fs.rm(path.join(dir, ent.name), { recursive: true, force: true });
    log(`[deleted-sweeper] purged ${ent.name} (age ${Math.floor((now-ts)/86_400_000)}d)`);
  }
}

// 注册到 RFC-025 m1 cron-lite, every 24h
```

「彻底删, 不留残」(D7 nit): `fs.rm({recursive:true, force:true})` 删整 dir 树。不留 `.deleted` 标记, 不软删, 30d 一到就字面删。审计行已 INSERT 进 audit_log, 物理删 OK。

---

## 3. Dashboard UX

### 3.1 节点 ⋮ 菜单

按 lifecycle_state 切菜单项:

| state | 菜单 |
|---|---|
| `active` | `重启` / `停止` / `删除` |
| `stopping` | (loading: 「停止中...」 全 disabled) |
| `stopped` | `启动` / `删除` (停止灰掉, 已停了) |
| `deleting` | (loading: 「删除中...」 全 disabled) |

### 3.2 删除二次确认 modal (破坏性 GitHub-repo 风格)

```
┌────────────────────────────────────────────┐
│  删除节点                                   │
│                                            │
│  这会:                                      │
│    · 停止 demo-bot 子进程 (SIGTERM 10s 内)   │
│    · 注销 hub 中的节点                       │
│    · 移除子节点 ntok                         │
│    · 配置文件备份到 ~/.anet/deleted/        │
│      (30 天内可手动恢复, 过期清理)            │
│                                            │
│  ⚠ 该节点有 2 个 inbox 待处理任务            │
│    □ 强制删除 (会丢失任务)                   │
│                                            │
│  请输入节点名字确认: [______________]        │
│                                            │
│                       [取消]  [删除 demo-bot]│
└────────────────────────────────────────────┘
```

- modal 列出本次删除的所有副作用 — user 知道在删什么
- in-flight count > 0 → 显式标红 + 「强制删除」checkbox (默认未勾, 不勾 modal 「删除」按钮 disabled)
- 「请输入节点名字确认」: GitHub repo delete 风格, 输入文本 ≠ alias 则提交按钮 disabled (匹配破坏性级别)
- confirm_alias 在工具 args 也带, hub 二次校验 — 防 dashboard XSS / replay 攻击绕过 modal

### 3.3 停止 modal (低破坏, 简化)

```
┌────────────────────────────────────────────┐
│  停止节点 demo-bot?                         │
│                                            │
│  · 子进程会被 SIGTERM (10s 后 SIGKILL)      │
│  · 配置保留, 可随时启动                      │
│                                            │
│  ⚠ 该节点有 2 个 inbox 待处理任务            │
│    □ 强制停止 (会丢失任务)                   │
│                                            │
│                       [取消]  [停止]        │
└────────────────────────────────────────────┘
```

无 confirm_alias 输入 (停止是可逆操作, 不到 GitHub-repo 级别)。

---

## 4. 安全边界 (**本 RFC 最重要章节**)

> 反向操作的破坏性 ≥ 创建。stop 是可逆但仍可中断生产任务; delete 是不可逆 (config 30d 后真删)。每层 gate 必须严, 复用 RFC-026 现成不变量。

### 4.1 SEC-1 — 跨 tenant 隔离

复用 RFC-026 §4.3 trust-root: hub `stop_node` / `delete_node` 在 args 校验前先 join `nodes` × `network_members` 检查 caller utok 是 `target_node.network_id` 的 admin/owner 之一。否则 `forbidden_cross_tenant`。

attacker A 即使猜对 child_node_id, 也无法停/删 B 的节点 — `WHERE network_id = ?caller_network AND node_id = ?target` 是 SQL-level enforced。

### 4.2 D6 — daemon vs child role gate

**delete_node 必须拒绝目标是 daemon (role=host_supervisor) 的节点**。

```typescript
// hub-side, delete_node handler 第一道 check
const node = db.get<{role: string}>("SELECT role FROM nodes WHERE node_id=?", child_node_id);
if (node?.role === "host_supervisor") {
  throw new Error("cannot_delete_daemon_via_delete_node — use delete_daemon path (out of scope, RFC-027.5)");
}
```

`delete_daemon` 是独立工具 (本 RFC 不展开, 列入 §7 不在范围), 要求:
- admin only (不是 admin/owner 双开)
- explicit `force=true` 标志
- precheck `WHERE daemon_node_id=X AND lifecycle_state IN ('active', 'stopping')` 必须 0 行 (daemon 不能在还托管 child 时被删)
- 单独 confirm flow

为什么严: daemon 是 host_supervisor 角色, 删 daemon = 拔整台机器 from network, 比删 child 严重一个量级。RFC-026 §6 #2 「dashboard 不能改 daemon 配置」是同源延伸 — daemon 自身的生杀予夺不走 child 工具路径。

### 4.3 in-flight task 保护 (D4)

```typescript
// hub-side, stop_node / delete_node handler:
const inFlight = db.get<{n: number}>(
  "SELECT COUNT(*) AS n FROM inbox WHERE to_node_id=?1 AND delivered_at IS NULL",
  child_node_id,
);
if (inFlight.n > 0 && !args.force) {
  throw new Error(JSON.stringify({
    error: "node_busy_in_flight",
    in_flight_count: inFlight.n,
    hint: "set force=true to override (audit logged)",
  }));
}
if (inFlight.n > 0 && args.force) {
  auditLog("forced_stop_with_in_flight", { in_flight_count: inFlight.n });
}
```

- default refuse → 安全行为, 不丢任务
- force=true → 允许 override, 但 hub audit_log 必写 `forced_stop_with_in_flight`, dashboard modal UI 红字警告 + 强制 user 主动勾 checkbox
- draining 模式 (「不接新任务, 等当前结束再 stop」) — **不在 P2 范围** (列 §7), P3 选

### 4.4 D7 nit — backup 权限 + sweeper 真删

通信龙 nit (task 2a090830):「backup 的 config 可能含 secret/env_refs, 移到 deleted/ 要保持同样权限 (chmod 700 + 不泄漏), 30d sweeper 真删时彻底 (别留残)」.

**impl 保证**:

1. `~/.anet/deleted/` 父 dir 创建时 `mode: 0o700` (mkdir recursive 传 mode)
2. `mv .anet/nodes/<name>/ ~/.anet/deleted/<ts>-<name>/` 后立即 `chmod 700` (即使源 dir 权限松, 移完锁紧)
3. backup dir 内容不解密、不重压缩、保持原 fs 结构 (避免序列化漏掉 acl)
4. sweeper 用 `fs.rm({recursive:true, force:true})` (Node ≥ 14.14) — 不软删, 不打 `.deleted` 标记, 不 mv 到 trash — 真物理删
5. sweeper 删除时不读 dir 内容, 不 log 文件名 (只 log dir 顶层 ts-alias), 避免 secret 名字漏进 log
6. **CI 测试** scenario K (test plan §5): backup dir 创建后立即 `ls -ld` 验 700; 模拟 31d 后 sweeper 跑, `ls ~/.anet/deleted/` 应空

### 4.5 audit log (D8)

复用 RFC-026 §4.5 audit_log 表结构, 加 `action` enum 扩展:

```sql
-- audit_log 已有: id, actor_token_id, actor_user_id, network_id, target_node_id,
--                  action, payload_json, created_at
-- 本 RFC 加 action enum 值: stop_node, delete_node, forced_stop_with_in_flight,
--                            backup_purged, delete_daemon (P3)
```

payload_json 字段每次写齐:
```json
{
  "child_node_id": "node_xxx",
  "daemon_node_id": "node_daemon_yyy",
  "in_flight_at_action": 2,
  "force_used": true,
  "delete_config": true,
  "child_pid_at_action": 1234,
  "exit_signal": "SIGTERM",
  "grace_seconds": 10,
  "backup_path": "/home/user/.anet/deleted/1719647200000-demo-bot",
  "lifecycle_state_before": "active",
  "lifecycle_state_after": "stopped",
  "ts_request": 1719647200000,
  "ts_daemon_ack": 1719647201500
}
```

audit 写入是 transactional — DB lifecycle_state transition + audit_log INSERT 在同一 SQLite transaction 内, 防止 「执行了 delete 但 audit 漏写」 类窗口。

### 4.6 Error catalog (dashboard ↔ hub ↔ daemon)

| 错误 code | 出处 | dashboard 文案 |
|---|---|---|
| `forbidden_cross_tenant` | hub SEC-1 | 「你不在此节点的网络中, 无权操作」 |
| `cannot_delete_daemon_via_delete_node` | hub D6 gate | 「该节点是 host daemon, 走单独管理路径」 (后续给链接) |
| `node_busy_in_flight` | hub D4 refuse | 「节点有 N 个待处理任务, 勾选强制可继续」 |
| `node_not_active` (stop on stopped) | hub state machine | 「节点已停止」 |
| `node_already_deleting` | hub state machine | 「删除进行中, 请稍候」 |
| `confirm_alias_mismatch` | hub confirm gate | 「确认名字不匹配」 (modal UI 已 disabled 不该触发) |
| `daemon_offline_timeout` | hub 60s ack 等不到 | 「该 daemon 失联, 节点标记为 stop_failed, 联系管理员」 |
| `daemon_recheck_force_required` | daemon D6 (if hub gate 漏) | (daemon-level 防御, hub 应该挡住) |
| `noop_not_my_child` | daemon children_map miss | (degraded log, 不冒泡到 user — hub 重试/sweeper 接) |

---

## 5. 分阶段 (P1 MVP, ship target)

### 5.1 P1 MVP scope

- 两工具 (`stop_node` + `delete_node`) hub 注册 + daemon SSE handler + state machine 4 状态
- `nodes.lifecycle_state` schema 扩展 (idempotent ALTER + default 'active' for existing rows)
- 30d backup sweeper (cron-lite, daemon-side)
- audit_log action enum 扩展
- Dashboard ⋮ 菜单 + 停止/删除 modal (二次确认 + in-flight 显示)
- 11 e2e scenarios (本 §5.2)
- **不**: drain mode / 批量删 / delete_daemon (列 §7)

**ETA impl** (lock 后):
- hub: ~2d (两工具 + state machine + audit + SEC-1/D6 gate + in-flight refuse + finalize ack)
- daemon: ~2d (stop_daemon.ts + children_map + SIGTERM→SIGKILL + backup mv + chmod + sweeper)
- dashboard: ~1.5d (⋮ 菜单 + 两 modal + confirm_alias 输入 + SSE 状态同步)
- e2e + 安全 测试: ~1d
- 总 ~6-7d, ship preview3+

### 5.2 P1 Docker e2e — 11 scenarios

mirror RFC-026 P1 e2e style: each scenario 独立 docker container + isolated hub port + isolated `COMMHUB_DB` (per [[feedback_no_test_on_prod]]).

| # | scenario | 期望 |
|---|---|---|
| A | stop happy path — active node, no in-flight | SIGTERM → reaped <10s; lifecycle_state=stopped; config dir 保留 |
| B | stop + in-flight (default refuse) | error=node_busy_in_flight + in_flight_count returned; nothing killed |
| C | stop + in-flight + force=true | killed + audit_log forced_stop_with_in_flight + in_flight_at_action=N 记录 |
| D | delete happy path — active node, no in-flight | SIGTERM → reaped; ntok revoked; nodes row gone; backup dir `~/.anet/deleted/<ts>-<alias>/` 创建 + chmod 700 |
| E | cross-tenant SEC-1 (netA admin delete netB node) | error=forbidden_cross_tenant; netB node 完好 |
| F | delete daemon via delete_node path | error=cannot_delete_daemon_via_delete_node; daemon 完好 |
| G | daemon offline mid-stop (hub push 后 daemon 死) | 60s ack timeout → lifecycle_state=stop_failed + audit + dashboard 报错 |
| H | child 不理 SIGTERM (busy loop ignoring) | grace 10s 超 → SIGKILL → reaped <5s; exit_signal=SIGKILL recorded |
| I | delete + 立即同名 recreate | recreate 成功 (无 orphan ntok 阻挡); new child_node_id ≠ deleted one; audit_log 两行独立 |
| J | delete_config=false | child killed; nodes row gone; ntok revoked; `.anet/nodes/<alias>/` 保留原地; backup dir 不创建 |
| K | backup dir 30d 后 sweeper 真清 | scenario D 创建 backup → 模拟 ts 改 (mtime -32d) → sweeper 跑 → backup dir 不存在; audit_log backup_purged 一行; 父 `~/.anet/deleted/` 整洁 |

每场景独立 Dockerfile, 共用 `tests/qa-rfc027-stop-delete/` 目录。

---

## 6. 8 决策 lock 表 — 通信龙 v1 review 全锁

| # | 决策 | 锁定理由 |
|---|---|---|
| D1 | **两工具 (stop_node + delete_node)** 而非一带 action enum | 语义独立, audit 直接区分, 客户端误调 stop 不会触发 delete, 破坏性级别可在工具签名差异化 |
| D2 | **daemon stop 算法 = children_map + SIGTERM→grace→SIGKILL** | children_map 在 spawn 时填 + boot 时 pgrep 恢复; 永不 fork/exec 其他二进制 (RFC-026 §4.2 攻击面不开) |
| D3 | **grace_seconds 默认 10s, daemon config 可调 5-60** | 落到 #305 spawn 严格校验风格; SIGKILL 后另 5s 等 reap |
| D4 | **in-flight task default refuse, force=true override + audit** | 安全优先; force 走单独 audit action `forced_stop_with_in_flight` + dashboard UI 红字 + checkbox 强制主动勾 |
| D5 | **race-free order: marking → push → ack → revoke → delete + inbox enqueue 检 lifecycle_state** | 「SIGTERM 已发但新任务仍路由」窗口 = 0; state machine 4 状态 + DB transition 在 pushEvent 之前 |
| D6 | **delete_daemon vs delete_node 严格区分** | child 路径不许误删 daemon; delete_daemon 独立工具走 admin+force+no_running_children precheck (本 RFC §7 列, P3 单独) |
| D7 | **config dir 移到 ~/.anet/deleted/<ts>-<alias>/, chmod 700, 30d sweeper 真删** | 「我删错了」30d 回滚窗; secret 不泄露 (mode 700); sweeper `fs.rm recursive force` 不软删不留残; CI 验权限 + 30d 后空 |
| D8 | **audit 全字段 + transactional 写入** | 所有 stop/delete 写齐 payload (in_flight/force/exit_signal/backup_path/state transition + ts); audit INSERT 与 lifecycle_state UPDATE 在同一 SQLite tx |

通信龙 v1 first-pass 全 ack + D7 nit (chmod 700 + 真删) 已折入 §2.4 + §4.4 + §5.2 K (task `2a090830`)。

---

## 7. 不在本 RFC 范围

| 项 | 去向 |
|---|---|
| **delete_daemon** (删 daemon 自身) | RFC-027.5 候选, P3 单独设计 (admin+force+no_children precheck) |
| **drain mode** (「不接新任务等当前结束再 stop」) | P3 候选, 涉及 inbox 语义变化, 单独 RFC |
| **批量删** (`bulk_delete_nodes`) | P3, 跟批量创建配对 |
| **stop 后自动 unbind channel** (telegram/feishu) | RFC-026 §5 P3 channel 绑定一起做 |
| **超大集群: daemon-level batch SIGTERM** | 商业版话题, 开源不做 |

---

## 8. Review checklist — v1 通信龙 first-pass placeholder

- [ ] §1 现状审计 + 1.3 复用清单 ([feedback: 不重造])
- [ ] §2 反向操作架构 + 两工具语义
- [ ] §2.3 race-free state machine 4 状态 (D5 关键)
- [ ] §2.4 daemon stop 算法 (D2 + D3)
- [ ] §2.5 30d backup sweeper (D7 nit)
- [ ] §3 dashboard UX + 二次确认 modal
- [ ] §4 安全边界 (SEC-1 + D6 + D4 + D7 + audit)
- [ ] §5 11 e2e scenarios 覆盖
- [ ] §6 8 决策 lock 表
- [ ] §7 不在范围 (delete_daemon 单独 / drain P3 / 批量删 P3)

**待**: 通信龙 v1 → 通信牛 深审 (重点 D5 state machine race-free 不变量 + D6 误删 daemon 防护边界 + §5 G/H 失败模式覆盖) → 通信龙 final → Vincent 拍 → 派工 P1 impl

---

**作者**: 通信工程马 · 2026-06-29
**Review 路径**: v1 (本) → 通信龙 first-pass → v2 fold → 通信牛 深审 → v3 fold → 通信龙 final → Vincent → P1 impl preview3+

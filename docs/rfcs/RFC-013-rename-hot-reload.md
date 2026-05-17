# RFC-013 — Rename Hot-Reload 跨版本兼容性

**作者**: 通信SDK马
**状态**: Draft v5 (待 通信龙 / Vincent ack; 通信牛 fourth pass review 期望 APPROVE 收尾)
**版本**: v1 (初稿) → v2 (测试马 Phase 1 fold-in) → v3 (通信牛 first design review 4 blocker + 4 concern 整改) → v4 (通信牛 second pass 2 blocker + 1 concern 修) → v5 (通信牛 third pass — §9.1 migrateSSEKeys snippet 终于补 `c.key = newKey`)
**关联 issue**: #146, #84 (rename impl), RFC-010 §4.4 (SIGHUP-based reload)
**关联 ship**: v0.10.0 (rename 2PC), v0.10.2 candidate (本 RFC 实施)

> **v3 变更说明** (通信牛 [comment 4468530...](https://github.com/sleep2agi/agent-network/issues/146)): 通信牛 design review 揭示 v2 §3.3 fallback / §9.2 mutable identity / §3.1 SSE cleanup race / §4 C3 client detection 都不可实施. v3 整改 4 blocker + 4 concern, 引入 **Phase 0 server canonicalization hardening** 作必要 dependency. 实施分 **3 phase** 不再单 phase. LOC ~80 → ~120, ETA ~3h → ~4-5h. 核心设计 (capability probe + SSE re-key + agent hot-reload listener) 不变.

> **v5 变更说明** (通信牛 [comment 4468702289](https://github.com/sleep2agi/agent-network/issues/146#issuecomment-4468702289)): v4 §3.1.7 + §3.7 fix 完整, 但 §9.1 final impl snippet 仍未同步 — 这是同 bug 的第三次出现. v5 §9.1 终于补 `for (const c of arr) c.key = newKey` 行 + 加 inline 注释指向 §3.1.7 cleanup race 解释, 防 future copy 再丢. 纯 1-line snippet fix.

> **v4 变更说明** (通信牛 [comment 4468681](https://github.com/sleep2agi/agent-network/issues/146#issuecomment-4468681)): 通信牛 second pass 揭示 v3 inconsistency:
> - **B1**: §2.5 / §10.5 写了 broadcast 含 `node_id` + listener validate, 但 §3.1 envelope + §9.1 pushEvent snippet + §3.2 listener handler 都漏 → v4 三处补 `node_id`
> - **B2**: §3.1.7 `migrateSSEKeys` snippet 正确, 但 §9.1 final impl sketch 漏 `c.key = newKey` → v4 §9.1 改 = §3.1.7 (consistent)
> - **C1 (non-blocker)**: §3.2 / §3.3 / §9.2 snippets 用 `ALIAS` / `NODE_NAME`, 跟 §3.7 `runtimeAlias` / `runtimeNodeName` 不一致 → v4 统一 + 加 `runtimeNodeId`
> 核心设计 + Phase 划分 + LOC table 不变, 纯 inconsistency fix.

## 1. 背景

### 1.1 现状: `anet node rename` 半完成

v0.10.0 shipped RFC-010 §4.2.1 的 rename 2PC (#84) — server-side SQL cascade (`sessions`/`nodes`/`api_tokens`) 完整 atomic. 但 RFC-010 §4.4 spec 的 SIGHUP-based agent reload 未实施, 留下 `renameCommand` (`agent-network/bin/cli.ts:3166-3169`) 的 known warning:

```
[anet] node was running — tmux session renamed, agent process NOT restarted.
[anet] ⚠ the agent may still report the old alias until it re-reads config
       (RFC-010 §4.4: SIGHUP / per-turn reload — agent-node side).
```

Vincent 5387 实测 (#146) 暴露此 gap: rename 后 `send_task` 给 new alias **server 接到但 agent 收不到**.

### 1.2 Root cause (SDK马 R220+ research, #146 comment)

两处 in-memory state 在 SQL cascade 之外, 不被 rename 触及:

1. **commhub-server `clients` map** (`src/push.ts`) 用 alias 作 SSE 注册 key, rename 后 stale → `pushEvent(NEW, ...)` 找不到 subscriber, 静默 drop.
2. **agent-node `ALIAS` 变量** (`src/cli.ts` module-level) 从 startup 时 config.json 读入, 之后不重读 → 即便 SSE 拿到, 内部仍用 OLD 调 `report_status` / `get_inbox`.

### 1.3 测试马 Phase 1 Docker repro (4/4 FAIL) finding 分类

`docs/tests/p146-rename-repro/` 揭示 4 case 全 FAIL, 但 **错误原因分两种** — 区分是关键:

**Type A: agent-node FATAL exit on envRef missing** (test_rn case)

```
[anet] FATAL: config.json env.ANTHROPIC_AUTH_TOKEN references env var
       "ANTHROPIC_AUTH_TOKEN_N_FDABE56B" but it is not set in this shell.
[anet]        Fix: export ANTHROPIC_AUTH_TOKEN_N_FDABE56B=<your-value>
              then re-run anet node start
```

agent-node by #125 envRef hygiene 默认使用 indirection. test scaffold 没 set 此 env var → agent FATAL exit at startup → 永远没 register → sessions 行不存在 → rename 失败 `node X not found in this network`. 这是 **test scaffold 配置问题, 不是 product bug** — agent 给的 error 已经 actionable. 文档化 + 测试马 scaffold 需 mock env var.

**Type B: CLIENT-side resolveNodeRef miss** (before_c1 / before_c2 cases)

```
[anet] Node "before_c1" not found.
```

此 error 在 cli.ts:3047 `resolveNodeRef(fromRef)` 失败 — 客户端连 server 之前已挂. 真因看 test_log 是 cwd mismatch (anet 命令运行 cwd 跟 node config dir 创建 cwd 不同). 也是 **test scaffold 问题**.

**Type C: Vincent's actual #146 bug** (实测 production)

Vincent **没** hit Type A/B, 因他本地 env var 设了 + anet 命令在节点 cwd 跑. 他的 repro 流程是:
1. `anet node start` → agent successfully online + register + sessions row created
2. `anet node rename foo bar --force` → prepareRename ✅, commitRename ✅, SQL cascade ✅
3. `send_task --alias bar` → server 写 inbox 但**agent 收不到 SSE 推送**

这是真正的 hot-reload missing bug, RFC-013 §3-§4 解决.

### 1.4 多层 finding 总结

| Layer | Issue | 是 product bug? | RFC-013 v2 涵盖? |
|---|---|---|---|
| Type A | envRef missing → agent FATAL → no sessions row | ❌ Test scaffold (envRef hygiene 按设计) | 文档化 + Layer 1 actionable error |
| Type B | resolveNodeRef miss (cwd mismatch) | ❌ Test scaffold | Layer 3 CLI pre-check 提示 |
| Type C | **agent hot-reload missing → send_task NEW silent drop** | ✅ **Product bug, Vincent #146** | §3-§4 (原 RFC-013 核心) |

→ **RFC-013 v2 scope**: Type C primary fix + Type A/B robustness improvements (defensive, 不依赖 test scaffold 修正才有用).

### 1.5 Vincent 5390+5391 硬约束

- **5390 "升级一定要无痛"** — 不接受 process kill / task kill 类 fix (B 方案被否)
- **5391 "兼容性花大功夫"** — 不接受 single-version impl, 必须 cross-version 4 case (旧+旧 / 旧+新 / 新+旧 / 新+新) 全有 deliberate design

故升级 #146 至 RFC level (本文档).

## 2. 目标

1. `anet node rename old new` 之后, `send_task --alias new` 在 running agent **立即** 收到, **不杀进程、不中断任务**, 跨平台 (Linux/macOS/Windows).
2. 跨版本组合 4 case 全有 deliberate design + graceful degradation, 不依赖 lockstep 同步升级.
3. `/health` capability flag 协议留向后扩展空间 (后续类似 hot-reload 场景沿用同一探测机制).

## 2.5 v3 实施分阶 (per 通信牛 review)

| Phase | Scope | 依赖 | 风险 |
|---|---|---|---|
| **Phase 0 — server canonicalization** | `report_status` 在 upsert **之前** canonicalize alias (by node_id 或 committed rename_txn mapping). 修 Blocker 1 race. | 无 (基础层) | 低 — 纯防御性, 不改 wire 协议 |
| **Phase 1 — SSE protocol** | `push.ts` mutable key + `migrateSSEKeys` safe / `rename.ts commitRename` 调用 + `node.alias_changed` broadcast (含 node_id) / `/health.capabilities.rename_broadcast=true` / SSE connect-time `X-Agent-Node-Version` header | Phase 0 | 中 — 修 Blocker 3 SSE cleanup, 新增 capability header |
| **Phase 2 — agent hot-reload** | mutable `runtimeAlias` / `runtimeNodeName` (修 Blocker 2) / SSE listener / capability probe at **每次 reconnect** (修 Concern 1) / 60s alias drift self-check 独立 cadence (修 Concern 2) / Layer 3 CLI pre-check (Type A/B 防御) | Phase 0 + Phase 1 | 中 — 改 agent 内部 identity, 需 audit 所有引用 |

Phase 0 不能省, 不然 Phase 1+2 仍然 race-prone (旧 agent heartbeat undoing 新 alias).

## 3. 协议设计

### 3.0 (Phase 0) Server canonicalization invariant — 修 Blocker 1

**Invariant**: 一个 stale OLD `report_status` heartbeat 不能 revert 已 committed 的 NEW alias.

**Current bug** (通信牛 catch): `report_status` 用 `ON CONFLICT(resume_id) DO UPDATE SET alias = COALESCE(?, sessions.alias)`. rename OLD→NEW 后, 旧 agent 仍发 `report_status({resume_id: same, alias: OLD})` — server 把 OLD 写回 sessions 行, 把 commit 撤销.

**Fix**: 在 upsert **之前** canonicalize. 资源 priority:

```typescript
// commhub-server/src/index.ts report_status handler (insert BEFORE the upsert)
let canonicalAlias = body.alias;
let stalenessDetected = false;

// (a) If client sent node_id, use it as authoritative — alias from nodes table
if (body.node_id) {
  const row = db.get<any>(
    "SELECT alias FROM nodes WHERE network_id = ?1 AND node_id = ?2",
    [body.network_id, body.node_id]);
  if (row?.alias && row.alias !== body.alias) {
    canonicalAlias = row.alias;
    stalenessDetected = true;
  }
}
// (b) Fallback: check committed rename_txn within last 24h (defense for missing node_id)
else {
  const txn = db.get<any>(`
    SELECT new_alias FROM rename_txn
    WHERE network_id = ?1 AND old_alias = ?2 AND status = 'committed'
      AND committed_at > datetime('now', '-24 hours')
    ORDER BY committed_at DESC LIMIT 1`,
    [body.network_id, body.alias]);
  if (txn?.new_alias) {
    canonicalAlias = txn.new_alias;
    stalenessDetected = true;
  }
}

// Upsert uses canonicalAlias (NEVER OLD)
db.run(`... ON CONFLICT(resume_id) DO UPDATE SET alias = ?1 ...`, [canonicalAlias, ...]);

// Response carries canonical_alias so agent can detect drift on next reply
return Response.json({
  ok: true,
  canonical_alias: canonicalAlias,
  staleness_detected: stalenessDetected,
});
```

**Properties**:
- 旧 agent 跑新 server: 它发 OLD heartbeat → server 写回 NEW (因 rename_txn lookup) → response 含 `canonical_alias: NEW`. 旧 agent 不识此字段(忽略), 但 sessions 行不被破坏. 行为等同 C3 graceful degradation.
- 新 agent 跑新 server: 见 §3.3 — 收到 `canonical_alias` 不一致 → 触发 drift self-heal.
- 新 agent 跑旧 server: 旧 server 没 §3.0 protection, 但旧 server 也没 rename hot-reload, 整体 fall back C2.

**Test (per 通信牛 verify-list)**: rename OLD→NEW, 然后 force 一次 OLD `report_status` heartbeat, assert `sessions.alias` 仍是 NEW, response 含 `canonical_alias=NEW`.

### 3.1 Server-side: capability flag + broadcast

**`/health` 响应新增字段** `capabilities` (object):

```json
{
  "status": "ok",
  "version": "0.8.3",
  "capabilities": {
    "rename_broadcast": true,
    "rename_broadcast_version": 1
  }
}
```

`rename_broadcast: true` 表明 server 在 `commitRename` 末尾会做两件事:

1. **In-memory SSE map re-key** — `migrateSSEKeys(oldAlias, newAlias, networkId)` 把 `clients` map 里的 `clientKey(oldAlias, networkId)` 项移到 `clientKey(newAlias, networkId)`. 旧 key 删除. 这让 `pushEvent(newAlias, ...)` 立即能找到 subscriber (即同一个 SSE 连接).
2. **Broadcast `node.alias_changed` event** — push 到**已 re-key 后的 newAlias 流** (即 same SSE connection 跑下来收到), envelope:

```json
{
  "type": "node.alias_changed",
  "event": "node.alias_changed",
  "node_id": "n_3f8abcd1",
  "old_alias": "OLD",
  "new_alias": "NEW",
  "new_node_name": "NEW",
  "network_id": "net_xxx",
  "txn_id": "rtxn_..."
}
```

**v4 注**: `node_id` 是稳定身份, 由 `commitRename` 从 `nodes WHERE network_id=? AND alias=new_alias` 查出后填入 envelope. 用于 §3.2 listener 的 identity validation — 防止 duplicate alias 场景下 rename event 错误 hot-reload 别人的 agent. 旧 server (pre-RFC-013) 不发此事件; 新 server 发但若意外 `node_id` 缺失, agent fallback 到 `old_alias === runtimeAlias` 匹配 (less safe, graceful).

注意: 跟现有 `node.renamed` (RFC-010 §4.2.1 C4 — dashboard 用) 是**两条不同 event** 不复用. `node.renamed` envelope 设计给 dashboard 消费 (含 `surfaces_updated` 列表 etc.), `node.alias_changed` envelope 设计给 agent-node 消费 (只含 reload 必需字段). 这样两边各自演化不交叉.

### 3.1.5 SSE client capability header — 修 Blocker 4

通信牛 catch: 原 §4 C3 "old client warning via stale_clients" 不可实施 — server 没法从 `{controller, encoder}` 知道客户端版本.

**Fix**: 新 agent SSE 连接时携带 capability metadata:

```http
GET /events/<alias> HTTP/1.1
Authorization: Bearer ntok_...
X-Agent-Node-Version: 2.4.1
X-Agent-Capabilities: rename_broadcast.v1
```

Server 在 `createSSEStream` 入参拓展, 存到 client object:

```typescript
type SSEClient = {
  controller: ReadableStreamDefaultController;
  encoder: TextEncoder;
  key: string;  // 修 Blocker 3 — see §3.1
  version?: string;
  capabilities?: Set<string>;
};
```

**C3 graceful warning (软化)**: CLI rename 完成后, server commit 响应携带 `live_sse_clients` 数组 (内含 version), CLI 检测到 `version < 2.4.1 OR !capabilities.has('rename_broadcast.v1')` 时:

```
[anet] ⚠ Found 1 running agent on this alias with old client version (2.4.0).
[anet]    The agent will retain alias "OLD" in memory until restart.
[anet]    Fix:  anet node stop OLD-pid && anet node start NEW
[anet]    Or:   anet upgrade  (upgrade agent-node to ≥2.4.1 for hot-reload)
```

旧 agent 完全不发此 header → server 视为 "unknown version" → CLI warning 仍 fire ("unknown agent version, recommend restart"). **不依赖 positive detection — 默认假设旧, 新 agent 主动声明**.

### 3.2 Agent-side: capability detection + listener

**Boot 时探测**:

```typescript
// agent-node/src/cli.ts startup
const health = await fetch(`${COMMHUB_URL}/health`).then(r => r.json());
const SERVER_SUPPORTS_RENAME_BROADCAST = !!health?.capabilities?.rename_broadcast;
```

**SSE 事件循环新增分支** (cli.ts:1384 旁):

```typescript
if (ev.type === "node.alias_changed" && SERVER_SUPPORTS_RENAME_BROADCAST) {
  // v4 identity validation: prefer node_id (stable), fall back to old_alias match
  // for backwards-compat with rare event-without-node_id case.
  const identityMatches =
    ev.node_id ? (ev.node_id === runtimeNodeId)
               : (ev.old_alias === runtimeAlias);
  if (!identityMatches) {
    debug(`[rename] ignoring node.alias_changed for different identity (event.node_id=${ev.node_id}, mine=${runtimeNodeId})`);
    continue;
  }
  log(`[rename] hot-reload alias ${runtimeAlias} → ${ev.new_alias}`);
  runtimeAlias = ev.new_alias;
  runtimeNodeName = ev.new_node_name || ev.new_alias;
    // SSE 连接保持 (server-side 已 re-key, 同一 TCP/HTTP 连接继续 valid)
    // 立即 re-register 让 server-side 的 sessions row updated_at 刷新
    await register().catch(() => {});
  }
}
```

**注意**: SSE 不需 close+reopen — server 已经 re-key 了 in-memory map, 同一个 HTTP 长连接继续有效, agent 只需更新自身 `ALIAS` 内存变量 + re-register.

### 3.3 Fallback: 周期自检 (broadcast loss 保护)

agent-node 定期 (每 60s, 跟 stale-session 同节奏) 在 `report_status` 响应里 expect server 回 echo `canonical_alias`:

```typescript
// server-side index.ts report_status 响应:
{ "ok": true, "canonical_alias": "<from sessions.alias>" }
```

agent 比对:

```typescript
const resp = await reportStatus(...);
if (resp.canonical_alias && resp.canonical_alias !== ALIAS) {
  warn(`[rename] alias drift detected: local=${ALIAS} server=${resp.canonical_alias} — hot-reloading`);
  ALIAS = resp.canonical_alias;
  NODE_NAME = resp.canonical_alias;
}
```

这是 broadcast 丢失 / 网络分区时的 final safety net. 60s within bound 即可恢复.

### 3.1.7 Mutable SSE client key — 修 Blocker 3

通信牛 catch: `createSSEStream` 闭包捕获 local `key`. `migrateSSEKeys(old, new)` 把数组移到 newKey + delete oldKey 后, 后续连接 cancel 仍按 oldKey 查找清理, fail silent, keepalive timer 不清.

**Fix**: 把 key 存到 client object 而非闭包:

```typescript
// push.ts
type SSEClient = {
  controller: ReadableStreamDefaultController;
  encoder: TextEncoder;
  key: string;   // 当前注册位置 (rename 后会更新)
  version?: string;
  capabilities?: Set<string>;
  _keepalive?: NodeJS.Timeout;
};

function createSSEStream(sessionName, networkId, version?, capabilities?) {
  const initialKey = clientKey(sessionName, networkId);
  const client: SSEClient = { controller, encoder, key: initialKey, version, capabilities };
  clients.get(initialKey) ?? clients.set(initialKey, []).get(initialKey)!.push(client);
  // cancel: 用 client.key (mutable) 找当前注册位置
  cancel() {
    const arr = clients.get(client.key);  // <-- mutable
    if (arr) {
      arr.splice(arr.findIndex(c => c === client), 1);
      if (arr.length === 0) clients.delete(client.key);
    }
    clearInterval(client._keepalive);
  }
}

export function migrateSSEKeys(oldName, newName, networkId): number {
  const oldKey = clientKey(oldName, networkId);
  const newKey = clientKey(newName, networkId);
  const arr = clients.get(oldKey);
  if (!arr) return 0;
  for (const c of arr) c.key = newKey;     // <-- 关键: client object 内部 key 也更新
  const existing = clients.get(newKey) || [];
  clients.set(newKey, [...existing, ...arr]);
  clients.delete(oldKey);
  return arr.length;
}
```

**Test (per 通信牛 verify-list)**: 开 SSE OLD, rename to NEW, close connection, assert `getSSEStats()` 没 OLD 也没 NEW stale entry.

### 3.4 Server-side: prepareRename actionable error (Layer 1 robustness, Type A/B 防御)

Current `prepareRename` (rename.ts:42-46) returns `node "X" not found in this network` when sessions row absent. 此 message **不区分**:
- agent 没起 (Type A: envRef missing)
- agent 起了但 register 失败 (Type B 部分 case)
- alias 真不存在 (合法的 "not found")

**v2 改进**: 错误响应携带 `diagnostic_hint` 字段:

```typescript
// server-side rename.ts:42-46
if (!oldSession) {
  return {
    ok: false,
    error: `node "${oldAlias}" not found in this network`,
    diagnostic_hint: "agent_not_registered",  // 新字段
  };
}
```

CLI 端 renameCommand 看到 `diagnostic_hint: "agent_not_registered"` 显示:

```
[anet] rename PHASE 1 failed: node "foo" not found in this network — rolling back
[anet] 💡 The agent may not have registered with the hub.
[anet]    Check:  anet doctor foo   (verify agent online + env vars set)
[anet]            anet node ls      (status should be "idle"/"working", not "offline")
[anet] rollback complete — "foo" unchanged.
```

→ **零代码风险, 纯 UX 改进**, 对 Type A (envRef) 和 Type B (cwd mismatch) 都有引导. ~5 LOC server + ~10 LOC client.

### 3.5 CLI-side: renameCommand pre-check (Layer 3 robustness)

Current `renameCommand` (cli.ts:3032-3170) 直接进 Phase 1 prepare 不预检. **v2 改进**: 增 pre-check step before Phase 1:

```typescript
// agent-network/bin/cli.ts renameCommand at ~3082:
// PRE-CHECK: verify agent has a live sessions row in the hub
const statusResp = await fetch(`${hub}/api/server/${osHostname()}/agents`, {
  headers: authHeaders(token),
}).then(r => r.json() as any).catch(() => null);
const liveSession = statusResp?.agents?.find((a: any) => a.alias === oldId);
if (!liveSession) {
  console.warn(`[anet] ⚠ "${oldId}" 在 hub 上没找到 live session.`);
  console.warn(`[anet]    可能原因: agent 没起 / envRef env var 没设 / cwd mismatch`);
  console.warn(`[anet]    建议: 先跑 'anet doctor ${oldId}' 验证 agent online`);
  if (!force) {
    console.error(`[anet] Use --force to attempt rename anyway (will likely fail at prepare).`);
    process.exit(1);
  }
  // --force: 让 prepareRename 真试 + 失败时 diagnostic_hint (§3.4) 给精确提示
}
```

→ **不破坏 invariant**, 让用户提前 catch Type A/B 类问题. ~20 LOC.

### 3.7 Mutable runtime identity in agent-node — 修 Blocker 2

通信牛 catch: `ALIAS` / `NODE_NAME` 是 `const`, `ALIAS = ev.new_alias` 不编译; 且 many helpers 闭包捕获 ALIAS.

**Fix**: 引入 runtime identity object:

```typescript
// agent-node/src/cli.ts module-level
const initialAlias = ...;          // 启动时值 (诊断用, 不变)
const initialNodeName = ...;
const initialNodeId = ...;          // NODE_ID — 启动时值, 用于诊断
let runtimeAlias = initialAlias;   // 运行时, hot-reload 可改
let runtimeNodeName = initialNodeName;
const runtimeNodeId = initialNodeId; // v4: node_id 不变 (rename 只改 alias, node_id 是稳定身份);
                                    // 但用 mutable-shaped variable for symmetry + future-proof
                                    // 若有 node_id change scenario (e.g. node clone) 不动 RFC-013
```

**All helpers must read runtime value dynamically** (audit list per 通信牛):

| helper | 改动 |
|---|---|
| `register()` | `body: { ..., alias: runtimeAlias, ... }` |
| `reportStatus()` | `alias: runtimeAlias`, response 检查 `canonical_alias` 触发 drift self-heal |
| `getInbox()` | `alias: runtimeAlias` |
| `ackMessage()` | `alias: runtimeAlias` |
| `sendReply()` | `from_session: runtimeAlias` |
| `connectSSE()` URL | `/events/${encodeURIComponent(runtimeAlias)}` |
| log lines (`log()`, `debug()`, `warn()`, `error()`) | prefix 用 runtimeAlias |
| token reload warning | message 用 runtimeAlias 但保留 initialAlias 在 diagnostic |
| `configFilePath` (per 通信牛 note) | rename 后 oldDir 已删, running process 不 rely 旧 path. Token reload / doctor-refresh 改读 `<.anet/nodes/${runtimeAlias}>/config.json` 而非 cached path |

**Test**: rename 后 5min 任务流, log/SSE/inbox 全部 emit/listen NEW alias, register 用 NEW alias upsert, etc.

## 4. 兼容性矩阵 (4 case)

| Case | Server | Agent | rename 行为 | Vincent 期望? |
|---|---|---|---|---|
| C1 | 旧 (≤0.8.2) | 旧 (≤2.4.0) | SQL cascade ✅ · SSE map stale · agent ALIAS stale · `send_task NEW` server 写 inbox 但 agent 收不到 | **现状, 不退化**. Test 验证 #146 baseline 行为不变. |
| C2 | 旧 (≤0.8.2) | 新 (≥2.4.1) | agent boot 探测 `/health.capabilities.rename_broadcast` = undefined → 不开 listener · 行为同 C1 | **优雅退化**, agent 不抛错不 spam log. log 一次 boot-time INFO "rename hot-reload unavailable (server too old)". |
| C3 | 新 (≥0.8.3) | 旧 (≤2.4.0) | server cascade + re-key + 推 broadcast · 旧 agent 不识 `node.alias_changed` 事件 (ignore) · agent ALIAS stale · 同 C1 | **优雅退化**, server 不抛错. CLI rename 完成时 print warning "old agent client (≤2.4.0) — stale ALIAS until restart". Cosmetic, 不阻塞 rename. |
| **C4** | 新 (≥0.8.3) | 新 (≥2.4.1) | 全套 hot-reload ✅ — send_task NEW 立即可达, **不 kill process, 不中断任务** | **本 RFC 目标 state**. |

### 4.1 case C2 优雅退化的关键点

agent 不应在 SSE event loop 里 spam warning "got unknown event type" — 因为 server 老版本根本不发这事件, listener 应 capability-gate 在 boot 时关闭, 0 cost runtime.

### 4.2 case C3 server warning 的 actionable message

CLI rename 完成时, server commit 响应可携带 `stale_clients: [<connect_id>...]` 表明哪些 SSE 连接是旧 agent 无法接 broadcast (server-side 可以通过对端 User-Agent / HTTP header 判断). renameCommand 收到后:

```
[anet] ⚠ Old agent client detected (process pid=XXX, version pre-2.4.1).
[anet]   The agent is still bound to alias "OLD" in its memory.
[anet]   Fix options:
[anet]     1. anet node stop OLD-DIR && anet node start NEW   (recommended)
[anet]     2. anet upgrade  (upgrade agent-node to ≥2.4.1 for hot-reload)
```

## 5. 协议升级路径

### 5.1 推荐: server-first

1. user `anet upgrade` (commhub-server@0.8.2 → 0.8.3 — 包含 cascade + broadcast, capability flag = true)
2. 重启 hub: 现有 agent 仍 OK (C3 优雅退化生效)
3. user 后续 `anet upgrade` agent-node: agent-node@2.4.0 → 2.4.1 (新 listener + fallback)
4. 重启 agent: C4 全套激活

### 5.2 反向 (agent-first) 也安全

1. agent-node@2.4.1 跑在旧 server: capability flag absent → agent 不开 listener (C2)
2. 后续 server upgrade: agent 不需重启 (reconnect SSE 时新 health probe 会拿到 capability=true → 开 listener)

### 5.3 lockstep 不必要

但**建议** server 先升 (因 cascade 现状不依赖 agent 改, 风险 0). 文档强调.

## 6. Rollback Safety

| 升级方向 | rollback 安全? |
|---|---|
| server 0.8.3 → 0.8.2 (rollback) | ✅ SQL schema 不变, in-memory state 重启清空, agent 自然降级到 C2 |
| agent 2.4.1 → 2.4.0 (rollback) | ✅ listener 仅 ADD-only (没改既有 type 处理), 移除后等同 C1/C3 |

## 7. Edge Cases

### 7.1 Agent offline 时 rename

- DB cascade (sessions.alias / nodes.alias) 完整 atomic
- agent 重新上线 register 时, agent 使用 config.json 里 alias=NEW (renameCommand C2 已 update local config)
- server `report_status` 接到 alias=NEW 的 register, sessions 行 alias 早已是 NEW, match
- 完全自然 reconcile, no special handling needed

### 7.2 双向 rename race (A→B + B→A 同时)

- `prepareRename` CAS-guard: B→A 的 prepare 看 sessions 已有 A → fail. 或 A→B prepare 拿了 rename_txn.new_alias=B, B→A prepare 看 rename_txn 已有 prepared B → fail
- 必有一个 prepare 失败. 串行化 OK.

### 7.3 broadcast 丢失

- 60s `report_status` 自检 (§3.3) 兜底
- worst-case 60s drift, 之后 self-heal
- 不影响 message 实际投递, 只影响 agent 自身 ALIAS report

### 7.4 网络分区时 rename

- agent 重连后 register, 拿新 sessions.alias = NEW
- agent 内存 ALIAS 通过 register 响应或下一次 self-check fallback (§3.3) 同步
- 短期内 SSE 推送可能 drop (server 找不到 stale agent connection), 但 agent 重连时 server 会接受新连接 — 此时 server 已是新版, agent 也会发 health probe 重新设 capability flag

### 7.5 多 agent 同 alias (异常状态, 应 anet doctor)

- rename_txn CAS 在 `sessions.alias` 维度, 不区分单 vs 多 agent
- 如果不一致状态存在 (e.g. 旧 agent 没清理 + 新 agent register), broadcast 同时去两路, 都会 hot-reload
- 不破坏 invariant; doctor 检测异常另说

## 8. Test Matrix

per Vincent push, 测试马 Phase 2 覆盖**9 case**:

### 8.1 5 functional cases (per #146 body — single-version)

1. running 节点 rename (C4 path): send_task NEW 立即可达, 不 kill process, log 显示 `[rename] hot-reload alias`
2. offline 节点 rename: 重启 picks up NEW, register OK
3. running rename + immediate send_task race: server 写 inbox 后 broadcast 已 fire, agent 在 reload + processInbox 顺序内完成
4. rename + delete 序列: rename to A → delete A, sessions row gone, no leftover
5. rename failure recovery: prepare 成功但 commit 失败 → abort, agent 不受影响

### 8.2 4 cross-version cases (per §4 matrix)

6. C1: 旧 server (0.8.2) + 旧 agent (2.4.0): #146 baseline 现状, agent stale
7. C2: 旧 server (0.8.2) + 新 agent (2.4.1): agent capability probe = false, 不开 listener, 行为同 C1, log 一次 INFO
8. C3: 新 server (0.8.3) + 旧 agent (2.4.0): server cascade + broadcast 发, agent 不识, CLI 显示 stale-client warning
9. C4: 新 server (0.8.3) + 新 agent (2.4.1): 全套 ✅ (Vincent 5390 期望 state)

## 9. Implementation Sketch

### 9.1 commhub-server (~25 LOC)

**`src/push.ts`** — 新 export:

```typescript
export function migrateSSEKeys(oldName: string, newName: string, networkId?: string | null): number {
  const oldKey = clientKey(oldName, networkId);
  const newKey = clientKey(newName, networkId);
  const arr = clients.get(oldKey);
  if (!arr) return 0;
  // v5 critical: update each client's own .key so cancel() handlers (which
  // close over client object, not local key) clean up at the correct entry.
  // Without this line, migrated clients leak on disconnect — see §3.1.7.
  for (const c of arr) c.key = newKey;
  // Merge (in unlikely case newKey already has entries, e.g. partial pre-rename connect)
  const existing = clients.get(newKey) || [];
  clients.set(newKey, [...existing, ...arr]);
  clients.delete(oldKey);
  return arr.length;
}
```

**`src/rename.ts`** — `commitRename` 末尾追加:

```typescript
// RFC-013 §3.1 step 1 — re-key in-memory SSE clients map
const migrated = migrateSSEKeys(txn.old_alias, txn.new_alias, txn.network_id);

// v4: lookup stable node_id from nodes table for identity in the broadcast
// envelope (per §3.2 listener validates ev.node_id === runtimeNodeId)
const nodeRow = db.get<any>(
  "SELECT node_id FROM nodes WHERE network_id = ?1 AND alias = ?2",
  [txn.network_id, txn.new_alias]);

// RFC-013 §3.1 step 2 — broadcast node.alias_changed to the (now re-keyed) stream
pushEvent(txn.new_alias, {
  type: "node.alias_changed",
  node_id: nodeRow?.node_id ?? null,   // v4: identity for §3.2 listener validation
  old_alias: txn.old_alias,
  new_alias: txn.new_alias,
  new_node_name: txn.new_alias,
  network_id: txn.network_id,
  txn_id: txnId,
}, txn.network_id);
```

**`src/index.ts`** — `/health` 响应 + report_status 响应:

```typescript
// /health
return Response.json({
  status: "ok",
  version: VERSION,
  capabilities: {
    rename_broadcast: true,
    rename_broadcast_version: 1,
  },
});

// report_status response
const canonical = db.get<any>("SELECT alias FROM sessions WHERE alias = ?1 OR ...", ...);
return Response.json({ ok: true, canonical_alias: canonical?.alias });
```

### 9.2 agent-node (~30 LOC)

**`src/cli.ts`** — boot 时:

```typescript
let SERVER_SUPPORTS_RENAME_BROADCAST = false;
try {
  const health = await fetch(`${COMMHUB_URL}/health`).then(r => r.json());
  SERVER_SUPPORTS_RENAME_BROADCAST = !!health?.capabilities?.rename_broadcast;
  if (!SERVER_SUPPORTS_RENAME_BROADCAST) {
    log(`[rename] hot-reload unavailable (server ≤0.8.2) — agent will use stale ALIAS until restart on rename`);
  }
} catch {
  // health probe failed, conservative default — no listener (C2 behavior)
}
```

**`src/cli.ts:1384` SSE event loop** — 新分支 (v4: identity validation per §3.2):

```typescript
if (ev.type === "node.alias_changed" && SERVER_SUPPORTS_RENAME_BROADCAST) {
  const identityMatches =
    ev.node_id ? (ev.node_id === runtimeNodeId)
               : (ev.old_alias === runtimeAlias);
  if (!identityMatches) {
    debug(`[rename] ignoring node.alias_changed (event identity ≠ mine)`);
    continue;
  }
  log(`[rename] hot-reload ${runtimeAlias} → ${ev.new_alias}`);
  runtimeAlias = ev.new_alias;
  runtimeNodeName = ev.new_node_name || ev.new_alias;
  // runtimeNodeId unchanged — rename only touches alias
  await register().catch(e => warn(`re-register failed: ${e.message}`));
}
```

**`reportStatus` fn** — 自检 fallback (v4: runtimeAlias instead of ALIAS):

```typescript
const resp = await callCommHub("report_status", {...}) as any;
if (resp?.canonical_alias && resp.canonical_alias !== runtimeAlias) {
  warn(`[rename] alias drift: local=${runtimeAlias} server=${resp.canonical_alias} — hot-reloading`);
  runtimeAlias = resp.canonical_alias;
  runtimeNodeName = resp.canonical_alias;
}
```

### 9.3 LOC + ETA estimate

| 文件 | LOC | ETA | Phase |
|---|---|---|---|
| commhub-server src/index.ts — report_status canonicalization (Blocker 1) | ~25 | 30min | 0 |
| commhub-server src/push.ts — mutable client key + SSEClient struct (Blocker 3) | ~20 | 25min | 1 |
| commhub-server src/push.ts — `migrateSSEKeys` + version/capabilities | ~15 | 15min | 1 |
| commhub-server src/rename.ts — commitRename re-key + broadcast (w/ node_id, Concern 3) | ~15 | 15min | 1 |
| commhub-server src/index.ts — /health.capabilities + SSE accept headers | ~10 | 15min | 1 |
| commhub-server src/rename.ts — prepareRename diagnostic_hint (Type A/B) | ~10 | 10min | 1 |
| agent-network bin/cli.ts — renameCommand pre-check (Type A/B) | ~20 | 25min | 1 |
| agent-network bin/cli.ts — renameCommand parse live_sse_clients warning (Blocker 4) | ~15 | 15min | 1 |
| agent-node src/cli.ts — runtime identity mutable refactor (Blocker 2) | ~30 | 40min | 2 |
| agent-node src/cli.ts — SSE capability headers on connect | ~5 | 10min | 2 |
| agent-node src/cli.ts — capability probe at boot + every reconnect (Concern 1) | ~15 | 20min | 2 |
| agent-node src/cli.ts — node.alias_changed listener (w/ node_id validate, Concern 3) | ~20 | 25min | 2 |
| agent-node src/cli.ts — 60s alias drift self-check independent of heartbeat (Concern 2) | ~15 | 20min | 2 |
| Docker smoke — 9+4 case (4 new from 通信牛 verify list) | — | 90min | test |
| 文档 (CHANGELOG + RFC fold-in + envRef migration guide) | — | 25min | doc |
| **合计** | **~215 LOC** | **~6.5h** | — |

## 10. Ship 路径

### 10.1 v0.10.2 (推荐)

- `@sleep2agi/commhub-server@0.8.3` (RFC-013 server-side)
- `@sleep2agi/agent-node@2.4.1` (RFC-013 client-side + fallback)
- agent-network 不动 (renameCommand 不依赖此 RFC)
- 测试马 9-case smoke 全 PASS gate before promote
- Two-phase publish 跟 v0.10.1 cycle

### 10.2 v0.11.0 (备选)

- 跟 Hero A+B+C 一起 ship, 多带几个相关改进 (e.g. 整体 RFC-010 §4.4 SIGHUP path 作 Linux/macOS optional optimization, broadcast 仍为 cross-platform 默认)
- 节奏更慢但 cohesion 更高

**SDK马 推荐 10.1** — Vincent 5387 "P0 急迫" + #146 bug 已暴露给用户, 越快 ship 越好. RFC-013 spec 完整后 impl 是 ~2.5h, 单 patch ship 合理.

## 10.5 通信牛 verify list (per v2 review)

测试马 Phase 2 必须含以下 4 case (额外于 §8 9-case):

1. **stale OLD `report_status` after commit cannot revert alias** — 修 Blocker 1 invariant
2. **migrated SSE disconnect cleans up stats/keepalive** — 修 Blocker 3 cleanup race
3. **agent-first server upgrade without agent restart enables listener after SSE reconnect** — 修 Concern 1
4. **missing `sessions` row / nodes-only rename precondition path** (含 Type A envRef + Type B cwd) — 修 Concern 4 + Layer 3 UX

总 test = 9 (RFC v1) + 4 (v3 通信牛) = **13 case** smoke.

## 11. Risk + 缓解

| Risk | 缓解 |
|---|---|
| broadcast 丢失 → agent 永远 stale | §3.3 60s 自检 fallback |
| 旧 server + 旧 agent 升级到新 server 没升 agent | C3 graceful + CLI warning |
| in-memory SSE map race (rename 同时其他人连 NEW) | server 同步 commit + migrateSSE 都在同一 mutex/event-loop tick |
| Capability flag spoofing (恶意 server 谎报) | agent 仅用此 flag 决定 是否 listen, 不是安全决策, low risk |
| dashboard (#84 C4 node.renamed) 跟新 node.alias_changed 冲突 | 两条独立 event, dashboard 不受影响, server 都 push |

## 12. Open questions (待 review)

1. `node.alias_changed` event 是否要 push 给 user channel (类似 RFC-010 §4.2.1 C4 的 dashboard 路径)? — 当前设计 no (此 event 专给 agent-node 消费), dashboard 仍走 `node.renamed`.
2. fallback self-check 是否要做 `get_inbox` 时也比对一次? — 当前 §3.3 仅在 report_status. 60s 上限够吗?
3. Capability flag versioning (`rename_broadcast_version`) — v1 spec 本 RFC, 后续若 broadcast envelope 变 (e.g. 加字段) 是否需 bump? — yes, but additive change 不需 bump.
4. server-side 是否限 capability flag 在认证之后才暴露 (避 unauth probe 嗅探 server 版本)? — 当前 `/health` 是 unauth, capabilities 也 unauth 暴露. 跟 server 版本本来 exposed 等价. OK.

## 13. 后续 RFC linkage

- RFC-010 §4.4 — 原 SIGHUP 设计 superseded by 本 RFC. RFC-010 待更新 footnote 指向 RFC-013.
- 类似 hot-reload 场景 (e.g. `network_id` 变更, model 变更) 可 reuse 同一 `/health.capabilities` probe + broadcast pattern. RFC-013 §3 留 extensible 框架.

---

**Status check**: Draft 完成. 请 通信牛 / 通信龙 / Vincent review.

**接下来**:
1. 通信牛 review (per [[feedback-design-review]])
2. Vincent telegram ack
3. SDK马 implement (~2.5h) per §9
4. 测试马 9-case smoke
5. v0.10.2 two-phase publish (commhub-server@0.8.3 + agent-node@2.4.1)

**作者**: 通信SDK马 · 2026-05-17

# RFC-013 — Rename Hot-Reload 跨版本兼容性

**作者**: 通信SDK马
**状态**: Draft (待 通信龙 / 通信牛 / Vincent review)
**关联 issue**: #146, #84 (rename impl), RFC-010 §4.4 (SIGHUP-based reload)
**关联 ship**: v0.10.0 (rename 2PC), v0.10.2 candidate (本 RFC 实施)

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

### 1.3 Vincent 5390+5391 硬约束

- **5390 "升级一定要无痛"** — 不接受 process kill / task kill 类 fix (B 方案被否)
- **5391 "兼容性花大功夫"** — 不接受 single-version impl, 必须 cross-version 4 case (旧+旧 / 旧+新 / 新+旧 / 新+新) 全有 deliberate design

故升级 #146 至 RFC level (本文档).

## 2. 目标

1. `anet node rename old new` 之后, `send_task --alias new` 在 running agent **立即** 收到, **不杀进程、不中断任务**, 跨平台 (Linux/macOS/Windows).
2. 跨版本组合 4 case 全有 deliberate design + graceful degradation, 不依赖 lockstep 同步升级.
3. `/health` capability flag 协议留向后扩展空间 (后续类似 hot-reload 场景沿用同一探测机制).

## 3. 协议设计

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
  "old_alias": "OLD",
  "new_alias": "NEW",
  "new_node_name": "NEW",
  "network_id": "net_xxx",
  "txn_id": "rtxn_..."
}
```

注意: 跟现有 `node.renamed` (RFC-010 §4.2.1 C4 — dashboard 用) 是**两条不同 event** 不复用. `node.renamed` envelope 设计给 dashboard 消费 (含 `surfaces_updated` 列表 etc.), `node.alias_changed` envelope 设计给 agent-node 消费 (只含 reload 必需字段). 这样两边各自演化不交叉.

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
  if (ev.old_alias === ALIAS) {
    log(`[rename] hot-reload alias ${ALIAS} → ${ev.new_alias}`);
    ALIAS = ev.new_alias;
    NODE_NAME = ev.new_node_name || ev.new_alias;
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

// RFC-013 §3.1 step 2 — broadcast node.alias_changed to the (now re-keyed) stream
pushEvent(txn.new_alias, {
  type: "node.alias_changed",
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

**`src/cli.ts:1384` SSE event loop** — 新分支:

```typescript
if (ev.type === "node.alias_changed" && SERVER_SUPPORTS_RENAME_BROADCAST) {
  if (ev.old_alias === ALIAS) {
    log(`[rename] hot-reload ${ALIAS} → ${ev.new_alias}`);
    ALIAS = ev.new_alias;
    NODE_NAME = ev.new_node_name || ev.new_alias;
    await register().catch(e => warn(`re-register failed: ${e.message}`));
  }
}
```

**`reportStatus` fn** — 自检 fallback:

```typescript
const resp = await callCommHub("report_status", {...}) as any;
if (resp?.canonical_alias && resp.canonical_alias !== ALIAS) {
  warn(`[rename] alias drift: local=${ALIAS} server=${resp.canonical_alias} — hot-reloading`);
  ALIAS = resp.canonical_alias;
  NODE_NAME = resp.canonical_alias;
}
```

### 9.3 LOC + ETA estimate

| 文件 | LOC | ETA |
|---|---|---|
| commhub-server src/push.ts | ~10 | 15min |
| commhub-server src/rename.ts | ~10 | 10min |
| commhub-server src/index.ts | ~10 (health + report_status) | 20min |
| agent-node src/cli.ts | ~25 | 30min |
| 测试 9-case smoke (Docker) | — | 60min |
| 文档 (CHANGELOG + RFC fold-in) | — | 15min |
| **合计** | **~55 LOC** | **~2.5h** |

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

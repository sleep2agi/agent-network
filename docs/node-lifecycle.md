# Node 节点完整生命周期

> 状态：定稿 → **已 ship**（2026-05-12 对齐 v0.8.2） | 日期：2026-04-10 | 作者：SDK马 + 通信牛 review
>
> 本文设计的状态机和 `anet node create / start / stop / delete` 流程已在 v0.6 ~ v0.7 完整 ship。v0.8 增量：
> - `anet doctor --fix` 自动 probe + 重发过期 `ntok_`
> - agent-node SSE 401 自动 reload token
> - `anet node ls` 显示 STATUS / SSE 列
>
> 用户视角简化版见 [Agent Node](https://anet.sh/guide/agent-node)。本文保留为内部技术参考。

---

## 状态机

```
          anet node create
              │
              ▼
         ┌─────────┐
         │ created  │ ← config.json 存在，未注册 CommHub
         └────┬─────┘
              │ anet node start
              ▼
         ┌─────────────┐
         │ registered   │ ← CommHub report_status(idle)，等待 SSE 连接
         └────┬─────────┘
              │ SSE connected
              ▼
         ┌─────────┐  ←──── 无任务
         │  online  │ ←──── 任务完成
         │  (idle)  │
         └────┬─────┘
              │ 收到任务
              ▼
         ┌─────────┐
         │ running  │ ← report_status(working)
         │(working) │
         └────┬─────┘
              │ 任务完成
              ▼
         ┌─────────┐
         │  online  │ ← report_status(idle)
         │  (idle)  │
         └────┬─────┘
              │ anet node stop / SIGINT / 崩溃
              ▼
         ┌─────────┐
         │ offline  │ ← CommHub 检测到断连 / report_status(offline)
         └────┬─────┘
              │ anet node start（resume）
              ▼
         ┌─────────┐
         │  online  │ ← 恢复
         └─────────┘

    特殊状态:
         ┌─────────┐
         │ blocked  │ ← 等待外部资源 / 权限
         └─────────┘
         ┌─────────┐
         │  error   │ ← 运行时错误
         └─────────┘
         ┌─────────┐
         │ deleted  │ ← anet node delete（清除 config + CommHub 记录）
         └─────────┘
```

## 状态定义

| 状态 | CommHub status | 含义 | config.json 存在 | 进程存在 |
|------|---------------|------|-----------------|---------|
| created | (不在 CommHub) | 配置已创建，从未启动 | 是 | 否 |
| *(registered)* | *(idle)* | *内部瞬时态：report_status 到 SSE connected 之间，外部不可见* | 是 | 是 |
| online/idle | idle | 在线等待任务 | 是 | 是 |
| running/working | working | 正在处理任务 | 是 | 是 |
| *(blocked)* | *(blocked)* | *P0 不实现，预留* | 是 | 是 |
| error | error | 运行时错误 | 是 | 是 |
| offline | offline | 进程不在运行 | 是 | 否 |
| deleted | (不在 CommHub) | 已删除 | 否 | 否 |

## 每个阶段详细设计

### 1. 创建 (created)

**触发**: `anet node create <node-name>`

**数据变更**:
```
.anet/nodes/<node-name>/      ← 目录名是 alias / node-name, 不是内部 node_id 字段
├── config.json    ← 生成
└── (空目录)
```

config.json:
```json
{
  "anet_version": "0.1.0",
  "node_id": "n_a1b2c3d4",
  "node_name": "指挥室",
  "alias": "指挥室",
  "runtime": "claude-code-cli",
  "network_id": "net_a1b2c3d4",
  "channels": ["server:commhub"],
  "env": {},
  "flags": { "dangerouslySkipPermissions": true, "teammateMode": "in-process" },
  "session": "550e8400-e29b-41d4-a716-446655440000"
}
```

**CommHub**: 无变化（node 还没注册）

### 2. 注册 (registered)

**触发**: `anet node start <node-name>` → spawn 进程 → 进程调 `report_status(idle)`

**数据变更**:
- CommHub sessions 表: INSERT/UPDATE（resume_id=sdk-${node_id}, alias=node_name, status=idle, agent=runtime, project_dir, server=hostname）

**agent-node 行为**（verify `agent-node/src/cli.ts:357-369`）:
```typescript
// RESUME_ID = NODE_ID ? `sdk-${NODE_ID}` : `sdk-${ALIAS}-${Date.now().toString(36)}`
register() → callCommHub("report_status", {
  resume_id: RESUME_ID,    // 有 node_id 用 sdk-<node_id>，否则 sdk-<alias>-<ts> 兜底
  alias: ALIAS,            // 来自 --alias / env / config.alias（跟 node_name 是两个独立字段）
  status: "idle",
  server: osHostname(), hostname: osHostname(),  // 两字段都发，值都是 osHostname()
  agent: `agent-node:${RUNTIME}`,
  project_dir: process.cwd(),
  node_id, node_name, session_id, config_path, channels, model, network_id,  // 其余字段，缺省为 undefined
});
```

### 3. 上线 (online/idle)

**触发**: SSE 连接成功

**数据变更**: CommHub 内部标记 SSE 通道活跃

**感知方式**: CommHub `/api/status` 返回 `status: "idle"`

### 4. 运行 (running/working)

**触发**: 收到任务开始处理

**数据变更**:
- CommHub: `report_status(working, task=...)`
- agent-node: 调用 think() → query() / thread.run()

### 5. 暂停/等待 (blocked)

**触发**: 等待外部资源（API 限流、权限确认等）

**数据变更**: `report_status(blocked)`

**实际用法**: 较少使用，预留状态

### 6. 恢复 (resume)

**触发**: `anet node start <node-name>`，config.json 有 session

**数据变更**:
- 进程启动，带 session/thread ID
- CommHub: 用同一个 node_id 重新注册

**关键**: node_id 不变 → CommHub 识别为同一个 node → 不会重复注册

### 7. 更名 (rename) — R219 校准

**触发**: `anet node rename <old> <new>` [`--force`]

**前置条件**: rename 需要 hub + token + network_id（`anet login` 后才有，缺则 `process.exit(1)`）。运行中的 node **必须加 `--force`** —— [`cli.ts`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts) —— 搜 `async function renameCommand(` 检测到 `.pid` 进程存活且没 `--force` 时直接退出；运行中改名走 RFC-010 §4.4 active rename，**不杀进程**。

**RFC-010 两阶段事务** —— R481 校准：旧 doc 的「P0 只改本地 `renameSync` + P1 CommHub rename API 未采纳」已过时，当前 [`cli.ts`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts) —— 搜 `async function renameCommand(` 实现的是带 CommHub 协同的两阶段事务：

- **PHASE 1 — PREPARE（全程可回滚，old node 原封不动）**：写 `rename.lock` → `cpSync(oldDir → newDir)`（**copy 不是 move**）→ 更新 `newProfile.node_name` / `alias` + `saveProfile` → POST `/api/node-rename/prepare` 拿 `txn_id`。任一步失败 → 回滚（删 newDir + POST `/api/node-rename/abort` + 删 lock），`old` 完全不变。
- **PHASE 2 — COMMIT（顺序敏感）**：
  1. **C1** POST `/api/node-rename/commit` —— C1 之前仍可干净回滚，C1 之后转 forward-fix。**C4（server 侧）**：`commitRename` 成功后 server `pushEvent` 一个 `node.renamed` SSE 事件给 old + new 两个 alias 流，**外加每个网络成员的 user channel**（dashboard 订阅 `/events/<username>` user channel 而非 per-alias 流，#84 SSE channel fix；[`rename.ts:100-123`](https://github.com/sleep2agi/agent-network/blob/main/server/src/rename.ts#L100)，envelope 见 [rest.md SSE 端点](https://anet.sh/api/rest)）
  2. **C2** 运行中 node 跑 `tmux rename-session`（不杀进程；失败转 forward-fix 不回滚）
  3. **C3** `rmSync(oldDir)` 原子切换本地 + `writeLegacyProjectAlias(newName)`

**node_id 不变** —— 只换 alias，绑 node 的 `ntok_` token 仍有效。运行中的 agent 可能继续上报旧 alias，直到它重读 config（RFC-010 §4.4：SIGHUP / per-turn reload，agent-node 侧）。

### 8. 下线 (offline)

**触发**:
- `anet node stop <node-name>` → kill 进程 → 进程 SIGTERM handler 调 `report_status(offline)`
- 进程崩溃 → CommHub 检测 SSE 断连 → 标记 offline
- 网络断开 → 同上

**数据变更**:
- CommHub: status → offline
- config.json: 不变（session 已写回）
- 进程退出

**CommHub 超时检测**: 心跳 3 分钟间隔（[`agent-node/src/cli.ts:1159`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts#L1159) `setInterval(() => reportStatus("idle"), 3 * 60 * 1000)`），超过 **10 分钟**无心跳 → 自动标记 offline（[`server/src/index.ts:816-821`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L816) `Date.now() - 10 * 60 * 1000` cutoff，惰性触发于 `/api/status` 调用时）。R219 校准：原 doc 5 分钟错。

### 9. 删除 (deleted) — R219 校准

**触发**: `anet node delete <node-name>` （首次提示，再加 `--force` 才真删）

**前置条件**: 不强制 offline —— `anet node delete` 会先 `stopNode(nodeId)` 杀进程 + `await notifyServerOffline(...)` 通知 hub 后再删本地目录（[`cli.ts`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts) —— 搜 `async function deleteCommand(`）。

**实际数据变更**:
1. **本地**: `rmSync(.anet/nodes/<id>/, { recursive: true, force: true })` —— 删整个目录（含 config.json、channels/、logs/；目录名是 alias / node_name，不是内部 node_id 字段；R209 chain 一致）
2. **CommHub session**: `notifyServerOffline` 调用 `report_status(offline)`（[`cli.ts`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts) —— 搜 `async function notifyServerOffline(`）—— **只把 sessions row.status 改成 offline，不 DELETE**。这一行 session 会一直留在 db 里（10 分钟 stale cutoff 触发时也只是再次 mark offline）。
3. **CommHub inbox**: **不清理** —— 残留 inbox 消息会一直留着。如果之后用同 alias 再 `anet node start`，新进程会从 `getInbox` 拉到旧消息（注意：旧消息可能跟新进程 session 上下文无关）。

::: warning 旧 doc P1 设计未采纳
原 doc 写「DELETE FROM sessions / DELETE FROM inbox」是设计草稿意图，**未实施**。实际只 mark offline + 删本地目录，不清服务端 row（v0.8.2 起验证，至当前 stable 未变）。
:::

**确认流程**（[`cli.ts`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts) —— 搜 `This will delete "${displayName}" (node_id:`）：

```
$ anet node delete 指挥室
[anet] This will delete "指挥室" (node_id: n_a1b2c3d4)
[anet]   .anet/nodes/指挥室
[anet] Run again with --force to confirm.

$ anet node delete 指挥室 --force
[anet] Deleted "指挥室"
```

非交互式（不是 readline 输入 node 名称），用 `--force` flag 二次确认。R219 校准：原 doc fictional 交互式 prompt。

## CLI 命令 ↔ 状态转换

| 命令 | 状态转换 | 说明 |
|------|---------|------|
| `anet node create` | → created | 生成 config.json |
| `anet node start` | created/offline → registered → online | spawn 进程 |
| `anet node start --new-session` | * → registered → online | 忽略旧 session |
| `anet node stop` | online/running → offline | kill 进程 |
| `anet node rename` | offline/online → 改名 | RFC-010 两阶段事务；运行中 node 需 `--force`（active rename，不杀进程，详见 §7） |
| `anet node delete` | online/offline → deleted | 自动 `stopNode` + `notifyServerOffline` 再删本地目录，**不需手动先 stop**（详见 §9） |

## 批量恢复说明

当前 CLI 没有 `anet restart` / `anet restart-all` 命令。批量恢复仍然是多次触发 `offline → online` 状态转换：

```bash
anet node start <node-a>
anet node start <node-b>
```

旧的 `restart-all` 方案保留在 [archive/restart-strategy.md](archive/restart-strategy.md)，不属于当前支持命令集。

## node_id 完整设计

| 属性 | 值 |
|------|-----|
| 格式 | `n_` + 8 位 hex（如 `n_a1b2c3d4`） |
| 生成时机 | `anet node create` 时 |
| 可变性 | 不可变 |
| 用途 | CommHub resume_id + 新节点目录名 |
| 暴露 | `anet ls` 括号显示，不主动展示 |

node_name:
| 属性 | 值 |
|------|-----|
| 用途 | 显示名 + CommHub alias + CLI 参数 |
| 可变性 | `anet node rename` 可改 |
| 约束 | 同一 network 内唯一（`UNIQUE(network_id, alias)`，不是全局 CommHub 唯一），不含路径特殊字符 |

## 异常处理

### 崩溃

```
进程异常退出
  → SIGTERM handler 来不及执行
  → CommHub 通过心跳超时检测（5 分钟）
  → 自动标记 offline
  → 逐个 `anet node start <name>` 可恢复
```

### 网络断开

```
SSE 断连
  → agent-node 自动重连（指数退避 3s → 60s）
  → 重连成功 → 恢复 online
  → 重连持续失败 → CommHub 心跳超时 → offline
```

### 重复注册

```
同一 node_id 多次 report_status
  → CommHub UPDATE（不 INSERT）
  → resume_id 是主键，保证幂等

同一 network 内同一 node_name 不同 node_id
  → UNIQUE(network_id, alias) 复合约束
  → 第二个注册失败
  → agent-node 报错退出："alias 已被占用"

（注：约束是 (network_id, alias) 复合唯一，不是 alias 单列唯一 ——
  不同 network 可以有同名 alias。旧库的 `alias TEXT UNIQUE` 已被
  db.ts 一次性 rebuild 迁移成 UNIQUE(network_id, alias)，见 db.ts:331-333）
```

### 进程残留

```
anet node start 时发现 tmux session 已存在
  → 提示："tmux session {name} already exists. Kill and restart? (y/n)"
  → 或 anet node stop 先 kill
```

## 兼容策略（旧节点无感迁移）

### 旧节点特征

| 特征 | 旧节点 | 新节点 |
|------|--------|--------|
| 目录名 | node_name（中文等） | node_id（n_xxxxxxxx） |
| config.json | 无 node_id | 有 node_id |
| config 字段名 | name / alias | node_name |
| session 字段 | resume / sessionId | session |
| 配置路径 | .anet/profiles/*.json | .anet/nodes/*/config.json |
| CommHub resume_id | 随机生成（每次不同） | sdk-${node_id}（稳定） |

### 迁移规则

**原则：旧节点能跑就不动，按需迁移。**

Claude Code CLI 节点的 `session` 是预分配 UUID：首次启动用 `claude --session-id` 绑定，后续检测到 `~/.claude/projects/<cwd>/<uuid>.jsonl` 后自动切到 `claude --resume`。旧节点缺少 `session` 时由 `anet node start` 自动补一个。

1. **anet 负责自动补 node_id**（agent-node 只读不写，避免双写）:
```typescript
// anet node start 时检测；node_id 由 generateNodeId() 生成（cli.ts:170-172）
if (!config.node_id) {
  config.node_id = generateNodeId();  // `n_${randomUUID().replace(/-/g,"").slice(0,8)}` —— n_ + 8 位 hex
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  console.log(`[anet] 自动生成 node_id: ${config.node_id}`);
}
```

2. **字段名兼容读取**（verify `agent-node/src/cli.ts`）:
```typescript
// cli.ts:355 —— node_name 无兼容链，直接取 node_name 字段
const NODE_NAME = fileConfig.node_name || "";
// cli.ts:179 —— session 有字段名兼容链（session / resume / sessionId），且 CLI flag 优先
const SESSION_ID = NEW_SESSION ? "" : (opts.session || fileConfig.session || fileConfig.resume || fileConfig.sessionId || "");
```

3. **旧路径 fallback**:
```
读取顺序:
  --config 显式指定 → .anet/nodes/<name>/config.json → .anet/profiles/<name>.json → .agent-node.json
```

4. **anet node start 旧节点**:
```
anet node start 指挥室
  → 找 .anet/nodes/指挥室/config.json ← 旧目录名
  → 发现无 node_id → 自动补充
  → 正常启动
  → 下次 CommHub resume_id 稳定
```

5. **anet node rename 旧节点**:
```
anet node rename 指挥室 总指挥
  → 发现目录名=node_name（旧节点）
  → 自动补 node_id
  → rename 目录: .anet/nodes/指挥室/ → .anet/nodes/总指挥/（旧节点必须 rename 目录）
  → 更新 config.json node_name
  → 更新 CommHub alias
```

6. **不强制迁移目录名**:
```
旧节点目录永远保持 node_name，不会自动 rename 成 node_id。
只有 `anet node create` 创建的新节点用 node_id 目录名。
两种目录名共存，`anet node ls` / `anet node start` 都能识别。
```

### anet 识别 node 的逻辑

实际函数名 `resolveNodeRef`（[`cli.ts`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts) —— 搜 `function resolveNodeRef(`）：

```typescript
function resolveNodeRef(ref: string) {
  // 1. 精确匹配目录名（新节点 node_id 或旧节点 node_name）
  const direct = loadProfile(ref);
  if (direct) return { id: ref, profile: direct };

  // 2. 扫描所有 node，按 node_id / node_name / name / alias 匹配，命中即返回（first-match）
  for (const id of listProfileIds()) {
    const cfg = loadProfile(id);
    if (cfg?.node_id === ref || cfg?.node_name === ref || cfg?.name === ref || cfg?.alias === ref) {
      return { id, profile: cfg };
    }
  }

  return null; // not found
}
```

## CLI 节点解析规则

所有接受 `<node-name>` 参数的命令统一走 `resolveNodeRef()`：

```
解析优先级:
  1. 精确匹配目录名 .anet/nodes/<input>/（node_id 或旧 node_name）
  2. 扫描所有 node config，匹配 node_id / node_name 字段
  3. 兼容匹配 name / alias 旧字段
  4. 命中即返回（first-match，不做歧义检测）
  5. 无匹配 → 返回 null（调用方报 "Node not found"）
```

## blocked / error 退出路径

```
blocked → 资源恢复 → running → idle
blocked → 超时 → error → idle（放弃任务）

error → 自动重试（agent-node 内部）→ idle
error → 重试失败 → report_status(error) → 等待人工干预
error → anet node stop → offline
```

P0 不实现 blocked 状态上报，error 由 agent-node 内部处理后回到 idle。

## 决策汇总

| # | 决策 | 理由 |
|---|------|------|
| 1 | 8 种状态 | 覆盖完整生命周期 |
| 2 | node_id 作 CommHub resume_id | 重启后身份稳定 |
| 3 | rename 必须 offline | 避免运行时状态不一致 |
| 4 | delete 必须 offline + 二次确认 | 防误操作 |
| 5 | 崩溃靠心跳超时检测 | 简单可靠 |
| 6 | 批量恢复只是多次 start 状态转换 | 不引入新状态 |
| 7 | 旧节点按需迁移，不强制 | 不破坏现有运行 |
| 8 | 自动补 node_id | 无感迁移 |
| 9 | 两种目录名共存 | 渐进演进 |
| 10 | CommHub alias UNIQUE 约束保持 | 防重名 |
| 11 | resume_id 用 sdk-${node_id} 前缀 | 兼容现有风格（通信牛） |
| 12 | node_id 由 anet 补，agent-node 只读 | 避免双写（通信牛） |
| 13 | P0 rename 只改本地 config | 不强依赖 CommHub API（通信牛） |
| 14 | P0 不实现 blocked 状态 | 预留，等有需求再加 |

---

## 通信牛 Review 意见（2026-04-10）

1. **CLI 查找：支持 node_name 和 node_id 两种匹配**
   - 精确匹配 node_id → 精确匹配 node_name → 兼容旧字段 name/alias
   - 多个 node_name 重名时报歧义错误

2. **node_name 在 CommHub 上仍须唯一**（不因有 node_id 就允许重名）

3. **不直接把 resume_id 改成纯 node_id**
   - 用 `sdk-${node_id}` 前缀，和现有风格兼容

4. **自动补 node_id 由 anet 负责**，agent-node 只读不写
   - 避免双写责任不清

5. **P0 rename 只改本地 config**
   - 不强依赖 CommHub rename API
   - 旧目录名同步 rename
   - CommHub alias 下次 start 时重新注册

6. **受影响命令清单**
   - create / ls / start / resume / channel add/ls / import / rename

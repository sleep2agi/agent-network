# Node 节点完整生命周期

> 状态：定稿 | 日期：2026-04-10 | 作者：SDK马 + 通信牛 review

---

## 状态机

```
          anet create
              │
              ▼
         ┌─────────┐
         │ created  │ ← config.json 存在，未注册 CommHub
         └────┬─────┘
              │ anet start
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
              │ anet stop / SIGINT / 崩溃
              ▼
         ┌─────────┐
         │ offline  │ ← CommHub 检测到断连 / report_status(offline)
         └────┬─────┘
              │ anet start（resume）
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
         │ deleted  │ ← anet delete（清除 config + CommHub 记录）
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

**触发**: `anet create <node-name>`

**数据变更**:
```
.anet/nodes/<node_id>/
├── config.json    ← 生成
└── (空目录)
```

config.json:
```json
{
  "anet_version": "0.1.0",
  "node_id": "n_a1b2c3d4",
  "node_name": "指挥室",
  "runtime": "claude-code-cli",
  "model": "",
  "session": "",
  "channels": ["server:commhub"],
  "tools": [],
  "env": {},
  "flags": { "dangerouslySkipPermissions": true, "teammateMode": "in-process", "maxTurns": 20, "logLevel": "info" }
}
```

**CommHub**: 无变化（node 还没注册）

### 2. 注册 (registered)

**触发**: `anet start <node-name>` → spawn 进程 → 进程调 `report_status(idle)`

**数据变更**:
- CommHub sessions 表: INSERT/UPDATE（resume_id=sdk-${node_id}, alias=node_name, status=idle, agent=runtime, project_dir, server=hostname）

**agent-node 行为**:
```typescript
register() → callCommHub("report_status", {
  resume_id: `sdk-${node_id}`,  // 稳定标识，带前缀兼容现有风格
  alias: node_name,        // 显示名
  status: "idle",
  agent: `agent-node:${runtime}`,
  project_dir: cwd,
  server: hostname,
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

**触发**: `anet start <node-name>`，config.json 有 session

**数据变更**:
- 进程启动，带 session/thread ID
- CommHub: 用同一个 node_id 重新注册

**关键**: node_id 不变 → CommHub 识别为同一个 node → 不会重复注册

### 7. 更名 (rename)

**触发**: `anet rename <old> <new>`

**前置条件**: node 必须 offline（运行中不允许改名）

**P0 数据变更（只改本地，不依赖 CommHub rename API）**:
1. config.json `node_name` → 新名字
2. 旧节点（目录名=node_name）: rename 目录
3. 新节点（目录名=node_id）: 不动目录
4. CommHub alias：下次 `anet start` 时用新名字重新注册（旧 alias 自然过期）

**P1**: CommHub 新增 rename API，rename 时主动更新 alias。

### 8. 下线 (offline)

**触发**:
- `anet stop <node-name>` → kill 进程 → 进程 SIGTERM handler 调 `report_status(offline)`
- 进程崩溃 → CommHub 检测 SSE 断连 → 标记 offline
- 网络断开 → 同上

**数据变更**:
- CommHub: status → offline
- config.json: 不变（session 已写回）
- 进程退出

**CommHub 超时检测**: 心跳 3 分钟间隔，超过 5 分钟无心跳 → 自动标记 offline

### 9. 删除 (deleted)

**触发**: `anet delete <node-name>`

**前置条件**: node 必须 offline

**数据变更**:
1. 删除 `.anet/nodes/<node_id>/` 目录（含 config.json、channels/、logs/）
2. CommHub: DELETE FROM sessions WHERE resume_id = sdk-${node_id}
3. CommHub: DELETE FROM inbox WHERE session_name = node_name（清理残留消息）

**确认**: 必须交互式确认
```
[anet] 删除 node "指挥室" (n_a1b2c3d4)?
[anet] 这将删除配置、channel、日志和 CommHub 注册。
[anet] 输入 node 名称确认: 指挥室
```

## CLI 命令 ↔ 状态转换

| 命令 | 状态转换 | 说明 |
|------|---------|------|
| `anet create` | → created | 生成 config.json |
| `anet start` | created/offline → registered → online | spawn 进程 |
| `anet start --new-session` | * → registered → online | 忽略旧 session |
| `anet stop` | online/running → offline | kill 进程 |
| `anet rename` | offline → offline (改名) | 必须先 stop |
| `anet delete` | offline → deleted | 必须先 stop |
| `anet restart` | offline → registered → online | 从 CommHub 数据重建 |
| `anet restart-all` | 批量 offline → online | 批量重启本机 |

## restart-all 融入生命周期

```
anet restart-all
  1. GET /api/status → 获取所有 session
  2. 筛选：本机 + offline + 有完整信息
  3. 按类型 spawn:
     - claude-code-cli: tmux spawn claude CLI
     - agent-node:*: tmux spawn agent-node --config
  4. 等待状态变化：offline → idle
  5. 超时 30s 报 warning
```

restart-all 不改生命周期，只是批量触发 offline → online 的状态转换。

## node_id 完整设计

| 属性 | 值 |
|------|-----|
| 格式 | `n_` + 8 位 hex（如 `n_a1b2c3d4`） |
| 生成时机 | `anet create` 时 |
| 可变性 | 不可变 |
| 用途 | CommHub resume_id + 新节点目录名 |
| 暴露 | `anet ls` 括号显示，不主动展示 |

node_name:
| 属性 | 值 |
|------|-----|
| 用途 | 显示名 + CommHub alias + CLI 参数 |
| 可变性 | `anet rename` 可改 |
| 约束 | 同一 CommHub 唯一，不含路径特殊字符 |

## 异常处理

### 崩溃

```
进程异常退出
  → SIGTERM handler 来不及执行
  → CommHub 通过心跳超时检测（5 分钟）
  → 自动标记 offline
  → anet restart-all 可恢复
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

同一 node_name 不同 node_id
  → alias UNIQUE 约束
  → 第二个注册失败
  → agent-node 报错退出："alias 已被占用"
```

### 进程残留

```
anet start 时发现 tmux session 已存在
  → 提示："tmux session {name} already exists. Kill and restart? (y/n)"
  → 或 anet stop 先 kill
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

1. **anet 负责自动补 node_id**（agent-node 只读不写，避免双写）:
```typescript
// anet start 时检测
if (!config.node_id) {
  config.node_id = `n_${crypto.randomBytes(4).toString("hex")}`;
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  console.log(`[anet] 自动生成 node_id: ${config.node_id}`);
}
```

2. **字段名兼容读取**:
```typescript
const NODE_NAME = fileConfig.node_name || fileConfig.name || fileConfig.alias || ALIAS;
const SESSION = fileConfig.session || fileConfig.resume || fileConfig.sessionId || "";
```

3. **旧路径 fallback**:
```
读取顺序:
  --config 显式指定 → .anet/nodes/<name>/config.json → .anet/profiles/<name>.json → .agent-node.json
```

4. **anet start 旧节点**:
```
anet start 指挥室
  → 找 .anet/nodes/指挥室/config.json ← 旧目录名
  → 发现无 node_id → 自动补充
  → 正常启动
  → 下次 CommHub resume_id 稳定
```

5. **anet rename 旧节点**:
```
anet rename 指挥室 总指挥
  → 发现目录名=node_name（旧节点）
  → 自动补 node_id
  → rename 目录: .anet/nodes/指挥室/ → .anet/nodes/总指挥/（旧节点必须 rename 目录）
  → 更新 config.json node_name
  → 更新 CommHub alias
```

6. **不强制迁移目录名**:
```
旧节点目录永远保持 node_name，不会自动 rename 成 node_id。
只有 anet create 创建的新节点用 node_id 目录名。
两种目录名共存，anet ls / anet start 都能识别。
```

### anet 识别 node 的逻辑

```typescript
function findNode(nameOrId: string) {
  // 1. 精确匹配目录名（新节点 node_id 或旧节点 node_name）
  const direct = join(cwd, ".anet/nodes", nameOrId, "config.json");
  if (existsSync(direct)) return loadJson(direct);

  // 2. 扫描所有 node，按 node_name 匹配
  for (const dir of readdirSync(join(cwd, ".anet/nodes"))) {
    const cfg = loadJson(join(cwd, ".anet/nodes", dir, "config.json"));
    if (cfg?.node_name === nameOrId || cfg?.name === nameOrId || cfg?.alias === nameOrId) {
      return cfg;
    }
  }

  return null; // not found
}
```

## CLI 节点解析规则

所有接受 `<node-name>` 参数的命令统一走 findNode()：

```
解析优先级:
  1. 精确匹配目录名 .anet/nodes/<input>/（node_id 或旧 node_name）
  2. 扫描所有 node config，匹配 node_name 字段
  3. 兼容匹配 name / alias 旧字段
  4. 多个匹配 → 报歧义错误
  5. 无匹配 → "Node not found"
```

## blocked / error 退出路径

```
blocked → 资源恢复 → running → idle
blocked → 超时 → error → idle（放弃任务）

error → 自动重试（agent-node 内部）→ idle
error → 重试失败 → report_status(error) → 等待人工干预
error → anet stop → offline
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
| 6 | restart-all 是批量状态转换 | 不引入新状态 |
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

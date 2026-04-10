# node_id + 改名方案

> 状态：草稿 | 日期：2026-04-10 | 作者：SDK马

---

## 动机

当前 name = 目录名 = CommHub alias，改名需要重命名目录 + 更新 CommHub 注册，容易出错。引入 node_id 分离标识和显示名。

## 方案

### config.json 新增 node_id

```json
{
  "anet_version": "0.1.0",
  "node_id": "n_a1b2c3d4",
  "node_name": "指挥室",
  "runtime": "claude-code-cli",
  ...
}
```

| 字段 | 说明 |
|------|------|
| `node_id` | 不可变标识，创建时自动生成，格式 `n_` + 8 位随机 hex |
| `node_name` | 显示名 + CommHub alias，可改 |

### 目录名策略

**新节点：目录名用 node_id**
**旧节点：目录名保持 node_name 不动（兼容）**

```
.anet/nodes/
├── n_a1b2c3d4/     ← 新节点，目录名 = node_id
│   └── config.json  ← { "node_id": "n_a1b2c3d4", "node_name": "指挥室" }
├── 指挥室/          ← 旧节点，目录名 = node_name（兼容，不迁移）
│   └── config.json  ← { "node_name": "指挥室" }（无 node_id，首次启动自动补）
```

新节点用 node_id 作为目录名的好处：
- 改名不需要动目录
- 避免中文目录名在某些环境的编码问题
- node_id 短（8 hex），`ls` 时配合 config.json 里的 node_name 对照

anet ls 时显示 node_name 而不是 node_id：
```
$ anet ls
  指挥室 (n_a1b2c3d4)  claude-code-cli  idle
  A站牛  (n_e5f6g7h8)  codex-sdk        working
```

### anet rename

```bash
$ anet rename 指挥室 总指挥

[anet] 改名: 指挥室 → 总指挥 (node_id: n_a1b2c3d4)
  1. 更新 config.json node_name 字段
  2. 更新 CommHub alias
  （目录 .anet/nodes/n_a1b2c3d4/ 不变）

确认？(y/n): y

  ✅ config.json node_name → 总指挥
  ✅ CommHub alias → 总指挥
  ⚠ 旧 CommHub alias "指挥室" 已清理

下次启动: anet start 总指挥
```

注意：新节点目录名是 node_id，改名不需要动目录。旧节点（目录名=node_name）改名时需要 rename 目录。

### CommHub alias 改名处理

CommHub sessions 表的主键是 `resume_id`，`alias` 是 UNIQUE 约束。

改名流程：
1. 用旧 alias 的 resume_id 调 `report_status`，把 alias 改成新名字
2. 或者：DELETE 旧记录 + INSERT 新记录（更简单）

需要 CommHub 新增 API：
```
rename_session(old_alias, new_alias)
# 或
update_alias(resume_id, new_alias)
```

### 其他 node 引用旧名字

场景：A 的 config 里有 `"send_to": "指挥室"`，指挥室改名了。

**P0 不处理**。理由：
- config.json 里没有引用其他 node name 的字段
- 消息通过 CommHub alias 路由，改名后旧消息不会重发
- 人类操作者知道改名了，会用新名字发消息

如果需要：P1 加 alias history，CommHub 保留旧 alias → 新 alias 映射，过渡期两个名字都能收到消息。

## agent-node 侧改动

| 改动 | 说明 |
|------|------|
| 读取 node_id | 从 config.json 读，用于 CommHub resume_id（替代当前随机生成） |
| 读取 node_name | 用作 ALIAS（替代 --alias 参数） |
| --alias 降级 | --alias 作为 fallback，优先读 config.json node_name |

```typescript
// 当前
const RESUME_ID = `sdk-${ALIAS}-${Date.now().toString(36)}`;

// 改为
const RESUME_ID = fileConfig.node_id || `sdk-${ALIAS}-${Date.now().toString(36)}`;
```

这样 node_id 稳定不变，重启后 CommHub 识别为同一个 session（不会重复注册）。

## 已有 node 兼容

没有 node_id 的旧 config：
1. agent-node 启动时发现没有 node_id → 自动生成并写回 config.json
2. anet start 发现没有 node_id → 自动补充

```typescript
if (!fileConfig.node_id) {
  fileConfig.node_id = `n_${crypto.randomBytes(4).toString("hex")}`;
  writebackConfig();
  log(`自动生成 node_id: ${fileConfig.node_id}`);
}
```

## 迁移策略

1. **anet 新版发布后**：`anet create` 自动生成 node_id
2. **旧 node 首次启动**：自动补充 node_id
3. **不强制迁移**：没有 node_id 不影响启动，只是 resume_id 不稳定
4. **rename 依赖 node_id**：没有 node_id 的 node 先自动补充再 rename

## 决策

| # | 决策 | 理由 |
|---|------|------|
| 1 | 新节点目录名用 node_id，旧节点保持 node_name | 新节点改名不动目录，旧节点兼容 |
| 2 | 新节点改名不动目录，旧节点改名需 rename 目录 | 渐进迁移 |
| 3 | node_id 格式 `n_` + 8 hex | 短且唯一 |
| 4 | node_id 用作 CommHub resume_id | 重启后身份稳定 |
| 5 | 旧 node 自动补 node_id | 无感迁移 |
| 6 | 改名后旧 alias 不保留（P0） | 简单 |
| 7 | P1 加 alias history/映射 | 过渡期兼容 |

## 待讨论

1. CommHub rename API 怎么实现？UPDATE alias 还是 DELETE+INSERT？
2. 改名时 agent 是否需要停止？（建议：必须停止，运行中不允许 rename）
3. node_id 要不要暴露给用户？（建议：不主动展示，debug 时能看到就行）

---

**请通信牛 review。文件路径: ~/agent-orchestra/docs/node-id-proposal.md**

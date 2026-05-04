# 升级指南

本文介绍如何将 Agent Network 升级到最新版本，以及主要版本之间的迁移注意事项。

## 升级步骤

### 1. 检查当前版本

```bash
# 查看 CLI 版本
anet --version

# 查看 Agent Node 版本（如果全局安装）
agent-node --version

# 查看 CommHub Server 版本
curl http://127.0.0.1:9200/health
```

### 2. 备份配置

升级前务必备份你的配置文件：

```bash
# 备份全局配置
cp -r ~/.anet ~/.anet.backup

# 备份项目级配置（如果有）
cp -r .anet .anet.backup
```

::: warning 重要
备份目录包含你的 Token、节点配置和 session 记录。丢失后需要重新登录和配置。
:::

### 3. 升级 npm 包

```bash
# 升级 CLI + CommHub Server
npm install -g @sleep2agi/agent-network@preview

# 升级 Agent Node（如果全局安装了的话）
npm install -g @sleep2agi/agent-node@preview

# 如果用 npx，无需手动升级，下次运行自动拉取最新版
```

### 4. 重启进程

```bash
# 查看本地节点
anet node ls

# 停止需要重启的 Agent
anet node stop <name>

# 如果 Hub 是前台运行，回到 Hub 终端 Ctrl-C 后重启
anet hub start

# 重启 Agent
anet node start <name>
```

### 5. 验证升级

```bash
# 检查版本
anet --version

# 运行诊断
anet doctor

# 确认 Agent 在线
anet status
```

---

## V2 到 V3 迁移

V3 是一次重大升级，主要变化如下：

### 破坏性变更

| 变更项 | V2 | V3 | 影响 |
|--------|----|----|------|
| Token 体系 | 单 Token | 双 Token（`utok_` + `ntok_`） | **需要重新登录** |
| 配置格式 | `.agent-node.json` | `.anet/nodes/<id>/config.json` | 自动迁移 |
| CLI 命令 | `agent-node` | `anet` | 旧命令不可用 |

### 需要手动操作

1. **重新登录**：V3 使用新的双 Token 体系（用户 Token `utok_` + 网络 Token `ntok_`），旧 Token 不兼容。

   ```bash
   # 重新登录
   anet login --hub http://YOUR_HUB_IP:9200
   ```

2. **重新加入网络**：如果你之前加入了多个网络，需要重新加入。

   ```bash
   anet network join <invite_code>
   ```

### 自动保留的内容

以下内容在升级过程中会被自动保留或迁移：

- **节点配置**：`config.json` 中的 runtime、model、tools 等设置会被保留
- **Session 恢复**：`session` 字段会被保留，可以用 `anet node resume` 恢复之前的对话
- **节点名称**：alias/node_name 保持不变
- **环境变量**：`env` 字段中的 API Key 等配置保持不变

### 迁移命令

V3 提供了自动迁移工具：

```bash
# 自动检测并迁移旧配置
anet doctor

# doctor 会检查：
# - 旧格式配置文件 (.agent-node.json)
# - Token 有效性
# - 网络连接状态
```

---

## 回滚

如果升级后遇到问题，可以回滚到之前的版本：

### 回滚步骤

```bash
# 1. 停止所有服务
anet node stop <name>
# Hub 如果在前台运行，用 Ctrl-C 停止

# 2. 恢复备份的配置
rm -rf ~/.anet
cp -r ~/.anet.backup ~/.anet

# 3. 安装旧版本（指定版本号）
npm install -g @sleep2agi/agent-network@<旧版本号>
npm install -g @sleep2agi/agent-node@<旧版本号>

# 4. 重启服务
anet hub start
anet node start <name>

# 5. 验证
anet doctor
```

::: tip 查看可用版本
```bash
npm view @sleep2agi/agent-network versions --json
```
:::

### 常见升级问题

| 问题 | 原因 | 解决方案 |
|------|------|----------|
| `Token invalid` | V2 Token 在 V3 中不兼容 | 运行 `anet login` 重新登录 |
| `Config format error` | 旧配置格式未迁移 | 运行 `anet doctor` 自动迁移 |
| Agent 无法连接 | Server 版本不匹配 | 确保 Server 和 Node 版本一致 |
| `session not found` | Session 格式变更 | 用 `anet node start <name> --new-session` 创建新 session |

---

## 下一步

- [基本概念](/guide/basics) -- 了解 V3 的核心概念
- [CLI 命令](/guide/cli) -- 查看所有 V3 命令
- [FAQ](/faq) -- 常见问题

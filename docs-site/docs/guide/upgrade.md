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
npm install -g @sleep2agi/agent-network

# 升级 Agent Node（如果全局安装了的话）
npm install -g @sleep2agi/agent-node

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

## v0.7 → v0.8 升级注意（最新） {#v0-7-v0-8-升级注意-最新}

v0.8 落地了 [RFC-001 第二阶段](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-001-deprecate-commhub-auth-token.md)，对**鉴权和密码**有新行为：

::: tip v0.8.x 增量（当前 stable v0.8.3）
v0.8.1 stable 之后，v0.8.2 / v0.8.3 陆续加了：`anet channel add telegram` 一键绑定、`claude-code-cli` runtime session resume 修复、`anet create --batch` 批量 agent 原语、`anet demo sci-team` / `pr-review` demo、`anet login` 首次登录引导 等。

这些增量**升级路径跟 v0.7 → v0.8 主路径一致**（admin bootstrap + 密码管理），无额外步骤。完整增量逐版见 [changelog](/changelog)。
:::

### 行为变化

| 项 | v0.7 | v0.8 | 影响 |
|----|------|------|------|
| Hub 启动密码 | 无需 / `COMMHUB_AUTH_TOKEN` | **首次 `anet hub start` 非交互 bootstrap admin（默认 `admin` / `anethub`，flag `--username` / `--password` 可覆盖）** | 首次自动创建，无交互 prompt |
| 全局 master token | `COMMHUB_AUTH_TOKEN` 写 / 读全权 | **软废弃**：仅 `/api/*` 只读 + deprecation warning | 写操作会被拒 |
| 密码强度 | 无校验 | **≥ 8 位 + 弱密码字典拦截**（首次 bootstrap admin 例外允许 ≥ 4） | 弱密码报错 |
| 修改密码 | 无命令 | **`anet passwd`** 交互式改 | 新工具 |
| 管理员重置 | 手动改 SQLite | **`anet hub admin reset-user <username>`** | 本机 owner 即可 |
| Token 修复 | 手动 `anet login` | **`anet doctor --fix`** 自动 probe 并重发 `ntok_` | doctor 更聪明 |

### 升级步骤

```bash
# 1. 升级三件套（npm latest tag —— 当前主线见 npmjs.com 主页）
npm install -g @sleep2agi/agent-network@latest
npm install -g @sleep2agi/agent-node@latest

# commhub-server 不用单独装 —— anet hub start 会用 bunx 拉一个 PINNED 版本
# (verify agent-network/bin/cli.ts:2088 PINNED_SERVER_VERSION; anet 升级时这个版本号会跟着升)
# ⚠ commhub-server 是 bun shebang TypeScript，必须先装 Bun: curl -fsSL https://bun.sh/install | bash

# 2. 重启 Hub（首次自动 bootstrap admin，无 prompt）
anet hub start
# 看到 '✅ Admin account created' + 'username: admin / password: anethub'
# 或 '✅ Admin already exists' (~/.anet/server/admin-utok.json 已存在则跳过 register)
# 详见 [troubleshooting#admin-bootstrap](/troubleshooting)

# 3. doctor 修 token + 网络
anet doctor --fix
# 自动探测过期 ntok_ 并重发；旧 atok_ 会被标 deprecation 但仍能读
```

### 仍设了 `COMMHUB_AUTH_TOKEN` 怎么办？

- 不会报错，仍然能读 `/api/*` 接口，但日志会刷 deprecation warning
- 写操作（注册、配置 agent 等）必须改走 `utok_`（登录后从 `~/.anet/config.json` 读）
- v1.0 会**完全移除**这条路径（RFC-001 阶段 3），建议本轮升级时一起清掉

### 忘了密码？

```bash
# 在 Hub 所在机器（需要 SQLite 写权限）
anet hub admin reset-user <username>
# 走交互重设密码，无需老密码
```

详细机制见 [安全模型](/concepts/security)。

---

## V2 到 V3 迁移

V3 是一次重大升级，主要变化如下：

### 破坏性变更

| 变更项 | V2 | V3 | 影响 |
|--------|----|----|------|
| Token 体系 | 单 Token | 双 Token（`utok_` + `ntok_`） | **需要重新登录** |
| 配置格式 | `.agent-node.json` | `.anet/nodes/<node-name>/config.json` | 自动迁移 |
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

- [基本概念](/guide/basics) -- 了解 Agent Network 核心概念
- [CLI 命令](/guide/cli) -- 查看完整 anet 命令清单
- [FAQ](/faq) -- 常见问题

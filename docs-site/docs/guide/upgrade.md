# 升级指南（已装 anet 升新版）

本文介绍**老用户**将 Agent Network 升级到最新版本的步骤，以及主要版本之间的迁移注意事项。

::: tip 大部分情况：一句话
```bash
anet upgrade          # 自动升 agent-network / agent-node / 重启提示（一两分钟后 anet -v 已是新版）
```

升完跑 `anet project restart` 重启 cwd 下的节点把新 agent-node 吃进去就完事了。下面分章节是「需要细看」的场景。
:::

::: details 我装的是 v0.10.6 以前的旧版（binary 2.2.4 及以下）
这条只对 binary `2.2.4` 及以下的人有用 —— `anet -v` 看到 `2.2.5` 或更新的可以跳过整段。

v0.10.6 [#154](https://github.com/sleep2agi/agent-network/issues/154) 才真解 chicken-and-egg（默认 `spawn(forkScript, { detached: true })` + `child.unref()` + 主进程 exit，detached child 后台跑 `npm install`）。该修复只在 `2.2.5+` 的 binary 里生效；v0.10.4 [#151](https://github.com/sleep2agi/agent-network/issues/151) 只改了文案没解 deadlock。

**只需手装 1 次**直接 jump 到 latest：

```bash
npm install -g @sleep2agi/agent-network@latest
anet --version            # 当前 latest v2.2.12（v0.10.15，2026-06-14）
```

之后再有新版本，跑 `anet upgrade` 即自动 detached spawn，一两分钟后 `anet -v` 是新版。
:::

::: details 全新机器从未装过 anet
**首次安装**走 [上手指南](/guide/getting-started) 或一行 shell：

```bash
npm install -g @sleep2agi/agent-network
# 或一键安装脚本（含 admin password 提示等 UX）
curl -fsSL https://anet.sh/install.sh | bash
```

本页是给**已装 anet 的老用户**做版本升级用的。
:::

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

::: tip v0.9.0+：`anet upgrade` 一键
[#88](https://github.com/sleep2agi/agent-network/issues/88) 给 `anet upgrade` 加了 4-包覆盖 + 双通道 + 干跑 + 自升，**强烈建议先 `--dry-run` 看计划再决定怎么动**：

```bash
# 干跑：只打印 plan，不真升（4 包 × current→target × action badge）
anet upgrade --dry-run

# 实际跑（默认 print 手动 npm 命令，不自动改全局；channel 由 anet 当前版本自动判 prerelease→preview / 否则 latest）
anet upgrade

# 强制选通道（覆盖 auto-detect）
anet upgrade --channel preview
anet upgrade --channel latest

# 自升 anet 本身（opt-in detached spawn，stderr 落 /tmp/anet-self-upgrade.err；不加这个 flag 默认 print 手动命令避免升级时替换运行中进程）
anet upgrade --self
```

**计划行解读**：每行一个包 + `current → target` + 一个 action badge —

| Badge | 含义 |
|------|------|
| `upgrade` | 该包 current < target，需要装新版 |
| `up-to-date` | 已经是 target，跳过 |
| `lazy via npx skip` | 全局没装 + anet `bunx/npx` 按需拉取，不用全局升 |
| `self skip` | 默认不自升 anet 本身（要加 `--self`）|
| `lookup failed` | npm registry 查不到 latest，网络/包名问题 |

**特别提示 `commhub-server`**：这行显示当前 `PINNED_SERVER_VERSION`（v0.10.15 stable 是 `0.8.4`，历史 chain 见 [changelog](/changelog) `commhub-server` 段）—— `anet hub start` 不管全局装的是什么版本都跑这个 pinned 版（避免 server breaking 风险）。所以即使全局 `commhub-server` 升了也没影响 hub 实际运行。

**升完之后**：`anet upgrade` 末尾会提示「跑过的节点要重启拿新 agent-node」，可以一键：

```bash
anet project restart    # #117，cwd 下所有节点
# 或单台单台：anet node stop <name> && anet node start <name>
```

`anet upgrade` 已是 v0.9.0+ stable (`@latest`) 默认行为。
:::

**手动 npm（任何通道都能用）**：

```bash
# 升级 CLI（CommHub Server 不在此包里 —— 由下方 step 4 的 anet hub start 自动按 PINNED 版本 bunx 拉取）
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

## v0.7 → v0.8 升级注意（历史路径） {#v0-7-v0-8-升级注意-最新}

::: info 看这节的人应该越来越少
当前 stable 是 v0.10.13。从 v0.8 / v0.9 / v0.10.x 之间升级直接 `anet upgrade` 或 `npm install -g @sleep2agi/agent-network@latest` 即可，**无须重做下方 v0.7→v0.8 鉴权迁移**。完整逐版改动见 [changelog](/changelog)。本节保留作 v0.7 → v0.10.13 跨版本升级时的关键节点参考。
:::

::: details v0.7 → v0.8 鉴权 / 密码管理迁移细节
v0.8 落地了 [RFC-001 第二阶段](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-001-deprecate-commhub-auth-token.md)，对**鉴权和密码**有新行为：

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
# (verify agent-network/bin/cli.ts PINNED_SERVER_VERSION; anet 升级时这个版本号会跟着升)
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
:::

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

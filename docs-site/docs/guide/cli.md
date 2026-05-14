# CLI 命令参考

`anet` 是 Agent Network 的命令行管理工具，覆盖 Hub、账号、Network、Agent Node、监控和 Demo 操作。

## 安装

```bash
npm install -g @sleep2agi/agent-network
```

安装后即可使用 `anet` 命令。

## 命令总览

### 快速启动

| 命令 | 说明 | 状态 |
|------|------|------|
| `anet init` | 配置 hub 地址 | 已验证 |
| `anet init project` | 配置 Claude Code 项目（`project` 是固定子命令，不是项目名占位符） | 已验证 |
| `anet setup` | 交互式安装 runtime 依赖（按需勾选 claude CLI / agent-node / codex CLI / commhub-server） | 已验证 |

### 服务器管理

| 命令 | 说明 |
|------|------|
| `anet hub start` | 启动 CommHub Server |
| `anet hub dashboard` | 启动 Dashboard UI |
| `anet hub config` | 查看/修改 Hub 配置 |
| `anet hub admin reset-user --username <u>` | 本机重置普通用户密码 |

### 账号管理

| 命令 | 说明 |
|------|------|
| `anet register` | 注册账号 |
| `anet login` | 登录 |
| `anet logout` | 退出（清掉本机 `~/.anet/config.json` 里的 token，但 hub 端 token 仍有效；要彻底失效请用 `anet token revoke`） |
| `anet whoami` | 查看当前用户 |
| `anet passwd` | 修改密码 |

### 网络管理

| 命令 | 说明 |
|------|------|
| `anet network ls` | 列出网络 |
| `anet network create <name>` | 创建网络 |
| `anet network use <name>` | 切换当前网络 |
| `anet network info` | 查看当前网络详情 |
| `anet network rename <old> <new>` | 重命名网络 |
| `anet network delete <name> --force` | 删除网络（owner 限定，需要 `--force` 跳过确认） |
| `anet network invite` | 为当前网络创建邀请码 |
| `anet network join <invite_code>` | 用邀请码加入网络 |
| `anet network members` | 列出当前网络成员（role / joined_at） |

### Token 管理

| 命令 | 说明 |
|------|------|
| `anet token create <name>` | 创建 API Token（Token 只显示一次，立即保存） |
| `anet token` / `anet token ls` | 列出所有 Token（默认子命令 = ls） |
| `anet token revoke <id>` | 撤销 Token（hub 端立即吊销） |

### Agent Node 管理

| 命令 | 说明 |
|------|------|
| `anet node create <name>` | 创建 Agent 节点 |
| `anet node start <name>` | 启动 Agent |
| `anet node stop <name>` | 停止 Agent |
| `anet node resume <name>` | 恢复上次 session |
| `anet node ls` | 列出所有节点 |
| `anet info <name>` | 查看 Agent 详情 |
| `anet logs <name>` | 查看 Agent 日志（加 `--follow` 实时 tail） |
| `anet node rename <old> <new>` | 重命名 Agent |
| `anet node delete <name>` | 删除 Agent（默认交互式确认；加 `--force` 或 `--yes` 跳过；**不自动撤销 ntok_** — 要彻底清干净加 `anet token revoke <id>`，详见 [Token 生命周期](/concepts/tokens#token-生命周期对照)） |

### 监控

| 命令 | 说明 |
|------|------|
| `anet status` | 网络概览（在线 Agent + 任务统计） |
| `anet tasks [status]` | 查看任务列表 |
| `anet doctor` | 系统诊断（加 `--fix` 自动 probe + 重发过期 `ntok_` 写回节点 config） |

### Demo（多 Agent 演示）

| 命令 | 说明 |
|------|------|
| `anet demo ls` | 列出可用 demo |
| `anet demo debate [opts]` | **辩论赛**：6 角色（主持/正反 4 辩/评委）一键 9 步辩论 |
| `anet demo socialmedia [opts]` | **社交媒体内容工厂**：4 角色（选题/文案/配图/审核）~3 min |
| `anet demo pr-review [opts]` | **代码 PR 审查室**：4 角色（安全/性能/风格 3 reviewer 并行 + judge）~2 min |

详见 [辩论赛 Demo 案例](/cases/debate)。其他 demo 用法跑 `anet demo <name> --help` 查看。

### Channel 管理

| 命令 | 说明 |
|------|------|
| `anet channel add <type>` | 添加 Channel（telegram/wechat/feishu） |
| `anet channel ls` | 列出 Channel |

### 其他

| 命令 | 说明 |
|------|------|
| `anet config` | **只读**查看 `~/.anet/config.json` 内容（`anet config path` 打印路径，`anet config json` 输出 raw JSON）。修改走 `anet login` / `anet init` / `anet network use`，不是 `anet config --set`。verify [`cli.ts:5571-5600 configShowCommand`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L5571) |
| `anet upgrade` | 打印升级计划（self-upgrade 默认关闭，避免升级中替换正在运行的 CLI 进程；给出手动步骤）。完整指南见 [升级指南](/guide/upgrade) |
| `anet create --batch` / `anet batch <verb>` | 批量起 N 个 agent（prefix 自动编号 + 独立 workdir/config/tmux），再用 `anet batch list/stop/cleanup/start` 统一管 lifecycle。详见 [批量 Agent](/guide/batch) |
| `anet license` | v0.6 legacy 命令，查看 trial / license 状态。**Apache 2.0 OSS 后不再需要**；Hub 仍保留 `licenses` 表 + `send_task` 14 天 trial 检查做后向兼容 |
| `anet activate <key>` | v0.6 legacy，写入 pro license key。**Apache 2.0 OSS 后不再需要**；用于命中 `license_expired` 兜底，见 [troubleshooting](/troubleshooting) |
| `anet session ls` | 列出当前项目下的 Claude Code session（`claude-code-cli` runtime 用） |
| `anet import [alias]` | 从 CommHub 把 claude-code agent 的 session 导入为本地 `.anet/nodes/<alias>/config.json`（不传 alias 则导入全部） |

---

## 详细用法

### anet hub start

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L2068)

启动 CommHub 通信服务器。

```bash
anet hub start [options]
```

**执行这条命令后，系统自动完成以下操作：**

1. 启动 CommHub Server（默认绑定 `127.0.0.1:9200`，仅本机可访问；v0.8 起不再需要 `COMMHUB_AUTH_TOKEN`）
2. 创建 SQLite 数据库（`~/.commhub/commhub.db`，含 13 张表）
3. 首次运行自动 bootstrap admin 账户，默认凭证 **`admin / anethub`**（快速上手），并把 admin `utok_` 写到 `~/.anet/server/admin-utok.json`（chmod 600）
4. 写入本机 Hub 地址到 `~/.anet/config.json`
5. 如已有有效 `utok_` 会复用登录态；否则用默认凭证 `anet login --username admin --password anethub`
6. **公网部署立刻 `anet passwd` 改密**

::: info 你应该看到
```
anet hub start
Starting CommHub Server on port 9200 (bind 127.0.0.1)...
✅ Server running on http://127.0.0.1:9200 (commhub-server v0.8.0)
🔒 secured
✅ Admin account created
   username: admin
   password: anethub
   Store this password now; it will not be shown again.
   Admin token saved to ~/.anet/server/admin-utok.json

This machine — login then create a node:
  anet login --username admin --password anethub
  anet node create my-agent
  anet node start my-agent
```
:::

::: tip 想自定义凭证（推荐公网部署）
默认 `admin / anethub` 只适合本机快速上手。公网部署可以传 flag 直接设强密码：
```bash
anet hub start --username alice --password 'your-strong-pass!'
```
注意：自定义密码必须 ≥ 8 位且不在 top-1000 弱密码字典里。默认凭证（首次启动）不受此强度限制 —— 但**必须**用 `anet passwd` 立刻改成强密码。
:::

::: tip 第二次启动（idempotent）
admin 已经 bootstrap 过（`~/.anet/server/admin-utok.json` 存在），再次 `anet hub start` 会显示：
```
✅ Admin already exists (admin-utok.json found, user=admin)
```
不会重复创建，也不会再 prompt。
:::

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--port` | 9200 | 监听端口 |
| `--host` / `--ip` | 127.0.0.1 | 绑定地址；局域网接入用 `0.0.0.0` |
| `--username` | `admin` | 自定义 admin 用户名 |
| `--password` | `anethub`（快速上手默认） | 自定义 admin 密码（≥8 位 + 非弱密码；默认值跳过强度校验） |
| `--dev-open` | false | **危险**：无鉴权运行，仅用于离线 tutorial |

**环境变量**：

| 变量 | 说明 |
|------|------|
| `PORT` | 监听端口 |
| `COMMHUB_AUTH_TOKEN` | 旧 master token 兼容环境变量；v0.8 起 deprecated |
| `DATABASE_URL` | PostgreSQL 连接（v0.8+ 产品方向已转 SQLite only，详见 [v3-postgresql-design.md banner](https://github.com/sleep2agi/agent-network/blob/main/docs/v3-postgresql-design.md)；adapter 仅作社区扩展点保留 / E2E 未验证，**主线不推荐生产使用**；默认 SQLite） |
| `COMMHUB_CORS_ORIGINS` | CORS 白名单 |

### anet passwd

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L3509)

修改当前登录用户密码。默认交互式输入旧密码、新密码、确认密码；脚本可用 `--old` / `--new`。

```bash
anet passwd
anet passwd --old old-password --new new-password
```

成功后 hub 会返回新的 `utok_`，CLI 自动写回 `~/.anet/config.json`。该用户其他设备上的 `utok_` 会失效；agent 使用的 `ntok_` 不受影响。

### anet hub admin reset-user

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L2318)

Hub 主机本机恢复命令，绕过 HTTP API 直接读 SQLite。

```bash
anet hub admin reset-user --username alice
```

它会生成随机新密码、撤销该用户全部 `utok_`、颁发一个新的 `utok_` 并在 `audit_log` 写入 `password_reset_by_admin`。新密码只打印一次。

### anet node create

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L1391) (`createCommand`)

创建新的 Agent 节点。

```bash
anet node create <name> [options]
```

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--runtime` | (交互选择) | `claude-agent-sdk` / `codex-sdk` / `claude-code-cli` |
| `--model` | (按 runtime 默认) | 模型名称 |

**示例**：

```bash
# 交互式创建
anet node create my-agent

# 直接指定
anet node create 代码助手 --runtime codex-sdk --model <codex-model-id>

# MiniMax Agent
anet node create 翻译官 --runtime claude-agent-sdk --model <minimax-model-id>
```

创建后会在 `.anet/nodes/<node-name>/config.json` 生成配置文件（目录名是 alias，不是内部 `node_id`）。下面是上面 `codex-sdk` 示例命令（未带额外 flag）的实际输出：

```json
{
  "anet_version": "0.1.0",
  "node_id": "n_a1b2c3d4",
  "node_name": "代码助手",
  "alias": "代码助手",
  "runtime": "codex-sdk",
  "model": "<codex-model-id>",
  "channels": ["server:commhub"],
  "env": {},
  "flags": {
    "dangerouslySkipPermissions": true
  }
}
```

以下字段**按条件生成**，不是每个 node 都有：`teammateMode`（仅 `claude-code-cli` runtime，默认 `in-process`）、`session`（仅 `claude-code-cli` runtime 或传了 `--session`）、`maxTurns`（仅传了 `--max-turns`）、`tools`（仅传了 `--tools`）。

### anet node start

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L1867)

启动 Agent 节点。

```bash
anet node start <name> [options]
```

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--new-session` | false | 忽略旧 session，创建新的 |

**流程**：

1. 读取 `.anet/nodes/<name>/config.json`
2. 自动补充 `node_id`（如果没有）
3. 启动 tmux session
4. spawn Agent 进程（根据 runtime）
5. 连接 CommHub（`report_status(idle)`）
6. 建立 SSE 长连接
7. 等待任务

### anet status

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L2896)

查看网络状态概览。

```bash
anet status
```

输出示例：

```
Agent Network Status
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Network: default (net_a1b2c3d4)
Server:  http://localhost:9200

Nodes (5 online, 2 offline):
  🟢 指挥室      idle     Claude      3s ago
  🟢 代码1号     working  Codex (codex-sdk)     写排序算法
  🟢 代码2号     idle     Codex (codex-sdk)     15s ago
  🟢 文案1号     idle     MiniMax     1m ago
  🟢 文案2号     idle     MiniMax     2m ago
  ⚪ 测试1号     offline              2h ago
  ⚪ 测试2号     offline              3h ago

Tasks: 42 replied, 3 running, 0 failed
```

### anet tasks

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L2960)

查看任务列表。

```bash
anet tasks [status] [--limit <n>]
```

| 参数 | 说明 |
|------|------|
| `status` | 按状态过滤；任何 [Task 生命周期状态机](/concepts/task-lifecycle#状态说明) 中的状态都可传（`delivered` / `acked` / `running` / `replied` / `failed` / `cancelled` / `expired`） |
| `--limit` | 显示条数（默认 20） |

**示例**：

```bash
# 查看所有任务
anet tasks

# 只看失败的
anet tasks failed

# 限制条数
anet tasks --limit 5
```

### anet doctor

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L5818)

系统诊断。

```bash
anet doctor              # 只诊断，输出每项 ✅ / ❌ + 修复提示
anet doctor --fix        # 自动修复：(a) migrateNode 把 V2 legacy 字段 (alias/resume/legacy_runtime_name) 改成 v0.8 schema (b) probe 过期 ntok_ 并跟 hub 重发新 token 写回 .anet/nodes/<name>/config.json
```

检查项（按 [`cli.ts:5818-5983 doctorCommand`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L5818) 实际顺序）：

1. 全局配置（`~/.anet/config.json` 有无 hub / token）
2. Auth token 是否存在
3. Hub 可达性（GET `/health` + 显示 sessions / SSE / license / multi-network 信息）
4. 本地节点配置 + 各节点运行状态 + legacy 字段诊断（[`diagnoseNode` cli.ts:5743](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L5743)：legacy_alias_field / legacy_resume_field / legacy_runtime_name / stale_dev_hub / missing_token / user_token / untyped_token / missing_node_id 共 8 种）
5. 依赖：`claude --version` / `codex --version` / `bun --version`
6. 当前项目 `.mcp.json` 的 commhub 配置
7. Telegram channel env（`~/.claude/channels/telegram/.env` 是否被静默清空，是 `/telegram:configure` 已知的 token 丢失 foot-gun）

::: tip `--fix` 是 v0.8 新增
v0.7 之前 ntok_ 失效需要手动 `anet node delete` + 重新 create；v0.8 起 `--fix` 直接探测+重发，agent-node SSE 401 也会自动 reload token 不离线（[RFC-001 Phase 2](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-001-deprecate-commhub-auth-token.md) 实施细节）。
:::

### anet network invite

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L3333)

创建网络邀请码。

```bash
anet network invite [options]
```

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--role` | member | 邀请角色：`admin` / `member` / `viewer` |
| `--uses` | 1 | 最大使用次数，-1 为无限 |
| `--expires` | (无) | 过期天数 |

**示例**：

```bash
# 先切换到目标 network
anet network use dev

# 创建单次邀请码
anet network invite

# 创建可用 10 次的成员邀请码
anet network invite --role member --uses 10

# 创建 7 天过期的 viewer 邀请码
anet network invite --role viewer --expires 7
```

### anet token create

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L3456)

创建 API Token。

```bash
anet token create <name>
```

**示例**：

```bash
# 创建 API token
anet token create my-agent-token
```

::: warning 安全提示
创建的 Token 只会显示一次，请妥善保管。丢失后需要重新创建。
:::

### anet node resume

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L1875)

恢复之前被中断的 Agent session。当 Agent 崩溃、手动停止或意外退出时，可以用此命令恢复上下文，不丢失之前的对话历史。

```bash
anet node resume <name> [--session <id>]
```

| 参数 | 说明 |
|------|------|
| `<name>` | Agent 名称（alias） |
| `--session` | 指定要恢复的 session ID（可选） |

如果不指定 `--session`，会使用 config.json 中保存的上次 session。

**Session 自动保存机制**：

- 每次任务完成后，Agent Node 会自动将 session_id（Claude）或 thread_id（Codex）保存到 `config.json` 的 `session` 字段
- 下次用 `anet node resume` 时自动读取，无需手动记录

**适用场景**：

- Agent 进程崩溃或被 kill，需要恢复上下文继续工作
- 手动 `anet node stop` 后想要接着之前的对话继续
- 网络断连导致 Agent 掉线，重连后恢复

```bash
# 恢复上次 session
anet node resume 指挥室

# 恢复指定 session
anet node resume 马 --session abc123
```

::: tip 和 anet node start 的区别
`anet node start` 默认创建新 session。如果想恢复旧 session，用 `anet node resume`。如果想强制创建新 session，用 `anet node start <name> --new-session`。
:::

### anet init project

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L825)

初始化 Claude Code 项目，自动配置 MCP 和 CLAUDE.md。

这里的 `project` 是 **固定子命令关键字**，不是可替换的项目名占位符；请按字面输入 `anet init project`。它会在你当前所在目录初始化项目配置，不会创建名为 `project` 的新目录。

```bash
anet init project
```

**自动创建的文件**：

```
{项目}/
├── .mcp.json            # MCP Server 配置
├── CLAUDE.md            # Agent 行为规则
└── .anet/
    ├── node-server.js   # Channel 插件（自动从 npm 包 dist/src/node-server.js 复制；R216/R221 chain 一致）
    └── package.json     # 依赖
```

`.mcp.json` 内容：

```json
{
  "mcpServers": {
    "commhub": {
      "type": "stdio",
      "command": "bun",
      "args": [".anet/node-server.js"]
    }
  }
}
```

## 常用选项

常见命令会读取以下选项或对应配置：

| 选项 | 说明 |
|------|------|
| `--hub <url>` | CommHub Server 地址 |
| `--help` | 显示帮助 |
| `--version` | 显示版本 |

> v0.8 起鉴权统一走 `anet login --hub <URL> --username --password`（一步）或 `anet login` 拿 `utok_`，不再用 `--token` 传 master token。详见 [Token 概念](/concepts/tokens) + [RFC-001](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-001-deprecate-commhub-auth-token.md)。

## 环境变量

| 变量 | 说明 | 优先级 |
|------|------|--------|
| `COMMHUB_URL` | CommHub Server 地址 | env > 配置文件（命令行 `--hub` 最高） |
| `COMMHUB_ALIAS` | Agent 别名 | env > 配置文件（命令行 `--alias` 最高） |
| `COMMHUB_TOKEN` | 认证 Token | **agent-node：最低** —— node config (`ntok_`) > 全局 config > 此 env，且 env 跟 node config 冲突时**被忽略 + 打 warning**（[`agent-node/src/cli.ts:187-190`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts#L187)，防 leftover export 把回复发错 network）。`anet` CLI 里则是 env > 全局 config |
| `COMMHUB_AUTH_TOKEN` | **server 端** legacy master token（v0.8 软废弃，v1.0 移除）—— 由 hub 进程读，不是 agent 连接用的优先级变量 | server-side |
| `ANTHROPIC_BASE_URL` | 模型 API 地址（MiniMax / DeepSeek / GLM / Kimi / 书生 / 小米 MiMo / OpenRouter 等第三方 Anthropic 兼容 endpoint；完整 provider 列表见 [multi-model](/guide/multi-model)） | - |
| `ANTHROPIC_AUTH_TOKEN` | 模型 API Key —— **第三方 Anthropic 兼容 endpoint** 走这个 | - |
| `ANTHROPIC_API_KEY` | 模型 API Key —— **api.anthropic.com 直连专用**（详见 [runtimes 常见坑](/guide/runtimes#claude-agent-sdk)） | - |

## 下一步

**手把手起步**：
- 从零跑一遍：[一键安装与起步](/guide/one-shot-install) — 装 + 跑第一个 agent
- 看 demo：[Hello World](/cases/hello-world) / [辩论赛](/cases/debate) / [军团编队](/cases/telegram-squad)

**深入命令背后**：
- 配置文件结构：[Agent Node](/guide/agent-node)（config.json 字段说明）
- 多个 runtime 怎么选：[Runtimes](/guide/runtimes)
- 国产/海外模型切换：[多模型配置](/guide/multi-model)

**v0.8 新工具**：
- `anet passwd` — 改密码（[安全设计](/concepts/security)）
- `anet hub admin reset-user <username>` — 本机重置用户（owner 强制）
- `anet doctor --fix` — 自动探测 + 重发过期 ntok_
- `anet hub start` — 首次自动 bootstrap admin（默认 `admin / anethub`）

**完整升级指南**：[v0.7 → v0.8 升级注意](/guide/upgrade#v0-7-v0-8-升级注意-最新)

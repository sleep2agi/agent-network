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
| `anet init project` | 配置 Claude Code 项目（.mcp.json + CLAUDE.md） | 已验证 |
| `anet quickstart` | 旧的一键启动命令 | 未验证 / 不推荐使用 |

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
| `anet whoami` | 查看当前用户 |
| `anet passwd` | 修改密码 |

### 网络管理

| 命令 | 说明 |
|------|------|
| `anet network ls` | 列出网络 |
| `anet network create <name>` | 创建网络 |
| `anet network use <name>` | 切换当前网络 |
| `anet network info <name>` | 查看网络详情 |
| `anet network rename <old> <new>` | 重命名网络 |
| `anet network delete <name>` | 删除网络 |
| `anet network invite` | 为当前网络创建邀请码 |
| `anet network join <invite_code>` | 用邀请码加入网络 |

### Token 管理

| 命令 | 说明 |
|------|------|
| `anet token create <name>` | 创建 API Token |
| `anet token ls` | 列出所有 Token |
| `anet token revoke <id>` | 撤销 Token |

### Agent Node 管理

| 命令 | 说明 |
|------|------|
| `anet node create <name>` | 创建 Agent 节点 |
| `anet node start <name>` | 启动 Agent |
| `anet node stop <name>` | 停止 Agent |
| `anet node resume <name>` | 恢复上次 session |
| `anet node ls` | 列出所有节点 |
| `anet info <name>` | 查看 Agent 详情 |
| `anet logs <name>` | 查看 Agent 日志 |
| `anet node rename <old> <new>` | 重命名 Agent |
| `anet node delete <name>` | 删除 Agent |

### 监控

| 命令 | 说明 |
|------|------|
| `anet status` | 网络概览（在线 Agent + 任务统计） |
| `anet tasks [status]` | 查看任务列表 |
| `anet demo monitor --live` | 实时系统 Dashboard（终端版，旧 `anet demo --live`） |
| `anet doctor` | 系统诊断 |

### Demo（多 Agent 演示）

| 命令 | 说明 |
|------|------|
| `anet demo ls` | 列出可用 demo |
| `anet demo debate [opts]` | **辩论赛**：6 角色（主持/正反 4 辩/评委）一键 9 步辩论 |
| `anet demo monitor [--live]` | 终端 Dashboard（保留兼容） |

详见 辩论赛 Demo 案例。

### Channel 管理

| 命令 | 说明 |
|------|------|
| `anet channel add <type>` | 添加 Channel（telegram/wechat/feishu） |
| `anet channel ls` | 列出 Channel |

### 其他

| 命令 | 说明 |
|------|------|
| `anet config` | 查看/修改配置 |
| `anet license` | 查看授权状态 |
| `anet activate <key>` | 激活授权 |

---

## 详细用法

### anet hub start

启动 CommHub 通信服务器。

```bash
anet hub start [options]
```

**执行这条命令后，系统自动完成以下操作：**

1. 启动 CommHub Server（v0.8 起不需要 `COMMHUB_AUTH_TOKEN`）
2. 启动 CommHub Server（默认绑定 `127.0.0.1:9200`，仅本机可访问）
3. 创建 SQLite 数据库（`~/.commhub/commhub.db`，含 13 张表）
4. 首次运行自动 bootstrap admin 账户，默认凭证 **`admin / anethub`**（快速上手），并把 admin `utok_` 写到 `~/.anet/server/admin-utok.json`（chmod 600）
5. 写入本机 Hub 地址到 `~/.anet/config.json`
6. 如已有有效 `utok_` 会复用登录态；否则用默认凭证 `anet login --username admin --password anethub`
7. **公网部署立刻 `anet passwd` 改密**

::: info 你应该看到
```
anet hub start
Starting CommHub Server on port 9200 (bind 127.0.0.1)...
✅ Server running on http://127.0.0.1:9200 (commhub-server v0.8.0-...)
🔒 secured
✅ Admin account created
   username: admin
   password: anethub
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
anet hub start --username alice --password 'mypass2026!'
```
注意：自定义密码必须 ≥ 8 位且不在 top-1000 弱密码字典里。默认凭证（首次启动）不受此强度限制 —— 但**必须**用 `anet passwd` 立刻改成强密码。
:::

::: tip 第二次启动
admin 已经 bootstrap 过（`~/.anet/server/admin-utok.json` 存在），再次 `anet hub start` 会显示：
```
✅ Admin already exists (admin-utok.json found, user=admin)
```
不会重复创建。
:::

::: tip 第二次启动
admin 已经 bootstrap 过（`~/.anet/server/admin-utok.json` 存在），再次 `anet hub start` 会显示：
```
✅ Admin already exists (admin-utok.json found, user=admin)
```
不会重复创建。
:::

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--port` | 9200 | 监听端口 |
| `--host` / `--ip` | 127.0.0.1 | 绑定地址；局域网接入用 `0.0.0.0` |
| `--username` | `admin` | 自定义 admin 用户名 |
| `--password` | `anethub`（快速上手默认） | 自定义 admin 密码（≥8 位 + 非弱密码；默认值跳过强度校验） |
| `--dev-open` | false | **危险**：无鉴权运行，仅用于离线 tutorial |
| `--token` | — | 旧 master token 兼容参数；v0.8 起 deprecated |

**环境变量**：

| 变量 | 说明 |
|------|------|
| `PORT` | 监听端口 |
| `COMMHUB_AUTH_TOKEN` | 旧 master token 兼容环境变量；v0.8 起 deprecated |
| `DATABASE_URL` | PostgreSQL 连接（代码层入口，v2.1 未做 E2E 验证，**不推荐生产使用**；默认 SQLite） |
| `COMMHUB_CORS_ORIGINS` | CORS 白名单 |

### anet node create

### anet passwd

修改当前登录用户密码。默认交互式输入旧密码、新密码、确认密码；脚本可用 `--old` / `--new`。

```bash
anet passwd
anet passwd --old old-password --new new-password
```

成功后 hub 会返回新的 `utok_`，CLI 自动写回 `~/.anet/config.json`。该用户其他设备上的 `utok_` 会失效；agent 使用的 `ntok_` 不受影响。

### anet hub admin reset-user

Hub 主机本机恢复命令，绕过 HTTP API 直接读 SQLite。

```bash
anet hub admin reset-user --username alice
```

它会生成随机新密码、撤销该用户全部 `utok_`、颁发一个新的 `utok_` 并在 `audit_log` 写入 `password_reset_by_admin`。新密码只打印一次。

### anet node create

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
anet node create 代码助手 --runtime codex-sdk --model gpt-5

# MiniMax Agent
anet node create 翻译官 --runtime claude-agent-sdk --model MiniMax-M2.7
```

创建后会在 `.anet/nodes/<node_id>/config.json` 生成配置文件：

```json
{
  "anet_version": "0.1.0",
  "node_id": "n_a1b2c3d4",
  "node_name": "代码助手",
  "runtime": "codex-sdk",
  "model": "gpt-5",
  "session": "",
  "channels": ["server:commhub"],
  "tools": [],
  "env": {},
  "flags": {
    "dangerouslySkipPermissions": true,
    "teammateMode": "in-process",
    "maxTurns": 20,
    "logLevel": "info"
  }
}
```

### anet node start

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

查看任务列表。

```bash
anet tasks [status] [--limit <n>]
```

| 参数 | 说明 |
|------|------|
| `status` | 按状态过滤：`delivered` / `running` / `replied` / `failed` / `cancelled` |
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

系统诊断。

```bash
anet doctor
```

检查项：

1. 全局配置（`~/.anet/config.json`）
2. 认证 Token 是否存在
3. Hub 可达性（GET `/health`）
4. 本地节点配置与运行状态
5. Claude / Codex / Bun 依赖
6. 当前项目 `.mcp.json` 的 commhub 配置

### anet network invite

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

初始化 Claude Code 项目，自动配置 MCP 和 CLAUDE.md。

```bash
anet init project
```

**自动创建的文件**：

```
{项目}/
├── .mcp.json            # MCP Server 配置
├── CLAUDE.md            # Agent 行为规则
└── .anet/
    ├── node-server.ts   # Channel 插件
    └── package.json     # 依赖
```

`.mcp.json` 内容：

```json
{
  "mcpServers": {
    "commhub": {
      "type": "stdio",
      "command": "bun",
      "args": [".anet/node-server.ts"]
    }
  }
}
```

## 常用选项

常见命令会读取以下选项或对应配置：

| 选项 | 说明 |
|------|------|
| `--hub <url>` | CommHub Server 地址 |
| `--token <token>` | 认证 Token |
| `--help` | 显示帮助 |
| `--version` | 显示版本 |

## 环境变量

| 变量 | 说明 | 优先级 |
|------|------|--------|
| `COMMHUB_URL` | CommHub Server 地址 | 最高 |
| `COMMHUB_ALIAS` | Agent 别名 | 最高 |
| `COMMHUB_AUTH_TOKEN` | 认证 Token | 最高 |
| `COMMHUB_TOKEN` | 认证 Token（别名） | 最高 |
| `ANTHROPIC_BASE_URL` | 模型 API 地址（MiniMax 等） | - |
| `ANTHROPIC_AUTH_TOKEN` | 模型 API Key | - |
| `ANTHROPIC_API_KEY` | 模型 API Key（别名） | - |

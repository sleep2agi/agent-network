# CLI 命令参考

`anet` 是 Agent Network 的命令行管理工具，提供 39 个命令覆盖从启动到监控的全部操作。

## 安装

```bash
npm install -g @sleep2agi/agent-network@preview
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
| `anet hub start` | 本地开发模式启动 |
| `anet hub stop` | 停止 Server |

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
| `anet network invite <name>` | 创建邀请码 |
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
| `anet restart-all` | 重启所有离线 Agent |

### 监控

| 命令 | 说明 |
|------|------|
| `anet status` | 网络概览（在线 Agent + 任务统计） |
| `anet tasks [status]` | 查看任务列表 |
| `anet demo` | 实时系统 Dashboard（终端版） |
| `anet doctor` | 系统诊断 |

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

1. 生成 `COMMHUB_AUTH_TOKEN`（首次运行时自动生成，保存到 `~/.anet/server/config.json`）
2. 启动 CommHub Server（绑定 `127.0.0.1:9200`，仅本机可访问）
3. 创建 SQLite 数据库（`~/.commhub/commhub.db`，含 13 张表）
4. 自动注册 admin 用户（首次运行）
5. 自动登录（保存 `utok_` 到 `~/.anet/config.json`）
6. 创建默认网络（`default`）
7. 启动 14 天免费试用

::: info 你应该看到
```
╔═══════════════════════════════════════════╗
║   🏠 anet hub start — One-command setup  ║
╚═══════════════════════════════════════════╝
[commhub] Server running at http://127.0.0.1:9200
[commhub] Auth: enabled (token saved)
[anet] ✅ Registered as admin
[anet] ✅ Logged in (utok_xxxx)
[anet] ✅ Default network created
```
:::

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--port` | 9200 | 监听端口 |
| `--token` | (自动生成) | Bearer 认证 Token |
| `--db` | ~/.commhub/commhub.db | 数据库路径 |
| `--cors` | * | CORS 允许的来源 |

**环境变量**：

| 变量 | 说明 |
|------|------|
| `PORT` | 监听端口 |
| `COMMHUB_AUTH_TOKEN` | 全局认证 Token |
| `DATABASE_URL` | PostgreSQL 连接（可选，默认 SQLite） |
| `COMMHUB_CORS_ORIGINS` | CORS 白名单 |

### anet node create

创建新的 Agent 节点。

```bash
anet node create <name> [options]
```

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--runtime` | (交互选择) | `codex-sdk` / `claude-agent-sdk` |
| `--model` | (按 runtime 默认) | 模型名称 |

**示例**：

```bash
# 交互式创建
anet node create my-agent

# 直接指定
anet node create 代码助手 --runtime codex-sdk --model gpt-5.5

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
  "model": "gpt-5.5",
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
anet status [--json]
```

输出示例：

```
Agent Network Status
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Network: default (net_a1b2c3d4)
Server:  http://localhost:9200

Nodes (5 online, 2 offline):
  🟢 指挥室      idle     Claude      3s ago
  🟢 代码1号     working  GPT-5.5     写排序算法
  🟢 代码2号     idle     GPT-5.5     15s ago
  🟢 文案1号     idle     MiniMax     1m ago
  🟢 文案2号     idle     MiniMax     2m ago
  ⚪ 测试1号     offline              2h ago
  ⚪ 测试2号     offline              3h ago

Tasks: 42 replied, 3 running, 0 failed
```

### anet tasks

查看任务列表。

```bash
anet tasks [status] [options]
```

| 参数 | 说明 |
|------|------|
| `status` | 按状态过滤：`delivered` / `running` / `replied` / `failed` / `cancelled` |
| `--limit` | 显示条数（默认 20） |
| `--from` | 按发送者过滤 |
| `--to` | 按接收者过滤 |
| `--json` | JSON 格式输出 |

**示例**：

```bash
# 查看所有任务
anet tasks

# 只看失败的
anet tasks failed

# 查看特定 Agent 的任务
anet tasks --to 代码1号

# JSON 输出
anet tasks --json
```

### anet doctor

系统诊断。

```bash
anet doctor
```

检查项：

1. Server 可达性（GET /health）
2. 认证状态（utok_ / ntok_ 有效性）
3. 网络配置完整性
4. Agent 连接状态
5. 数据库健康度
6. 磁盘空间

### anet network invite

创建网络邀请码。

```bash
anet network invite <network-name> [options]
```

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--role` | member | 邀请角色：`admin` / `member` / `viewer` |
| `--max-uses` | 1 | 最大使用次数，-1 为无限 |
| `--expires` | (无) | 过期天数 |

**示例**：

```bash
# 创建单次邀请码
anet network invite dev

# 创建可用 10 次的成员邀请码
anet network invite dev --role member --max-uses 10

# 创建 7 天过期的 viewer 邀请码
anet network invite dev --role viewer --expires 7
```

### anet token create

创建 API Token。

```bash
anet token create <name> [--network <id>]
```

**示例**：

```bash
# 为当前网络创建 token
anet token create my-agent-token

# 为指定网络创建 token
anet token create prod-token --network net_xxxxx
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
- 下次用 `anet resume` 时自动读取，无需手动记录

**适用场景**：

- Agent 进程崩溃或被 kill，需要恢复上下文继续工作
- 手动 `anet stop` 后想要接着之前的对话继续
- 网络断连导致 Agent 掉线，重连后恢复

```bash
# 恢复上次 session
anet node resume 指挥室

# 恢复指定 session
anet node resume 马 --session abc123
```

::: tip 和 anet node start 的区别
`anet start` 默认创建新 session。如果想恢复旧 session，用 `anet resume`。如果想强制创建新 session，用 `anet node start <name> --new-session`。
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

## 全局选项

所有命令都支持以下全局选项：

| 选项 | 说明 |
|------|------|
| `--hub <url>` | CommHub Server 地址 |
| `--token <token>` | 认证 Token |
| `--json` | JSON 格式输出 |
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

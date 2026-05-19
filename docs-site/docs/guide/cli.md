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
| `anet node rename <old> <new>` | 重命名 Agent —— ⚠ **节点必须至少 `anet node start` 启动过一次**（在 commhub server 端留下 sessions 行）。从未 start 过的 purely-created 节点 rename 会在 `prepareRename` 阶段 fail 报 `node not found in network`，[#110](https://github.com/sleep2agi/agent-network/issues/110)。Workaround：先 `anet node start <old>` 跑一次让 server 端注册，再 stop 后 rename。失败安全（PHASE 1 rollback，老节点完好）|
| `anet node migrate-token-to-envref <name>` | 把节点 `config.json` 里的明文 secret（按 key 后缀 `_TOKEN`/`_KEY`/`_SECRET`/`AUTH` 或值前缀 `sk-`/`utok_`/`ntok_`/`atok_`/`ak-`/`gsk_`/`key-`/`Bearer ` 识别）迁移到 envRef 形式 `{ _envRef: "<KEY>_<NODE_SUFFIX>" }`，secret 不再持久化在磁盘 —— 写 `config.json.bak-<ts>` 备份原文件、打印需要 `export` 的 env 变量列表。详见 [安全设计 — Vendor 凭据存储 envRef 模式](/concepts/security#vendor-凭据存储envref-模式v0-9-0) + [Token 体系 — envRef](/concepts/tokens) ([#125](https://github.com/sleep2agi/agent-network/issues/125)) |
| `anet node delete <name>` | 删除 Agent（默认交互式确认；加 `--force` 或 `--yes` 跳过；**不自动撤销 ntok_** — 要彻底清干净加 `anet token revoke <id>`，详见 [Token 生命周期](/concepts/tokens#token-生命周期对照)） |

### Session 绑定（`claude-code-cli` runtime）

只 `claude-code-cli` runtime 用得上 Claude Code session（`~/.claude/projects/<cwd>/*.jsonl`）；`claude-agent-sdk` / `codex-sdk` 没有 Claude Code session 语义。

| 命令 | 说明 |
|------|------|
| `anet node create <name> --resume <id>` | 创建节点并绑定**指定 session**（不存在则报错退出，[`cli.ts:1629-1634`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L1629)） |
| `anet node create <name> --resume-latest` | 创建节点并绑定**最新 session**（`listClaudeSessions()[0]`，[`cli.ts:1637-1644`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L1637)） |
| `anet node create <name>` | TTY 模式下交互式 picker（age / size / 前 60 字符首行预览，[`cli.ts:1645-1651`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L1645)）；非 TTY 则照常给随机 session id |
| `anet node start <name> --new-session` | 强制起**新** session（覆盖 profile.session） |
| `anet node resume <name> [--session <id>]` | 恢复 session（详见 [anet node resume](#anet-node-resume)） |
| `anet session ls` | 列当前 cwd 下 Claude Code session（picker 和 ls 共用 [`listClaudeSessions()` cli.ts:103](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L103)） |

> **零键盘恢复**：从 #115 起，`anet node start` spawn `claude` 时自动注入 `CLAUDE_CODE_RESUME_THRESHOLD_MINUTES=999999999`（[`cli.ts:1960`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L1960)），跳过 Claude Code 默认 70min session-age 阈值的「Resume from summary / full / Don't ask again」交互弹窗，**整批节点重启时不用一个个按键确认**。per-spawn 注入、不写 `~/.claude/settings.json`，用户显式 export 覆盖；resume 时还原**完整 session**（没有 per-invocation flag 强制 compact summary，#115 commit msg 解释 restart-recovery 不带意外 compaction 更安全）。

### 项目级（cwd-wide）

扫描当前 cwd 下 `.anet/nodes/` 里所有节点，统一起 / 重启 / 停。见 [issue #117](https://github.com/sleep2agi/agent-network/issues/117) + verify [`cli.ts:3000 projectCommand`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L3000)。

| 命令 | 说明 |
|------|------|
| `anet project up` | 起所有节点（已跑的 skip，幂等；▶ started / ⏭ already-running） |
| `anet project restart` | 杀掉现有 tmux + 重新启每个节点（↻ restarted / ▶ started）|
| `anet project down` | 停所有节点（杀 tmux + notify hub offline；⏹ stopped）|

**共享选项**：

| 选项 | 默认 | 说明 |
|------|------|------|
| `--stagger <秒>` | `3` | 节点之间错峰延迟，`0` 关闭 |
| `--only a,b,c` | — | 只对列出的 alias 或 node_id 操作 |
| `--exclude x,y` | — | 跳过列出的 alias 或 node_id |

> **`down` 给 hub-offline 通知设了 2s 超时上限**（cli.ts:3085-3088）—— 这条命令常用于「hub 自己挂了」的场景，22 个节点串行 fetch 卡 44 个超时会拖死命令；2s race 保证 worst-case 也能快速 teardown。

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
| `anet demo sci-team [opts]` | **科研军团**：1 leader + N-1 worker（默认 10，5-50 可调）主动 fan-out 协作 |

详见 [辩论赛 Demo 案例](/cases/debate)。其他 demo 用法跑 `anet demo <name> --help` 查看。

### Channel 管理

| 命令 | 说明 |
|------|------|
| `anet channel add <type>` | 添加 Channel（telegram/wechat/feishu） |
| `anet channel ls` | 列出 Channel |

### 其他

| 命令 | 说明 |
|------|------|
| `anet config` | **只读**查看 `~/.anet/config.json` 内容（`anet config path` 打印路径，`anet config json` 输出 raw JSON）。修改走 `anet login` / `anet init` / `anet network use`，不是 `anet config --set`。verify [`cli.ts:5670-5702 configShowCommand`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L5670) |
| `anet upgrade` | 打印升级计划（self-upgrade 默认关闭，避免升级中替换正在运行的 CLI 进程；给出手动步骤）。完整指南见 [升级指南](/guide/upgrade) |
| `anet create --batch` / `anet batch <verb>` | 批量起 N 个 agent（prefix 自动编号 + 独立 workdir/config/tmux），再用 `anet batch list/start/stop/restart/cleanup` 统一管 lifecycle。详见 [批量 Agent](/guide/batch) |
| `anet license` | v0.6 legacy 命令，查看 trial / license 状态。**Apache 2.0 OSS 后不再需要**；Hub 仍保留 `licenses` 表 + `send_task` 14 天 trial 检查做后向兼容 |
| `anet activate <key>` | v0.6 legacy，写入 pro license key。**Apache 2.0 OSS 后不再需要**；用于命中 `license_expired` 兜底，见 [troubleshooting](/troubleshooting) |
| `anet session ls` | 列出当前项目下的 Claude Code session（`claude-code-cli` runtime 用） |
| `anet import [alias]` | 从 CommHub 把 claude-code agent 的 session 导入为本地 `.anet/nodes/<alias>/config.json`（不传 alias 则导入全部） |
| `anet run` | 用 Client SDK 起一个**极简 standalone SSE agent**：连 hub、监听 task、自动 echo「收到」回复 —— **不跑 LLM**。需 `--alias`，可选 `--hub`。跟 `anet node start`（跑真实 AI runtime）不同，`anet run` 只是最小连通性 demo。verify [`cli.ts:2044 runCommand`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L2044) |

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
2. 创建 SQLite 数据库（`~/.commhub/commhub.db`，含 14 张表）
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

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L3608)

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
| `--runtime` | 不传则走交互式 **runtime-first wizard**（v0.9.2+ 起 [#133](https://github.com/sleep2agi/agent-network/issues/133) Vincent 改成 runtime-first：先 3-way 选 `claude-agent-sdk` / `claude-code-cli` / `codex-sdk`，**只有** `claude-agent-sdk` 才继续走 vendor picker；`claude-code-cli` print `claude auth login` hint 跳过 vendor，`codex-sdk` print `codex auth login` hint 跳过 vendor）| `claude-agent-sdk` / `codex-sdk` / `claude-code-cli` |
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

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L2209)

启动 Agent 节点。**默认前台运行**（stdio 接当前终端）；想后台跑或想用 tmux 管理，加 `--tmux` 开 tmux session 并 attach。

> v0.9.0 短暂引入过「默认 detached tmux」行为（[#122](https://github.com/sleep2agi/agent-network/issues/122)），v0.9.2 通过 [#136](https://github.com/sleep2agi/agent-network/issues/136) 回退 —— detached tmux 触发了 macOS bun `setRawMode errno 5`（detached child 的 stdio 不是 real PTY，claude-code-cli setRawMode 调用失败）。现在的 `--tmux` 走 **attached** 模式（`tmux new -As`），PTY chain 保持完整不再触发 bug。

```bash
anet node start <name> [options]
```

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--tmux` | false | 在新 tmux session 里跑并 attach 进入（session 名 = alias；`-A` 已存在则 attach）；按 `Ctrl-B D` detach |
| `--new-session` | false | 忽略旧 Claude session，创建新的（同 `--resume` chain 的「重新开始」） |

**默认（无 flag）**：

```bash
anet node start <name>
# 在当前终端跑，stdio inherit。Ctrl-C 退出。
# 想后台跑请自己 tmux 包：
#   tmux new -s <name>
#   anet node start <name>
# 或一行：
anet node start <name> --tmux
```

**`--tmux` 行为**：内部执行 `tmux new -As <alias> -c <cwd> "anet node start <alias>"`：
- `-A` —— alias 已有同名 session 直接 attach（rerun 友好）
- `-s` —— session 名 = alias（discoverability）
- `-c` —— start 在当前 cwd
- inner cmd 不带 `--tmux`，所以内层就是 foreground 跑，没有递归
- 终端是 tmux client，PTY chain 完整：claude-code-cli 的 setRawMode、`Ctrl-C`/raw input 都正常工作

**`--tmux` 失败回退**：如果 tmux 未装，命令拒绝 + 提示装 tmux 或回退默认前台。

**`anet node stop` 行为**：检测到同名 tmux session 时**先 `tmux kill-session`**再 SIGTERM 进程 + 通知 hub。这对 `--tmux` 创建的 session、以及 `anet project up` ([#117](https://github.com/sleep2agi/agent-network/issues/117)) 创建的 detached session 都适用，输出会告诉你 "tmux + process killed" 还是 "process killed"。

### anet status

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L2995)

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

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L3059)

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

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L5917)

系统诊断。

```bash
anet doctor              # 只诊断，输出每项 ✅ / ❌ + 修复提示
anet doctor --fix        # 自动修复：(a) migrateNode 把 V2 legacy 字段 (alias/resume/legacy_runtime_name) 改成 v0.8 schema (b) probe 过期 ntok_ 并跟 hub 重发新 token 写回 .anet/nodes/<name>/config.json
```

检查项（按 [`cli.ts:5917-6082 doctorCommand`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L5917) 实际顺序）：

1. 全局配置（`~/.anet/config.json` 有无 hub / token）
2. Auth token 是否存在
3. Hub 可达性（GET `/health` + 显示 sessions / SSE / license / multi-network 信息）
4. 本地节点配置 + 各节点运行状态 + legacy 字段诊断（[`diagnoseNode` cli.ts:5842](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L5842)：legacy_alias_field / legacy_resume_field / legacy_runtime_name / stale_dev_hub / missing_token / user_token / untyped_token / missing_node_id 共 8 种）
5. 依赖：`claude --version` / `codex --version` / `bun --version`
6. 当前项目 `.mcp.json` 的 commhub 配置
7. Telegram channel env（`~/.claude/channels/telegram/.env` 是否被静默清空，是 `/telegram:configure` 已知的 token 丢失 foot-gun）

::: tip `--fix` 是 v0.8 新增
v0.7 之前 ntok_ 失效需要手动 `anet node delete` + 重新 create；v0.8 起 `--fix` 直接探测+重发，agent-node SSE 401 也会自动 reload token 不离线（[RFC-001 Phase 2](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-001-deprecate-commhub-auth-token.md) 实施细节）。
:::

### anet upgrade

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L3522)

打印 / 执行升级计划 —— 4 包覆盖（`anet self` / `agent-node` / `commhub-server` / `agent-network-dashboard`）+ 双通道（preview / latest，auto-detect 或 `--channel` 覆盖）。从 [#88](https://github.com/sleep2agi/agent-network/issues/88) 起重写（v0.9.0+），老版只覆盖 2/3 包且把 preview 用户**静默降级**到 `@latest`。

```bash
anet upgrade [--channel preview|latest] [--self] [--dry-run]
```

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--channel preview|latest` | auto-detect | 强制选发布通道；auto-detect：当前 anet 版本含 prerelease tag → `preview`，否则 `latest` |
| `--self` | false | 触发 detached self-spawn 升级 anet 自己（`sh -c 'npm install -g ... && anet -v'`，stderr → `/tmp/anet-self-upgrade.err`）；不加这 flag 默认只 print 手动命令，避免升级时替换运行中的 CLI 进程 |
| `--dry-run` | false | 只 print plan + 不实际跑 |
| `--fork-script` | — | deprecated，保留向后兼容 |

**Plan 输出（per 包一行）**：

```
  anet (self)         2.2.0                →  2.2.6                → upgrade
                      (v0.10.6 #154 起 anet upgrade 默认自动 detached spawn — self < target 不需 --self flag；
                       chicken-and-egg 注：2.2.4 及以下用户需手装 1 次 `npm install -g @sleep2agi/agent-network@latest`
                       升到 2.2.5+，之后再升级都自动 detached spawn)
  agent-node          2.4.0                →  2.4.2                → upgrade
  commhub-server      not installed        →  0.8.2                (lazy via npx, skipped)
                      (not installed globally — lazy-fetched via npx by `anet hub start`)
  dashboard           0.5.0                →  0.5.3                → upgrade
```

| Badge | 含义 |
|------|------|
| `→ upgrade` | current < target，需要装新版 |
| `✓ up to date` | 已是 target，跳过 |
| `(lazy via npx, skipped)` | 全局没装 —— anet 会按需 `bunx/npx` 拉取，不用全局升 |
| `(self — see below)` | anet 自身默认不自升（要加 `--self`）|
| `⚠ npm registry lookup failed` | 包名拼错或网络问题 |

**`commhub-server` 行恒带说明**：`(anet hub start uses pinned <PINNED_SERVER_VERSION>)` —— `anet hub start` 不管全局装啥都跑 [`PINNED_SERVER_VERSION` cli.ts](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts) 的版本（避免 server breaking 风险）。全局 install 只给 `bunx @sleep2agi/commhub-server` 直接跑用。

**Node 版本检查**：低于 `engines.node`（22.13.0）只 warn 不 block（preview.9+ 真的会 fail，但用户显式知道自己在做啥时给路过去）。附带 `nvm install 22 && nvm use 22` 提示。

**升完提示跑** `anet project restart` ([#117](https://github.com/sleep2agi/agent-network/issues/117))，让 cwd 下已起的节点拿新 agent-node 版本。

完整升级指南见 [升级指南](/guide/upgrade)。

### anet project

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L3163)

cwd-wide 节点编排，[#117](https://github.com/sleep2agi/agent-network/issues/117) 引入（v0.9.0+，v0.10.0 起进 npm `latest`，verify [`agent-network/bin/cli.ts:7137` `case "project"`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L7137)）。

```bash
anet project <up|restart|down> [--stagger <seconds>] [--only a,b] [--exclude x,y]
```

| 子命令 | 行为 |
|--------|------|
| `anet project up` | 起 cwd `.anet/nodes/` 下所有节点；同名 tmux 已跑的 skip（▶ started / ⏭ already-running）|
| `anet project restart` | 杀掉每个节点现有 tmux session + 重新启（↻ restarted / ▶ started） |
| `anet project down` | 停所有节点 + notify hub offline（⏹ stopped）|

**`down` 的 2s offline-notify timeout**（[`cli.ts:3085-3088`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L3085)）：该命令常用于 hub 自挂场景，22 个节点串行 fetch 卡 44 个超时会拖死命令；`Promise.race + setTimeout(2000)` 保证 worst-case 也能快速 teardown。

**节点选择**：`--only` / `--exclude` 接 alias 或 node_id（逗号分隔），`splitCsv` 拆分。

**联动 #115**：每个内层 `anet node start` spawn 跑 [`startNodeTmuxSession`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L35)，env 自动注入 `CLAUDE_CODE_RESUME_THRESHOLD_MINUTES=999999999` 跳过 Claude Code resume prompt —— 22 节点 reboot 后 `anet project up` 是真正的**零键盘恢复**。

> ⚠ v0.9.2 起 `anet node start` 默认前台（[#136](https://github.com/sleep2agi/agent-network/issues/136)）。`anet project up` 仍走 detached tmux 起 N 个节点的内层 `anet node start <alias>`，在 macOS bun 下可能再触发 `setRawMode errno 5`（同 #136 根因）—— 受影响用户改用 `tmux new -s mybox` 然后顺序 `anet node start <alias> --tmux` 起每个节点。批量 detached 路径的修复跟进见 #136 follow-up。

### anet attach

> ⏳ **状态：[#121](https://github.com/sleep2agi/agent-network/issues/121) 待实施**（P2，预计 v0.9.x post-release 补）

设计目标：`anet attach <alias>` = 一行命令 attach 到 alias 对应的 detached tmux session，等价于 `tmux attach -t <alias>` 但带 alias→tmux session 名解析（处理 `node_id` 引用 / 别名规范化）。当前请直接用 `tmux a -t <alias>` 或 `anet node start <alias> --tmux`（v0.9.2 起的 `--tmux` flag 用 `tmux new -As`，已存在 session 直接 attach；见 [#136](https://github.com/sleep2agi/agent-network/issues/136)）。

### anet network invite

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L3432)

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

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L3555)

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

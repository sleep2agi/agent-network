# 故障排查

按“环境 → Hub → 认证 → 节点 → runtime → 任务”的顺序排查。前一层不通时，后面的报错通常只是连带现象。

完整命令见 [CLI 参考](/guide/cli)，部署问题见[生产部署](/deploy/production)，runtime 专属问题见 [Runtime 对比](/guide/runtimes)。

## 先收集最小诊断

在出问题的机器和项目目录运行：

```bash
anet doctor
anet hub status
anet whoami
anet status
anet node ls
anet info <alias>
anet logs <alias> --follow
```

`doctor` 会检查配置、Hub 连通性、节点身份和本机依赖。不要一上来运行 `doctor --fix`；先读清它准备修改的项目，再备份相关配置。

公开日志前删除 token、API key、密码、Cookie、完整环境变量和私有 Hub 地址。不要把 `~/.anet`、`.anet/nodes/*/config.json` 或 `.env` 整份上传。

## 安装和启动

### `spawn bunx ENOENT` / 找不到 Bun

Agent Network CLI 需要 Node.js ≥ 22.13，Hub 需要 Bun ≥ 1.2：

```bash
node --version
bun --version
npm install -g bun @sleep2agi/agent-network @sleep2agi/agent-node
```

若刚安装仍找不到命令，重新打开 shell 并检查 `PATH`。全局 npm 安装报 `EACCES` 时，优先用 nvm/fnm 管理 Node，不要用 `sudo npm` 或放宽系统目录权限。

### `agent-node is not installed` / 版本检查失败

```bash
agent-node --version
anet upgrade --dry-run
npm install -g @sleep2agi/agent-node
```

按当前发布频道升级，不要从旧文档复制固定 preview 或 package 版本。升级策略见[版本说明](/guide/versioning)和[升级指南](/guide/upgrade)。

### 端口被占用或 Hub 立即退出

```bash
anet hub status
curl http://127.0.0.1:9200/health
lsof -iTCP:9200 -sTCP:LISTEN
```

先确认占用端口的是不是已有 Hub。由 anet 启动的实例用 `anet hub stop` 停止；不要按进程名批量 kill。需要换端口时，Hub、CLI 和节点配置必须同时指向新地址。

## Hub 和网络连接

### `ECONNREFUSED`

本机先验证：

```bash
curl http://127.0.0.1:9200/health
anet hub status
```

远端节点再验证它实际配置的 Hub URL：

```bash
curl http://HUB_HOST:9200/health
```

本机通、远端不通，通常是 Hub 只监听 loopback、防火墙/安全组未放行，或 URL/端口写错。跨机器部署需让 Hub 监听可达地址，并用 TLS 反向代理保护公网入口。

### `ETIMEDOUT` / DNS / TLS 错误

从节点机器检查解析、路由、证书和代理，而不是只在 Hub 主机测试。若使用域名，确认它没有指向旧主机；若使用 HTTPS，确认反向代理能访问后端 `/health`。

### `SSE connection failed` / 反复重连

先确认普通健康请求和登录都正常，再看节点日志。SSE 需要长连接；Nginx/Caddy/负载均衡器不得缓冲响应，也不能使用过短的空闲超时。配置示例见[生产部署](/deploy/production)。

日志出现 `SSE connected` 才表示任务推送链路已建立。短暂断线会自动退避重连；持续失败时不要靠反复重启掩盖代理或身份错误。

## 登录、token 和 network

### `No hub configured`

```bash
anet init --hub http://HUB_HOST:9200
anet login
```

`~/.anet/config.json` 中保存当前 Hub、用户 token 和 network。不要手工拼接或从另一台机器复制 token。

### 401 `invalid token` / `auth required`

```bash
anet whoami
anet login
anet doctor
```

Hub 数据库重建、token 被撤销或登录切到另一台 Hub 后，旧 token 都会失效。重新登录后再检查节点；节点必须使用自己的 `ntok_`，不要把用户 `utok_` 填进节点配置。

若节点配置是旧格式或 token 已失效，先备份 `.anet/nodes/<alias>/config.json`，再根据 `anet doctor` 的输出决定是否运行：

```bash
anet doctor --fix
```

### 忘记密码

在 Hub 主机上运行：

```bash
anet hub admin reset-user --username <username>
```

它会生成新密码和用户 token，并撤销旧用户 token。不要直接删除 `users`、token 行或 bootstrap marker；这些做法会绕过审计并破坏关联状态。

### `network_id_required` / `access_denied` / `permission_denied`

- `network_id_required`：调用者没有唯一可推断的 network。登录/切换到正确 network，或在支持的调用中显式传 `network_id`。
- `access_denied` / `permission_denied`：身份已解析，但角色无权执行该操作。由 network owner 调整成员角色；全局 admin 不自动成为每个 network 的 owner。
- Agent Node 使用绑定到单一 network 的 `ntok_`；不要跨 network 复用节点 token。

完整权限边界见 [Token 与权限](/concepts/tokens)、[角色](/concepts/roles)和 [Network](/concepts/networks)。

### 其它认证/network 报错

<a id="quota-exceeded-max-n-networks-for-free-plan"></a>
<a id="license-expired-授权过期-legacy-行为"></a>

| 报错 | 安全处理 |
|---|---|
| `password must be at least 8 characters` / `too common` | 使用至少 8 位且不在弱密码表中的新密码 |
| 429 / `too many attempts` | 停止重试，等待响应指示的窗口后再试；先修正凭据，避免继续触发限流 |
| `network name already exists` | 查看当前 network，换一个名称；不要直接改数据库 |
| `network has N active session(s)` | 用 `anet status` 找出节点，正常停止后再删除 network |
| `quota exceeded` | 用 `anet network ls` 检查并删除不再使用的 network。目前没有公开 CLI 可修改用户 plan/全局角色；联系 Hub 运维，不要把用户直接改成全局 admin |
| `license_expired` | 运行 `anet license` 并升级后仍出现时，联系 Hub 运维。目前没有安全的公开 CLI 可清理 legacy 行；停止 Hub、备份数据库并提交脱敏诊断，不要在线删除 `licenses` 行 |

直接写数据库会绕过 API 的鉴权、审计和一致性检查，并可能损坏关联的许可或身份状态，所以这里不提供 SQL“修复”。

## Agent Node

### 节点一直 offline / 收不到任务

依次确认：

1. 节点机器能访问 Hub `/health`。
2. `anet whoami` 指向预期 Hub/network。
3. `anet info <alias>` 的 runtime、工作目录和身份正确。
4. `anet logs <alias> --follow` 最终出现 `SSE connected`。
5. 没有另一个进程使用同一 alias、`node_id` 或 `ntok_`。

安全重启单个节点：

```bash
anet node stop <alias>
anet node start <alias>
```

不要复制节点 `config.json` 到另一台机器。目标机器应重新登录并运行 `anet node create`，让 Hub 签发独立身份。

### 重复结果 / runtime 来回变化 / `alias_identity_mismatch`

这通常意味着同一身份被多个进程或旧配置使用：

```bash
anet info <alias>
anet logs <alias> --follow
tmux ls
```

停止旧实例，只保留一个进程。不要通过改 `node_id`、alias、token 或直接编辑 Hub 数据库“抢回”身份；改名用 `anet node rename`。

`Node "<alias>" already exists` 通常只是当前项目的 `.anet/nodes/` 已有同名配置。先用 `anet node ls` / `anet info <alias>` 确认是否应复用，不要为了重建而直接删目录。

### 工作目录不对

文件工具使用节点的启动目录。停止节点，切到正确项目目录再启动。Codex TUI 共存时，线程目录继承自 app-server 进程；请按 [Codex TUI 共存指南](/guide/codex-copresence)检查整组会话，不要只看桥进程。

<a id="vendor-api-auth-失败-401-invalid-api-key-expired-token-intern-a02xx-user-token-expired"></a>
<a id="vendor-api-超时-fan-out-高并发-132-retry-with-backoff"></a>
<a id="grok-build-acp-节点任务挂死-session-prompt-timed-out-after-300000ms-json-rpc-error-32603"></a>

## Runtime 和模型

先确认节点选中的 runtime 与已安装发布频道一致：

```bash
anet info <alias>
anet logs <alias> --follow
anet upgrade --dry-run
```

| 现象 | 检查 |
|---|---|
| Claude/Codex 命令找不到 | 对应 CLI 是否安装、在节点进程的 `PATH` 中、已完成登录 |
| Vendor 401/403 | API key、envRef 指向的变量、`ANTHROPIC_BASE_URL` 是否匹配同一服务 |
| Vendor 超时/限流 | 服务状态、账户配额、节点并发；不要靠无限重试消耗额度 |
| Grok ACP 长任务超时 | 按 runtime 指南核 `flags.grokAcpTimeoutMs` / `GROK_ACP_TIMEOUT_MS` |
| Codex 共存恢复后变成普通节点 | 必须继续用 `anet node start <alias> --copresence`，不要改用普通 start |

OpenCode 当前是任务 runtime，不是共享 TUI；Grok 共享 TUI 尚未发布。以 [Runtime 对比](/guide/runtimes)为准，不要照旧版本或 changelog 历史命令操作。

## 任务和消息

### 任务没有触发模型

需要执行的工作必须用 `send_task`。`send_reply` 是任务结果，`send_message` 是普通消息，两者都不会再次触发模型。

```bash
anet status
```

确认目标节点在线、任务属于当前 network，且目标 alias 正确。任务状态、重试和父子任务语义见[任务生命周期](/concepts/task-lifecycle)。

### `task not found` / `message not found`

常见原因是当前 token/network 与对象不一致，或者该对象不属于当前节点。先运行 `anet whoami` 和 `anet status`；不要通过直接查改 SQLite 绕过 network 隔离。

### 定时任务没有运行

```bash
anet goal list <alias>
anet info <alias>
```

循环任务要求节点在线，并会消耗真实模型额度。它不是高精度 cron；先用较长周期验证。
继续检查 `goal show` / `wake-log` 中的 `next_wake_at`、失败记录和 `paused` 状态。完整语义见 [Goal 与 Loop](/guide/goals-and-loops)。

## Channel

```bash
anet channel status <alias>
anet logs <alias> --follow
```

检查 bot token、pairing/allowlist、目标节点和 channel runtime 是否一致。Telegram 使用长轮询；反向代理 webhook 设置与它无关。当前支持范围和重启要求见 [Channel 指南](/guide/channels)。

## Docker

```bash
docker compose ps
docker compose logs --tail=200 <service>
```

检查 Hub 健康检查、持久卷、容器内 Hub URL、token 文件和模型凭据挂载。容器内的 `localhost` 指向容器自身，不是宿主机。

不要用 `docker system prune`、`docker image prune -a` 或宽泛名称匹配清理共享宿主机；先逐个确认容器和精确镜像引用。

## 仍未解决

提交 Issue 时附：

- `anet -v`、Node/Bun 版本和发布频道
- runtime、操作系统、部署方式
- 最小复现步骤和实际报错
- 已脱敏的 `anet doctor`、`anet info` 与相关日志片段

先搜索 [Issues](https://github.com/sleep2agi/agent-network/issues)；安全问题请使用 [GitHub Security Advisory](https://github.com/sleep2agi/agent-network/security/advisories/new)，不要公开漏洞或凭据。

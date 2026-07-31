# FAQ

这里回答最常见的问题。安装步骤见[上手指南](/guide/getting-started)，具体报错见[故障排查](/troubleshooting)。

## 基础

### Agent Network 是什么？

它是自部署的多 Agent 通信层：CommHub 负责身份、任务和消息，Agent 通过 MCP 发现队友，通过 SSE 接收任务。它不规定 Agent 内部怎样推理。

### 免费吗？需要服务器吗？

代码使用 Apache 2.0 许可证，可自行部署。个人使用可把 Hub 跑在本机；跨机器或团队使用时，把 Hub 部署在一台所有节点都能访问的机器上。项目不提供官方托管 Hub。

### 支持哪些 Agent 和模型？

不同 runtime 的鉴权和能力不同。请以 [Runtime 对比表](/guide/runtimes)和[多模型配置](/guide/multi-model)为准，不要根据旧文章里的 runtime 数量或模型版本选型。

稳定功能跟随 npm `latest`；实验功能是否可安装，以[版本说明](/guide/versioning)和当前发布包为准。

## 安装与配置

### 需要什么环境？

需要 Node.js ≥ 22.13 和 Bun。最短安装命令：

```bash
npm install -g bun @sleep2agi/agent-network @sleep2agi/agent-node
```

如果全局安装报 `EACCES`，优先用 nvm/fnm 安装 Node 22，而不是用 `sudo npm` 或修改系统目录权限。

### 配置和数据在哪里？

| 路径 | 内容 |
|---|---|
| `~/.anet/config.json` | 当前 Hub、用户 token、network |
| `<项目>/.anet/nodes/<alias>/config.json` | 节点 runtime、身份和 flags |
| `<项目>/.anet/nodes/<alias>/.env` | 可选的节点 secret，明文文件但权限应为 `0600` |
| `~/.commhub/commhub.db` | Hub 的 SQLite 数据库 |

不要提交 `.anet`、token 或 `.env`。envRef 的作用是避免把 secret 写进 `config.json`，不是承诺 secret 永不落盘。详见[安全设计](/concepts/security)。

### Hub 启不来或端口被占用怎么办？

先确认健康端点和占用者：

```bash
curl http://127.0.0.1:9200/health
lsof -i :9200
```

可改用 `anet hub start --port <port>`，或用 `anet hub stop` 停止由 anet 启动的 Hub。更多启动、密码和数据库问题见[故障排查](/troubleshooting)。

## 节点与任务

### 节点一直 offline 怎么查？

按顺序检查：

1. 从节点机器访问 Hub 的 `/health`。
2. 确认节点配置指向正确 Hub 和 network。
3. 查看 `anet logs <alias> --follow`，等待 `SSE connected`。
4. 若刚改过 runtime、token 或配置，停止旧进程后再启动，避免同一 alias 多实例竞争。

### 任务为什么没有触发 Agent？

需要模型处理的工作用 `send_task`。`send_reply` 是任务结果，`send_message` 是普通消息；它们不会再次触发模型，避免回复循环。详见[任务生命周期](/concepts/task-lifecycle)。

### 如何查看日志？

```bash
anet logs <alias>
anet logs <alias> --follow
```

Docker 部署用 `docker compose logs -f <service>`。不要把含 token、API key 或完整环境变量的日志贴到公开 Issue。

## 身份与网络

### `utok_`、`ntok_`、`atok_` 有什么区别？

- `utok_`：用户/CLI 身份，权限还取决于目标 network 的成员角色。
- `ntok_`：节点身份，限制在绑定的 network。
- `atok_`：兼容旧客户端的 legacy API token。

不要把 token 当作 alias，也不要跨节点复用 `ntok_`。完整边界见 [Token 与权限](/concepts/tokens)。

### 可以复制节点配置到另一台机器吗？

不要复制。应在目标机器登录、切换到目标 network，再运行 `anet node create`，让 Hub 颁发新的节点身份和 token。复制 `config.json` 会复制 `node_id` / `ntok_`，可能造成身份冲突。

### 忘记密码怎么办？

在 Hub 主机上由管理员运行：

```bash
anet hub admin reset-user --username <username>
```

不要直接删 SQLite 用户行；那会绕过审计和关联数据处理。密码规则与 token 撤销行为见[账号体系](/guide/account-system)。

## 部署

### 可以直接把 9200/3000 暴露到公网吗？

不建议。先改初始密码，再通过 Caddy/Nginx 配 TLS 和访问控制；不要把 Hub、Dashboard 或管理端点裸露在公网。按[生产部署指南](/deploy/production)逐项检查。

### PostgreSQL 支持吗？

当前维护和验证的默认后端是 SQLite。代码中的 PostgreSQL 兼容入口不代表生产支持；没有完成对应 E2E 前不要用于生产。

### SSE 经常断开怎么办？

检查网络、防火墙和反向代理超时。Nginx/Caddy 必须允许长连接，并关闭 SSE 响应缓冲。配置示例见[生产部署](/deploy/production)和[故障排查](/troubleshooting)。

## 还没解决？

- 运行 `anet doctor` 收集非敏感诊断。
- 搜索 [Issues](https://github.com/sleep2agi/agent-network/issues) 和 [Discussions](https://github.com/sleep2agi/agent-network/discussions)。
- 报告时附版本、runtime、最小复现和已脱敏日志；安全问题请用 [GitHub Security Advisory](https://github.com/sleep2agi/agent-network/security/advisories/new)。

# FAQ

常见问题解答。

## 基础问题

### 1. Agent Network 是什么？和 LangChain / CrewAI 有什么区别？

Agent Network 是一个 **多 Agent 通信基础设施**，而不是 Agent 框架。它不关心你的 Agent 怎么"想"，只负责让多个 Agent 能互相通信、派任务、追踪结果。

| 对比 | Agent Network | LangChain / CrewAI |
|------|-------------|-------------------|
| 定位 | 通信基础设施 | Agent 框架 |
| 协议 | MCP 标准协议 | 自定义 |
| 模型 | 任意模型混搭 | 通常单模型 |
| 部署 | 分布式（多机） | 通常单进程 |
| 管理 | CLI + Dashboard | 代码定义 |

### 2. 需要服务器吗？

**开发/个人使用**：`anet hub start` 在本地笔记本上启动，不需要额外服务器。

**团队使用**：建议在一台服务器上部署 CommHub Server，团队成员各自连接。最低配置 1 核 1G 内存即可。

### 3. 免费吗？

**完全免费、Apache-2.0 开源**。整个项目是 self-hosted，没有官方 SaaS 托管，也不会强制激活码。

- 仓库公开、源码可改
- 商业模式 = 卖课 + 卖服务咨询，**不卖 license**
- 任何 `anet license` / `anet activate` 子命令都是 v3 时期遗留的占位实验性命令，预留给"未来某天可能出现的付费插件"，**不影响主线功能**

::: warning experimental
v2.x 历史文档里出现过的 "14 天免费试用 / 激活授权" 流程已不再适用 —— v0.8 起 hub 不检查 license。`anet activate` 仍能跑，但只是写一个本地 license 文件，不会因此 unlock 任何功能。
:::

### 4. 支持哪些 AI 模型？

任何支持 Anthropic Messages API 的模型都可以通过 `claude-agent-sdk` runtime 接入。目前已验证：

- Claude Sonnet 4 / Opus 4（原生 SDK）
- Codex (codex-sdk)（Codex SDK）
- MiniMax M2.7（Anthropic 兼容 API）
- 书生 Intern-S1-Pro（Anthropic 兼容 API）
- DeepSeek（Anthropic 兼容 API）

### 5. 一个网络最多支持多少 Agent？

技术上没有硬限制。实测：

- **10 Agent**：完全流畅
- **50 Agent**：正常运行
- **100 Agent**：SSE 推送有轻微延迟（< 1s）

SQLite WAL 模式支持高并发读写，瓶颈通常在 AI 模型的响应速度。

## 安装和配置

### 6. 安装时报权限错误（EACCES）

```bash
# 方法一：使用 nvm 管理 Node.js（推荐）
nvm install 20
nvm use 20
npm install -g @sleep2agi/agent-network

# 方法二：修改 npm 全局目录
mkdir ~/.npm-global
npm config set prefix '~/.npm-global'
echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.bashrc
source ~/.bashrc
npm install -g @sleep2agi/agent-network
```

### 7. 找不到 bun 命令

```bash
# 安装 Bun
curl -fsSL https://bun.sh/install | bash

# 刷新 PATH
source ~/.bashrc
# 或
export PATH="$HOME/.bun/bin:$PATH"

# 验证
bun --version
```

### 8. anet hub start 报端口被占用

```bash
# 查看谁占了端口
lsof -i :9200
# 或
ss -tlnp | grep 9200

# 换个端��
anet hub start --port 9201

# 或停掉占用的进程
kill <PID>
```

### 9. 配置文件在哪里？

| 文件 | 路径 | 内容 |
|------|------|------|
| 全局配置 | `~/.anet/config.json` | hub 地址、token |
| 项目配置 | `{项目}/.anet/config.json` | alias、type |
| 节点配置 | `.anet/nodes/<id>/config.json` | runtime、model、tools |
| 数据库 | `~/.commhub/commhub.db` | SQLite 数据 |

## Agent 问题

### 10. Agent 启动后状态一直是 offline

可能的原因：

1. **网络不通**：检查 Agent 能否访问 CommHub Server

```bash
curl http://YOUR_IP:9200/health
```

2. **Token 错误**：检查 Token 是否有效

```bash
anet whoami
```

3. **防火墙**：确保 9200 端口开放

```bash
ufw allow 9200
```

4. **心跳超时**：如果 Agent 之前正常运行后崩溃，需要等 10 分钟超时或手动重启

### 11. Agent 处理任务后结果没有返回

检查 Agent 的消息类型处理逻辑：

- `task` 类型 -> AI 处理后回复（正确）
- `message` 类型 -> 不处理（正确，避免循环）

如果是 Claude Code 模式，检查 CLAUDE.md 中是否有正确的回复规则。

### 12. 两个 Agent 互相发消息导致无限循环

这是消息类型设计的问题。确保：

- 发任务用 `send_task`（type=task）-> 触发 AI 处理
- 回复结果用 `send_reply`（type=reply）-> 不触发 AI 处理
- 日常聊天用 `send_message`（type=message）-> 不触发 AI 处理

如果仍然循环，检查 agent-node 是否只响应 `new_task` 和 `broadcast` 事件。

### 13. MiniMax Agent 报 API 错误

```bash
# 检查 API Key 是否正确
curl -H "Authorization: Bearer $MINIMAX_API_KEY" \
  https://api.minimaxi.com/anthropic/v1/messages \
  -d '{"model":"MiniMax-M2.7","max_tokens":100,"messages":[{"role":"user","content":"hi"}]}'
```

注意：

- `ANTHROPIC_BASE_URL` 必须是 `https://api.minimaxi.com/anthropic`（注意 `/anthropic` 后缀）
- 使用 `ANTHROPIC_AUTH_TOKEN` 或 `ANTHROPIC_API_KEY` 传递 Key

### 14. 如何查看 Agent 的详细日志？

```bash
# anet 启动的 Agent
anet logs 代码1号

# npx 启动的 Agent：直接看终端输出

# Docker 中的 Agent
docker compose logs -f worker-1

# CommHub Server 日志
docker compose logs -f server
```

## 网络和权限

### 15. utok_ 和 ntok_ 的区别？什么时候用哪个？

| Token | 用途 | 能做什么 | 不能做什么 |
|-------|------|---------|-----------|
| `utok_` | CLI / Dashboard 登录 | REST 读取、管理 | MCP 写操作 |
| `ntok_` | Agent 连接 | 网络内所有操作 | 跨网络 |

**简记**：人用 utok_，Agent 用 ntok_。

### 16. 怎么把 Agent 加入另一个网络？

```bash
# 方法一：邀请码
anet network use other-network
anet network invite --role member
# 把邀请码给对方
# 对方执行：anet network join inv_xxx

# 方法二：在目标网络创建节点配置，复制给 Agent 运行机器
anet network use other-network
anet node create other-agent
# 把 .anet/nodes/other-agent/config.json 给 Agent 使用
```

### 17. 怎么查看/管理网络成员？

```bash
# 查看成员
curl http://localhost:9200/api/networks/net_xxx/members \
  -H "Authorization: Bearer utok_xxx"

# 在 Dashboard 的 Settings 页面管理
```

## 部署问题

### 18. Docker Compose 中 Worker 连不上 Server

确保：

1. Server 健康检查通过后再启动 Worker

```yaml
depends_on:
  server:
    condition: service_healthy
```

2. 使用 Docker 内部网络名（`server:9200` 而非 `localhost:9200`）

3. Seed 容器成功导出了 ntok_

```bash
docker compose logs seed
```

### 19. Dashboard 部署到 Vercel 失败

必须使用 prebuilt 方式部署：

```bash
cd agent-network-dashboard
npm run build
vercel deploy --prebuilt --prod
```

不要在 Vercel 上 build，因为可能缺少环境变量。

### 20. PostgreSQL 支持如何？

::: warning v2.1 暂不推荐 PostgreSQL
代码里有 `DATABASE_URL=postgres://...` 的入口，但 v2.1 stable 上没有做过 PostgreSQL 的 E2E 验证，**不建议生产使用**。

当前请用默认的 **SQLite**（在 `~/.commhub/commhub.db`）。SQLite 已经能跑到 100+ Agent 规模，单机部署足够。

如果你确实有 HA / 多写副本场景需要 Postgres，到 [GitHub Discussions](https://github.com/sleep2agi/agent-network/discussions) 反馈，我们会按需求优先级排到后续版本。
:::

## 性能问题

### 21. 任务响应慢

检查：

1. **AI 模型延迟**：不同模型响应时间不同
   - Codex (codex-sdk)：3-15 秒
   - Claude：5-30 秒
   - MiniMax：1-5 秒
2. **网络延迟**：Agent 和 Server 之间的网络延迟
3. **Server 负载**：`anet doctor` 检查服务器状态
4. **数据库大小**：大量历史数据可能影响查询速度

### 22. SSE 连接经常断开

可能原因：

- 网络不稳定
- 反向代理超时设置太短
- 防火墙关闭了长连接

Nginx 配置建议：

```nginx
location /events/ {
    proxy_pass http://127.0.0.1:9200;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_read_timeout 86400;   # 24 小时
    proxy_buffering off;
    proxy_cache off;
}
```

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

**Apache-2.0 开源、self-hosted。** 代码和仓库许可证不要求购买 license，没有官方 SaaS 托管；但当前 v0.10.10 stable 代码里仍保留 legacy trial/pro-license 表和 `send_task` 过期检查。

- 仓库公开、源码可改
- 商业模式 = 卖课 + 卖服务咨询，不依赖强制官方 SaaS
- `anet license` / `anet activate` 是 v0.6 legacy 命令，**OSS 后不再需要**；若命中 `license_expired`（Hub 后向兼容仍创建 14 天 trial），按 [troubleshooting — license_expired](/troubleshooting#license-expired-授权过期-legacy-行为) 直接清掉 `licenses` 表即可

::: info v0.6 license 路径计划清理
当前 server 在 `send_task` 仍跑 `licenses.expires_at` 检查（V3 遗留代码，verify [`server/src/tools.ts` `license_expired` 仍在](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts)）—— **v0.9.x / v0.10.0-10 scope 都未动**（v0.9.x Recovery & Observability、v0.10.0 Direct Runtime + Observability Foundations、v0.10.1 PINNED chain-bump hotfix、v0.10.2 Hero A disk + Hero D 拓扑前缀、v0.10.3 codex preset、v0.10.4 dashboard orphan-band + `anet upgrade` UX、v0.10.5 batch wizard workdir + codex/claude skip API key、v0.10.6 `anet upgrade` Option B detached + wizard silent-exit、v0.10.7 codex-sdk batch yolo parity、v0.10.8 Servers UI 文案修、v0.10.9 codex-sdk 图片输入 + commhub 附件 `meta_json`、v0.10.10 小米 MiMo 5-model preset + envRef wizard-to-start 自动衔接 —— 主题都不在 license 路径），排到 v0.11+ 整段移除。
:::

### 4. 支持哪些 AI 模型？

任何支持 Anthropic Messages API 的模型都可以通过 `claude-agent-sdk` runtime 接入。`anet node create` 的 `VENDORS` 列表里**内置**的 provider（每项都是 verified-with-real-call 才进列表，详见 [runtimes 已验证 vs 未验证](/guide/runtimes#已验证-vs-未验证)）：

- **Anthropic** 原生 SDK（Claude Sonnet / Opus / Haiku；查 [Anthropic Models](https://docs.anthropic.com/claude/docs/models-overview)）
- **MiniMax**（Anthropic 兼容；查 [MiniMax 平台](https://platform.minimaxi.com)）
- **书生 InternLM**（Anthropic 兼容；查 [书生](https://chat.intern-ai.org.cn)）
- **小米 MiMo**（Anthropic 兼容；查 [小米开放平台](https://platform.xiaomimimo.com)）
- **OpenAI Codex**（`codex-sdk` runtime；查 OpenAI Codex 文档）
- **xAI Grok**（`grok-build-acp` runtime, ACP 协议；目前只通过 `--runtime grok-build-acp` flag 启用，[详细 runtime 指南 ↗](https://github.com/sleep2agi/agent-network/blob/main/docs/grok-build-runtime.md)）

未进 `VENDORS` 列表的 provider（DeepSeek / 智谱 GLM / Moonshot Kimi / OpenRouter 等）—— 用「自定义 `custom`」供应商接入：任何 Anthropic 兼容 API 都能填 base URL + model id，能用但请自己先跑通验证。

完整 endpoint 表 + 配置示例见 [多模型配置](/guide/multi-model)。任何支持 Anthropic Messages API 的服务商都可以通过 `ANTHROPIC_BASE_URL` 接入。

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

# 换个端口
anet hub start --port 9201

# 或停掉占用的进程
kill <PID>
```

### 9. 配置文件在哪里？

| 文件 | 路径 | 内容 |
|------|------|------|
| 全局配置 | `~/.anet/config.json` | hub 地址、`utok_`、当前激活 network |
| 节点配置 | `{cwd}/.anet/nodes/<alias>/config.json` | runtime、model、tools、`ntok_`、env、flags（目录名是 alias，不是内部 `node_id`） |
| 节点 env 文件（v0.10.10+）| `{cwd}/.anet/nodes/<alias>/.env` | envRef Option A 自动 source 的 API key（mode 0600；`anet node create` 写入，`anet node start` 启动前自动 source；[详见 envRef wizard 自动衔接](/guide/cli#anet-node-create)）|
| 数据库 | `~/.commhub/commhub.db` | hub 端 SQLite（WAL 模式） |

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

- `task` / `broadcast` 类型 -> AI 处理后回复（正确）
- `reply` / `message` / `ack` 类型 -> 不处理（正确，避免 think 循环；详见 [Task 生命周期 — 消息类型](/concepts/task-lifecycle#消息类型)）

如果是 `claude-code-cli` runtime，检查项目根目录 `CLAUDE.md` 中是否有正确的回复规则（CLAUDE.md 是 Claude Code 自动加载的指令文件）。

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
  -d '{"model":"<minimax-model-id>","max_tokens":100,"messages":[{"role":"user","content":"hi"}]}'
# 把 <minimax-model-id> 替换为你 MiniMax 账号当前可用的 model id（查 https://platform.minimaxi.com 控制台）
```

注意：

- `ANTHROPIC_BASE_URL` 必须是 `https://api.minimaxi.com/anthropic`（注意 `/anthropic` 后缀）
- MiniMax 用 `ANTHROPIC_AUTH_TOKEN` 传 Key（**不是** `ANTHROPIC_API_KEY`——后者仅用于 api.anthropic.com 直连。两者职责区分详见 [runtimes — claude-agent-sdk 常见坑](/guide/runtimes#claude-agent-sdk)）

### 14. 如何查看 Agent 的详细日志？

```bash
# anet 启动的 Agent
anet logs 代码1号                # 最近一段
anet logs 代码1号 --follow       # 实时 tail（类似 tail -f）

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
| `utok_` | CLI / Dashboard 登录 | 跨网络读取；在所属 network 内 role ≥ member 时可 MCP 写（owner / admin / member 可写，viewer 只读，详见 [tokens 权限决策](/concepts/tokens#权限决策-hub-端怎么判断你能不能调)） | viewer 在该网络写、跨网络写非成员的 network |
| `ntok_` | Agent 连接 | 锁定的单网络内所有 member+ 权限操作（hub 强制锁 network_id） | 跨网络 |

**简记**：人用 utok_，Agent 用 ntok_。

### 16. 怎么把 Agent 加入另一个网络？

```bash
# 方法一：邀请码加入（推荐）
anet network use other-network
anet network invite --role member
# 把邀请码给对方
# 对方在自己机器上执行：anet network join inv_xxx

# 方法二：在目标机器本地注册 node（跨机部署，**不要 copy config.json**）
# 在目标机器上：
anet login --hub http://<hub-host>:9200 --username admin --password ...
anet network use other-network
anet node create other-agent                   # CLI 跟 hub 注册 + 拿独立 ntok_
anet node start other-agent
```

::: warning 不要跨机 copy `.anet/nodes/<name>/config.json`
config 里的 `node_id` 是 hub 注册时分配的唯一 ID, 复制到另一台机器会让两台机器同时报告同一个 node, SSE 路由会乱. 详见 [networks — 跨机器部署](/concepts/networks#跨机器部署).
:::

### 17. 怎么查看/管理网络成员？

```bash
# 查看当前 network 成员（CLI）
anet network members

# 查看成员（REST 直查）
curl http://localhost:9200/api/networks/net_xxx/members \
  -H "Authorization: Bearer utok_xxx"

# 邀请新成员（owner/admin）
anet network invite --role member        # 生成邀请码（admin/member/viewer）
```

::: tip 角色变更入口
当前 v0.10.10 stable 仍不提供 CLI `promote` / `demote` 子命令（v0.9.x scope 是 Recovery & Observability，v0.10.0 是 Direct Runtime + Observability Foundations，v0.10.1 是 PINNED chain-bump hotfix，v0.10.2-10 是 Hero A disk + Hero D 拓扑前缀 / v0.10.3 codex preset / v0.10.4 dashboard orphan-band + `anet upgrade` UX 警告 / v0.10.5 batch wizard workdir + codex/claude skip API key / v0.10.6 `anet upgrade` Option B detached + wizard silent-exit / v0.10.7 codex-sdk batch yolo parity / v0.10.8 Servers UI 文案修 / v0.10.9 codex-sdk 图片输入 + commhub 附件 `meta_json` / v0.10.10 小米 MiMo 5-model preset + envRef wizard-to-start 自动衔接 —— 都未动 member role 管理）；改角色目前要通过 [REST API `/api/networks/:id/members/:user_id`](/api/rest) 调用或 Dashboard Admin 页（部分实装，[详见 Dashboard Admin](/guide/dashboard#admin-管理面板)）。完整 CLI 入口排到 v0.11+ / 未排期。
:::

### 17a. 怎么改密码？（v0.8）

```bash
anet passwd                       # 交互式：输旧密码 → 输新密码 ≥ 8 字符 + 非弱密码字典
```

要求：≥ 8 字符 + 不在 [`password-dict.ts WEAK_PASSWORDS`](https://github.com/sleep2agi/agent-network/blob/main/server/src/password-dict.ts) 字典里。**`anet passwd` / `anet hub admin reset-user` 无任何长度豁免** —— 只有首次注册 admin（register 路径）才允许 ≥ 4，让 quick-start `admin / anethub` 默认成立（verify [`auth.ts:43-44`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L43)）。

### 17b. 忘密码怎么办？（v0.8）

**方案 A（推荐）**：在 Hub 所在机器跑 admin reset：

```bash
anet hub admin reset-user <username>   # 强制重置某用户密码，无需老密码
# → 生成随机新密码 + 撤销该用户全部 utok_ + 颁发新 utok_ + 写 audit_log password_reset_by_admin
```

**方案 B（兜底，连 Hub 机器都不能登的极端情况）**：直接改 SQLite + 删 admin marker：

```bash
# 1. 删用户记录
sqlite3 ~/.commhub/commhub.db "DELETE FROM users WHERE username='admin'"

# 2. 关键：删 admin-utok.json marker（否则 anet hub start 会跳过 register 不重建）
rm -f ~/.anet/server/admin-utok.json

# 3. 重启 hub 触发 non-interactive bootstrap（输出 '✅ Admin account created'）
anet hub start
```

::: warning 必须删 marker
`anet hub start` bootstrap 是 **non-interactive 幂等**的，幂等性靠 `~/.anet/server/admin-utok.json` marker 文件。**只 `DELETE FROM users` 不删 marker → hub start 看到 marker 还在直接跳过 register flow → admin 不会重建**（输出 `✅ Admin already exists`，但 db 里其实没 admin row）。详见 [troubleshooting → 第二次 anet hub start 还重新 bootstrap admin？](/troubleshooting)
:::

⚠️ 方案 B 是兜底，会清掉用户记录 + audit_log 不记 reset 事件。生产建议方案 A。详见 [安全设计](/concepts/security)。

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

必须使用 prebuilt 方式部署 —— 两步，顺序不能错：

```bash
cd agent-network-dashboard
vercel build --prod                  # 本地 build，产物写入 .vercel/output
vercel deploy --prebuilt --prod      # 上传 .vercel/output
```

注意 **第一步必须是 `vercel build`，不是 `npm run build`** —— `vercel deploy --prebuilt` 只上传 `.vercel/output` 目录，而这个目录由 `vercel build` 生成；只跑 `npm run build` 的话 `.vercel/output` 是空的或上一次的旧产物。不在 Vercel 云端 build 既省构建费，也避免环境变量缺失。

### 20. PostgreSQL 支持如何？

::: warning 当前 stable 暂不推荐 PostgreSQL
代码里有 `DATABASE_URL=postgres://...` 的入口，但当前 stable 上没有做过 PostgreSQL 的 E2E 验证，**不建议生产使用**。

当前请用默认的 **SQLite**（在 `~/.commhub/commhub.db`）。SQLite 已经能跑到 100+ Agent 规模，单机部署足够。

注：**v0.8+ 产品方向已转 SQLite only**（见 [docs/v3-postgresql-design.md banner](https://github.com/sleep2agi/agent-network/blob/main/docs/v3-postgresql-design.md)），不在 maintained roadmap 上。adapter 接口保留作社区扩展点 —— HA / 多写副本场景需要 Postgres 的话，欢迎到 [GitHub Discussions](https://github.com/sleep2agi/agent-network/discussions) 讨论自部署方案。
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
- nginx `proxy_buffering` 默认 on（SSE 必须 off，否则事件被缓冲到 buffer 满才一次性送达）

> **断了 agent 会自己重连**：v0.10.10 stable 指数退避 `3s → 60s`；v0.10.11 preview ([#202](https://github.com/sleep2agi/agent-network/issues/202)) 改 `1s → 30s` 上限 + 重连即重 register + 1h zombie-retry guard。如果 hub 重启了 dashboard 看不到节点，参考 [troubleshooting — Hub 重启后 Dashboard 看不到节点](/troubleshooting#hub-重启后-dashboard-看不到节点)。

Nginx 配置建议：

```nginx
location /events/ {
    proxy_pass http://127.0.0.1:9200;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;  # rate limit 看真实 client IP
    proxy_read_timeout 86400;   # 24 小时
    proxy_buffering off;
    proxy_cache off;
}

# /api/* + /mcp 也建议透传 X-Forwarded-For 以便 audit_log 记录真实 IP
location / {
    proxy_pass http://127.0.0.1:9200;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Host $host;
}
```

::: tip rate limit IP 检测
hub 端 register / login 端点取 `req.headers["x-forwarded-for"]?.split(",")[0]` 作为 `clientIP` 喂给 `checkRateLimit`（[`server/src/index.ts:428`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L428) register / L443 login）。如果反代不设 `X-Forwarded-For`，所有请求会被认成同一个 IP（反代自身），rate limit 会误伤所有用户。
:::

## 下一步

**起步教程**：
- [一键安装与起步](/guide/one-shot-install) — 装好 anet 后第一个 agent
- [Hello World](/cases/hello-world) — 6 步建第一个 agent 集群
- [上手指南](/guide/getting-started) — 完整安装到第一次跑

**深入概念**：
- [安全设计](/concepts/security) — token / 密码 / 隔离
- [账号体系](/guide/account-system) — utok_ / ntok_ / 密码 关系
- [架构概览](/guide/architecture) — 整体系统设计

**升级和故障排查**：
- [v0.7 → v0.8 升级指南](/guide/upgrade#v0-7-v0-8-升级注意-最新) — admin bootstrap / 密码管理
- [故障排查](/troubleshooting) — 常见错误集合
- `anet doctor --fix` — 自动 probe + 重发 ntok_

**社区**：
- [GitHub Issues](https://github.com/sleep2agi/agent-network/issues) — 报 bug / 功能建议
- [社区](/community) — 加入讨论

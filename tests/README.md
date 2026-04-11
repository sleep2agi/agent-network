# Agent Network 测试

## 测试架构

`tests/` 目录当前实际有 19 套独立 Docker 测试套件，可并行运行：

| 套件 | 目录 | 最新结果 | 覆盖范围 |
|------|------|---------|---------|
| Test 1 | `test1-newuser/` | 23 passed, 0 failed | 新手体验：注册→登录→默认网络→node token→首个任务 |
| Test 2 | `test2-collab/` | 20 passed, 0 failed | 多用户协作：邀请→加入→隔离→移除 |
| Test 3 | `test3-security/` | 20 passed, 0 failed | 安全边界：注入→bypass→fuzz→token |
| Test 4 | `test4-base/` | 136 passed, 0 failed | 基础 E2E：CLI+MCP+REST+生命周期 |
| Test 5 | `test5-auth/` | 25 passed, 0 failed | 认证：注册/登录/token/密码/rate limit |
| Test 6 | `test6-networks/` | 22 passed, 0 failed | 网络：CRUD/隔离/rename/delete |
| Test 7 | `test7-config/` | 16 passed, 0 failed | 配置优先级：CLI > env > project > global |
| Test 8 | `test8-runtime/` | 8 passed, 0 failed | Layer 0 + Layer 2：runtime 启动、SSE、状态上报 |
| Test 9 | `test9-permissions/` | 19 passed, 0 failed | 权限：owner/admin/member/viewer + quota |
| Test 10 | `test10-token-ratelimit/` | 15 passed, 0 failed | token 边界：utok_/ntok_/revoke/expire/rate limit |
| Test 11 | `test11-lifecycle/` | 9 passed, 0 failed | 生命周期：delivered→acked→running→replied |
| Test 12 | `test12-claude-channel/` | 17 passed, 0 failed | Claude Code channel 接入：注册→收件→回复→SSE |
| Test 13 | `test13-multi-channel/` | 17 passed, 0 failed | 多 channel：多 agent / 多入口并存 |
| Test 14 | `test14-agent-node/` | 16 passed, 0 failed | `agent-node` CLI/runtime 基础行为 |
| Test 15 | `test15-telegram-mock/` | 14 passed, 0 failed | Telegram mock channel 行为 |
| Test 16 | `test16-channel-plugin/` | 11 passed, 0 failed | `channel/commhub-channel.ts` 插件自举、在线/离线、收件 |
| npm API | `test-npm-api/` | 19 passed, 0 failed | npm 包 API/ntok_/utok_ 边界 |
| npm Install | `test-npm-install/` | 9 passed, 1 failed | npm 安装新手流程（当前剩版本输出格式差异） |
| npm Security | `test-npm-security/` | 18 passed, 0 failed | npm 包安全回归 |

另外：
- `local-e2e.sh` — 本地快速测试（不需要 Docker）

## 快速运行

```bash
# 并行运行一批测试（按脚本当前支持的套件）
bash tests/run-parallel.sh

# 单独运行某个套件
sg docker -c 'docker build -t anet-test12 -f tests/test12-claude-channel/Dockerfile . && docker run --rm anet-test12'

# 本地快速测试（不需要 Docker）
bash tests/local-e2e.sh
```

## 每个测试套件结构

```text
tests/testN-xxx/
├── Dockerfile    # 独立 Docker 镜像
└── run.sh        # 测试脚本
```

## 创建新测试套件

1. 创建目录：`mkdir tests/test17-xxx`
2. 写 Dockerfile：

```dockerfile
FROM oven/bun:1
WORKDIR /app
RUN apt-get update && apt-get install -y curl python3 && rm -rf /var/lib/apt/lists/*
COPY server/ server/
RUN cd server && bun install
COPY tests/test17-xxx/run.sh /app/run.sh
RUN chmod +x /app/run.sh
ENV COMMHUB_AUTH_TOKEN=test-auth-token
CMD ["bash", "/app/run.sh"]
```

3. 写 `run.sh`（使用 `pass/fail` 函数）：

```bash
#!/bin/bash
PASS=0; FAIL=0
pass() { echo "  ✅ $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

cd /app/server && COMMHUB_AUTH_TOKEN="${COMMHUB_AUTH_TOKEN:-test-auth-token}" bun run src/index.ts &
sleep 3

curl -s http://127.0.0.1:9200/health | grep -q '"ok":true' && pass "health" || fail "health"

echo "Result: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ] && exit 0 || exit 1
```

4. 加到需要的并行运行脚本
5. 测试：

```bash
sg docker -c 'docker build -t anet-test17 -f tests/test17-xxx/Dockerfile . && docker run --rm anet-test17'
```

## 经验总结

### Docker 相关

- 权限：用 `sg docker -c '...'` 执行 docker 命令
- Bun 镜像：统一用 `oven/bun:1`
- `node-pty`：如果测试会构建 CLI/runtime，通常需要 `make g++`
- 端口：每个容器内部用 `9200`，互不冲突
- 数据库：每个容器自动创建临时 SQLite，测试结束自动清理

### Server 相关

- 必须设 `COMMHUB_AUTH_TOKEN`：不设则 auth 禁用，安全测试会 false positive
- V3 认证：`register/login` 先过 global auth，再签发用户 token
- Login 旋转 token：`login` 后旧 token 可能失效，测试里必须更新认证头
- 首个用户自动 admin：第一个 register 的用户 role=`admin`

### MCP 相关

- Streamable HTTP 不会主动断开：`curl` 需要 `timeout`
- `Accept` header 必须带：`application/json, text/event-stream`
- 响应通常包在 SSE `data:` 行里，不是纯 JSON
- 后台并发 `mcp_call` 容易因连接未断开挂住，优先用 `timeout`

### Token 相关

- 双 token 体系：`utok_`（用户级）+ `ntok_`（网络级）
- 旧 `atok_` 兼容：`resolveToken` 仍识别
- `utok_` 不允许走 MCP；MCP 应使用 `ntok_`
- `ntok_` 必须绑定网络，不能跨网络写

### 网络隔离

- REST 读接口要按 token 绑定的 `network_id` 过滤
- 跨用户访问网络详情应返回 403
- admin 是例外路径，跨网络 case 要用非 admin 用户测

### 测试报告

测试输出保存到 `docs/tests/report-*.txt`，优先保留最新一次有效结果。

## 测试分层原则（从简单到复杂）

测试必须分层，前一层不过就不跑后面的。先验证被依赖的原子能力，再组合复杂场景。

```text
Layer 0: 环境就绪
  ├── server 能启动 (health check)
  ├── runtime 能启动（codex-sdk / claude-code-cli / http-api）
  ├── channel/plugin 进程能自举
  └── SSE / MCP 基础连通

Layer 1: 认证基础
  ├── 注册 → 拿到 utok_
  ├── 登录 → token 有效
  ├── auth/me → 用户信息正确
  └── node token / network token 创建成功

Layer 2: 单点通信
  ├── agent 注册到 hub
  ├── 发任务 (send_task)
  ├── 收任务 (get_inbox / channel ingress)
  └── 回复任务 (send_reply)

Layer 3: 完整生命周期
  ├── 任务状态机 (delivered → acked → running → replied)
  ├── 重试 / 取消 / 转移
  ├── 状态上报 + SSE 推送
  └── Token CRUD / revoke / expire

Layer 4: 多用户协作
  ├── 两个用户各自的网络
  ├── 邀请码 + 加入
  ├── 成员角色 + 权限
  └── 网络隔离验证

Layer 5: 安全和边界
  ├── SQL 注入 / XSS
  ├── 跨用户越权
  ├── 超长 / 空值 / 畸形输入
  ├── token 撤销后失效
  └── 并发 + 压力
```

核心理念：
可靠性 = 每一层都验证过。被依赖的能力必须先测通，才能认为上层系统可靠。

## 分工

| 角色 | 职责 |
|------|------|
| 通信龙 | 写代码、设计、分配任务、汇总结果 |
| 测试1-3号 | 跑 Docker 测试、改造测试套件 |
| 通信牛 | Review 源码 + 测试覆盖 |
| N站马 | Dashboard 开发 |

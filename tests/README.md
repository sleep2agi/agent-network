# Agent Network 测试

## 测试架构

7 个独立 Docker 测试套件，可并行运行：

| 套件 | 目录 | 测试数 | 覆盖范围 |
|------|------|--------|---------|
| Test 1 | test1-newuser/ | 23 | 新手体验：注册→登录→创建agent→发任务 |
| Test 2 | test2-collab/ | 20 | 多用户协作：邀请→加入→隔离→移除 |
| Test 3 | test3-security/ | 20 | 安全边界：注入→bypass→fuzz→token |
| Test 4 | test4-base/ | 137 | 基础 E2E：CLI+MCP+REST+生命周期 |
| Test 5 | test5-auth/ | 25 | 认证：注册/登录/token/密码/rate limit |
| Test 6 | test6-networks/ | 22 | 网络：CRUD/隔离/rename/delete |
| Test 7 | test7-config/ | 16 | 配置优先级：CLI>env>project>global |

另外：
- `local-e2e.sh` — 56 个本地快速测试（不需要 Docker）

## 快速运行

```bash
# 并行运行全部 7 个套件
bash tests/run-parallel.sh

# 单独运行某个套件
sg docker -c 'docker build -t anet-test1 -f tests/test1-newuser/Dockerfile . && docker run --rm anet-test1'

# 本地快速测试（不需要 Docker，30 秒）
bash tests/local-e2e.sh
```

## 每个测试套件结构

```
tests/testN-xxx/
├── Dockerfile    # 独立 Docker 镜像
└── run.sh        # 测试脚本
```

## 创建新测试套件

1. 创建目录：`mkdir tests/test8-xxx`
2. 写 Dockerfile：

```dockerfile
FROM oven/bun:1
WORKDIR /app
RUN apt-get update && apt-get install -y curl python3 && rm -rf /var/lib/apt/lists/*
COPY server/ server/
RUN cd server && bun install
COPY tests/test8-xxx/run.sh /app/run.sh
RUN chmod +x /app/run.sh
ENV COMMHUB_AUTH_TOKEN=test-auth-token
CMD ["bash", "/app/run.sh"]
```

3. 写 run.sh（使用 pass/fail 函数）：

```bash
#!/bin/bash
PASS=0; FAIL=0
pass() { echo "  ✅ $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

# Start server
cd /app/server && COMMHUB_AUTH_TOKEN="${COMMHUB_AUTH_TOKEN:-test-auth-token}" bun run src/index.ts &
sleep 3

# Your tests here...
curl -s http://127.0.0.1:9200/health | grep -q '"ok":true' && pass "health" || fail "health"

# Summary
echo "Result: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ] && exit 0 || exit 1
```

4. 加到 run-parallel.sh
5. 测试：`sg docker -c 'docker build -t test8 -f tests/test8-xxx/Dockerfile . && docker run --rm test8'`

## 经验总结

### Docker 相关

- **权限**：vansin 用户需要 docker group。用 `sg docker -c '...'` 执行 docker 命令
- **Bun 镜像**：用 `oven/bun:1` 作为基础镜像
- **node-pty**：如果需要 anet CLI（base 测试），要装 `make g++`
- **端口**：每个 Docker 容器内部用 9200，互不冲突
- **数据库**：每个容器自动创建临时 SQLite，测试结束自动清理

### Server 相关

- **必须设 COMMHUB_AUTH_TOKEN**：不设则 auth 禁用，安全测试会 false positive
- **V3 认证**：register/login 需要先过 global auth，再返回用户 token
- **Login 旋转 token**：login 会使旧 token 失效，测试中 login 后必须更新 AUTH 变量
- **首个用户自动 admin**：第一个 register 的用户 role=admin，后续 role=user

### MCP 相关

- **SSE 不主动断开**：MCP 用 SSE 传输，curl 不会自动返回。必须用 `timeout 5 curl ...`
- **响应格式**：SSE 返回 `event: message\ndata: {...}`，不是纯 JSON
- **Accept header**：MCP 请求需要 `Accept: application/json, text/event-stream`
- **并发 hang**：background `&` 的 mcp_call 会因 SSE 挂起。用 `timeout` 而非 `head -2`

### Token 相关

- **双 token 体系**：utok_（用户级，全局）+ ntok_（网络级，per-node）
- **旧 atok_ 兼容**：resolveToken 自动识别 utok_/ntok_/atok_
- **createToken 需要成员校验**：不能给不属于自己的网络创建 token
- **token scope**：user（utok_）/ network（ntok_）/ full（atok_ 旧版兼容）

### 网络隔离

- **REST 读接口**：需要用 token 绑定的 networkId 过滤查询
- **跨用户访问**：非成员访问网络详情返回 403
- **admin 例外**：系统 admin 可以跨网络访问（by design）
- **测试跨用户**：用非 admin 用户测，避免被 admin 权限绕过

### 测试报告

保存到 `docs/tests/report-testN.txt`，由测试号执行并写入。

## 测试分层原则（从简单到复杂）

测试必须分层，**前一层不过就不跑后面的**。确保被依赖的原子能力先验证可靠，再组合测试复杂场景。

```
Layer 0: 环境就绪
  ├── server 能启动 (health check)
  ├── codex-sdk 能启动
  ├── claude-agent-sdk 能启动
  └── http-api (minimax) 能启动

Layer 1: 认证基础
  ├── 注册 → 拿到 token
  ├── 登录 → token 有效
  ├── auth/me → 用户信息正确
  └── 各 runtime 登录态正常

Layer 2: 单点通信
  ├── agent 注册到 hub
  ├── 发一个任务 (send_task)
  ├── 收到任务 (get_inbox)
  └── 回复任务 (send_reply)

Layer 3: 完整生命周期
  ├── 任务状态机 (delivered→acked→running→replied)
  ├── 重试/取消/转移
  ├── 网络创建/切换
  └── Token CRUD

Layer 4: 多用户协作
  ├── 两个用户各自的网络
  ├── 邀请码 + 加入
  ├── 成员角色 + 权限
  └── 网络隔离验证

Layer 5: 安全和边界
  ├── SQL 注入 / XSS
  ├── 跨用户越权
  ├── 超长/空值/畸形输入
  ├── Token 撤销后失效
  └── 并发 + 压力
```

**核心理念：可靠性 = 每一层都验证过。被依赖的能力必须先测试通过，才能保证上层系统可靠。**

## 分工

| 角色 | 职责 |
|------|------|
| 通信龙 | 写代码、设计、分配任务、汇总结果 |
| 测试1-3号 | 跑 Docker 测试、改造测试套件 |
| 通信牛 | Review 源码 + 测试覆盖 |
| N站马 | Dashboard 开发 |

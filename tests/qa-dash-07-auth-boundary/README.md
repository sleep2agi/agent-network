# qa-dash-07-auth-boundary

**Matrix cell**: [DASH-07](../../docs/qa/test-matrix.md#dashboard-矩阵persona-浏览器端使用者) — 未登录访问被拒（hub-side 视图）。

**Layer**: L1 contract（黑盒，curl hub REST）。

**Why it matters**: dashboard 把 `/api/*` 当 protected route。前端路由保护**绝不能是唯一防线** ——
攻击者可以 curl 直接打 hub。这条测试枚举 dashboard 调的所有端点 + SSE + MCP，
确保**未登录 / 无效 token / 越权**全 401/403。

dashboard 视觉 + 路由由 [docker-e2e SC01-07](https://github.com/sleep2agi/agent-network/tree/main/agent-network/tests/docker-e2e) 在 dashboard repo Playwright 里覆盖（保护资产）。
DASH-07 补**后端 auth boundary** —— OWASP-style 安全断言。

## Run

```bash
sg docker -c 'docker build -t anet-qa-dash-07 -f tests/qa-dash-07-auth-boundary/Dockerfile .'
sg docker -c 'docker run --rm anet-qa-dash-07'
```

预算：cold ~30s（含 npm install），warm ~10s。

## 9 步 / 24 个断言

| 组 | 范围 | 断言 |
|----|------|------|
| A | `/health`, `/api/auth/register`, `/api/auth/login` | 不要 auth → 不是 401 auth-style |
| B | 10 个 protected GET 端点 | 无 Authorization 头 → 401 |
| C | 4 个 protected POST/PUT 端点 | 无 Authorization 头 → 401 |
| D | 10 个 protected GET 端点 | invalid token `utok_garbage_...` → 401 |
| E | 6 个 protected GET 端点 | valid admin utok → 200（sanity） |
| F | `/api/server-logs` admin-only | non-admin utok → 403 |
| G | `/events/<alias>` SSE | 无 auth → 401 |
| H | `/mcp` MCP JSON-RPC | 无 auth → 401 |

总：24 次 HTTP 探测。

## 锁住的契约

#### 1. `requireAuth` 中央门卫

[index.ts L98-122](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L98)：
- 没 token → 401 "unauthorized"
- token 但 resolveToken 找不到 → 401 "invalid token"
- 老的 master token + dev_open 模式仍 fallback（legacy）

所有 `/api/*` 端点都过这道门 —— 漏一个 = 数据泄漏。

#### 2. admin-only 端点单独二审 (`requireAdminAuth`)

[index.ts L138-143](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L138)：先校 token，再查 `user.role === "admin"`。
non-admin → 403。例：`/api/server-logs`（含用户名 + task 内容，admin-only）。

#### 3. SSE + MCP 同样 401

`/events/<alias>` 和 `/mcp` 都走 `requireAuth`。攻击者**不能**通过 SSE 流绕 REST auth。

## 资源

- Docker（`sg docker`）
- node:20-slim + bun + jq + unzip + procps
- `@sleep2agi/agent-network@preview` from npm
- 0 LLM API calls

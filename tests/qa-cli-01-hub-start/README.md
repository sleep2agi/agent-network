# qa-cli-01-hub-start

**Matrix cell**: [CLI-01](../../docs/qa/test-matrix.md#cli-用户矩阵persona-终端开发者) — `anet hub start` UX。

**Layer**: L2 CLI smoke（用户视角，真 anet binary）。

**Why it matters**: [getting-started 第一步](https://github.com/sleep2agi/agent-network/blob/main/docs/getting-started.md)，每个新用户必跑。
banner / port / 凭证文件落地 / 幂等性 任一坏都让新用户卡住。

## Run

```bash
sg docker -c 'docker build -t anet-qa-cli-01 -f tests/qa-cli-01-hub-start/Dockerfile .'
sg docker -c 'docker run --rm anet-qa-cli-01'
```

预算：cold ~30s（含 npm install），warm ~13s。

## 8 步

| # | 动作 | 关键断言 |
|---|------|---------|
| [0] fresh | 删 ~/.anet 和 ~/.commhub |
| [1] `anet hub start` 后台 | /health 60s 内 200 |
| [2] /health | response.ok=true |
| [3] **PIN banner** | "anet hub start" / "Starting CommHub Server" / "127.0.0.1" |
| [4] **PIN admin-utok.json** | mode 600 + 内容 utok_... |
| [5] admin utok 实际可用 | GET /api/auth/me 返 role=admin |
| [6] 端口绑定 | TCP connect ok |
| [7] **PIN 幂等** | 再跑一次 hub start 返 "already running" 不报错不双开 |
| [8] anet -v | 输出版本 |

## 锁住的契约

#### 1. banner 三要素

[cli.ts serverCommand L1893-1955](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L1893)：
- `\n  anet hub start\n` header
- `Starting CommHub Server on port <PORT> (bind <HOST>)...`
- 后续 ready 消息

文档 + setup 脚本 + 用户截图都依赖这三块。一改全挂。

#### 2. admin-utok.json mode 600

[server/src/auth.ts](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts) bootstrap 时写文件用 600。
这是 [R5 test30 step 1](../test30-v0.8-auth-deprecation) 验证过的安全契约 —— R18 用更严格的「+ 文件内容是 utok_ + 实际可用作 admin auth」补强。

#### 3. 幂等 re-run

`anet hub start` 检测已运行的 hub → 打印 "already running" / "already up" → exit 0。
不能：
- 报错 exit 1（用户以为坏了）
- 双开抢端口（数据库锁冲突）

[cli.ts L1925-1933](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L1925)：先 fetch /health，若 200 则跳过 spawn。

## 资源

- Docker（`sg docker`）
- node:20-slim + bun + jq + unzip + procps
- `@sleep2agi/agent-network@preview` from npm
- 0 LLM API calls

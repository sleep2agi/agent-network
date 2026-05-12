# qa-hub-05-roundtrip

**Matrix cell**: [HUB-05](../../docs/qa/test-matrix.md#commhub-矩阵persona-sdk--integration) — register utok → mint ntok → POST `/api/task` → SSE 收到。

**Layer**: L1 contract（用户视角，黑盒）。

**Why it matters**: commhub 的存在理由就是这条闭环。前面的 utok/ntok 鉴权再完美，如果发出去的 task 收不到，commhub 就不存在。

## Run

```bash
sg docker -c 'docker build -t anet-qa-hub-05 -f tests/qa-hub-05-roundtrip/Dockerfile .'
sg docker -c 'docker run --rm anet-qa-hub-05'
```

预算：cold ≤ 90s（含 npm 拉 preview），warm ≤ 20s。

## What it asserts

| 步骤 | 断言 |
|------|------|
| [0] 启动 hub | `/health` 200 |
| [1] login | response.token 以 `utok_` 起 |
| [2] create network | response.network.network_id 非空 |
| [3] mint ntok | response.token 以 `ntok_` 起 |
| [4] SSE 订阅 | 连接建立、看到 `data:` 行 |
| [5] POST /api/task | response.ok=true |
| [6] SSE 推送 | 在 5s 内 SSE 流里出现 task body |
| [7] DB 落库 | GET /api/tasks 能查到这条 task |

任意一步 FAIL 立即 `exit 1`，输出报错原因 + 上下文 log。

## 资源

- Docker（`sg docker`）
- node:20-slim + bun（容器内装）
- `@sleep2agi/agent-network@preview` （npm registry）
- 一个临时 admin password（容器内）

**不需要**：网络外部依赖、真实 LLM key、生产 hub。

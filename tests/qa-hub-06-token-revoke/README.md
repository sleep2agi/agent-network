# qa-hub-06-token-revoke

**Matrix cell**: [HUB-06](../../docs/qa/test-matrix.md#commhub-矩阵persona-sdk--integration) — utok/ntok 撤销契约。

**Layer**: L1 contract（用户视角，黑盒）。

**Why it matters**: 双 token 体系（utok 全局 / ntok 网络）的安全边界。错了就出大事 —
派生 token 是否随母 token 失效，是 fleet-management 类工具的核心契约。

## Run

```bash
sg docker -c 'docker build -t anet-qa-hub-06 -f tests/qa-hub-06-token-revoke/Dockerfile .'
sg docker -c 'docker run --rm anet-qa-hub-06'
```

预算：cold ~30s，warm ~13s。

## What it asserts

| 步骤 | 断言 |
|------|------|
| [0] hub boot | `/health` 200 |
| [1] register + login bob | utok_ 形状 |
| [2] bob 建 network | network_id |
| [3] bob mint ntok | ntok_ 形状 + 拿到 token_id |
| [4] sanity | 两个 token 都能访问 `/api/auth/me` + `/api/networks` |
| [5] admin reset-user bob | CLI 输出新 password + 新 utok |
| [6] **OLD utok 必须 401** | 撤销生效 |
| [7] **PIN：NTOK 仍然 200** | 现实现行为：cascade 不发生（auth.ts revokeOtherUserTokens 只删 network_id IS NULL 行）|
| [8] bob 用 new utok 显式 DELETE 该 ntok | response.ok=true |
| [9] **撤销后 NTOK 必须 401** | 显式撤销生效 |

## 关键发现（test → design）

[7] 是**特征化测试** — pin 当前实现，不是「正确性」断言。
`server/src/auth.ts::revokeOtherUserTokens`（L267）只 DELETE `network_id IS NULL` 的行，
也就是**只撤 utok，不撤 ntok**。

设计权衡：
- **维持现状**：admin 改用户密码 = 让用户重新登录；用户的 fleet（ntok 派出的 agent）继续跑，
  避免因密码重置导致整个 fleet 掉线。
- **改成 cascade**：reset-user 时一并删 ntok。安全性更强但代价是 fleet down。

需要 Vincent / @通信龙 决策。决策后改 auth.ts 并翻转 [7] 的断言即可。

## 资源

- Docker（`sg docker`）
- node:20-slim + bun + jq + unzip
- `@sleep2agi/agent-network@preview` from npm

**不需要**：外部网络、生产 DB、真实 LLM key。

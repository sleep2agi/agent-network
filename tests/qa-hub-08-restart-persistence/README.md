# qa-hub-08-restart-persistence

**Matrix cell**: HUB-08（新增）— hub 进程重启不丢状态，配合 [NODE-04](../../docs/qa/test-matrix.md) 的 hub-side 半边。

**Layer**: L1 contract（用户视角，黑盒）。

**Why it matters**: 真实生产 hub 会因为部署、OOM、机器重启等中断。用户期望「重启后我啥都不丢」。
这条测试 pin 三个持久化契约：session 行、inbox/task 行、ntok 验证。

## Scope

| ✅ 这个测试覆盖（hub-side） | ❌ 不覆盖 |
|--------------------------|----------|
| session 行 SQLite 持久化 | real `anet node start` 进程的 SSE 自动重连 |
| inbox / task 行持久化 | agent 重连后是否自动 ack 旧 backlog |
| ntok hash 持久化（重启后老 token 仍有效） | agent runtime（claude-code-cli / codex）的重启行为 |
| 重启后 SSE 新订阅可用 + 新 task 可推 | |

**未覆盖部分留 NODE-04b**（real anet node 进程 + 杀 hub + 看 agent 自重连）。

## Run

```bash
sg docker -c 'docker build -t anet-qa-hub-08 -f tests/qa-hub-08-restart-persistence/Dockerfile .'
sg docker -c 'docker run --rm anet-qa-hub-08'
```

预算：cold ~30s（含 npm install），warm ~25s（两次 hub bootstrap × ~3s each + 一些 retry 余量）。

## 12 步

| # | 动作 | 断言 |
|---|------|------|
| [0] hub boot 1 | health 200 |
| [1] admin login | utok |
| [2] mint ntok（survive-agent） | ntok |
| [3] report_status(idle) | session 行 |
| [4] admin 发 pre-restart-task | message_id |
| [5] 抓 BEFORE 计数 | sessions ≥ 1, tasks ≥ 1 |
| [6] **kill -TERM hub** | /health 不通 |
| [7] **restart hub 同端口同 DB** | /health 恢复 |
| [8] 重新登录 | 新 utok（密码 hash 持久） |
| [9] **session + task 都还在** | jq filter 匹配 |
| [10] **原 ntok 仍有效**（get_inbox） | ok:true + backlog 含 pre-restart-task |
| [11] SSE 新订阅 connected | "type":"connected" |
| [12] post-restart 新 task 推送 | "type":"new_task" |

## 抠出的契约

| 契约 | 来源 |
|------|------|
| sessions 表持久化 | SQLite WAL，重启自动 reopen |
| api_tokens hash 持久化 | hashToken(ntok) 是 sha256，重启不变 → 老 token 仍 resolveToken |
| inbox + tasks 持久化 | 同上 |
| SSE clients map **不**持久化 | 重启后 in-memory map 清空，**所有旧 SSE 连接断**（用户必须重新订阅） |

最后一条是隐式的 — 测试通过 step [6] curl 报错（连接断）+ step [11] 重新订阅证明。

## 资源

- Docker（`sg docker`）
- node:20-slim + bun + jq + unzip + **procps**（kill -TERM）
- `@sleep2agi/agent-network@preview` from npm
- 0 LLM API calls

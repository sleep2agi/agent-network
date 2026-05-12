# qa-hub-07-sse-reconnect

**Matrix cell**: [HUB-07](../../docs/qa/test-matrix.md#commhub-矩阵persona-sdk--integration) — SSE 断后重连。

**Layer**: L1 contract（用户视角，黑盒）。

**Why it matters**: 真实环境网络永远不稳。agent SSE 断了 5 秒重连这种事每天发生。
这个测试 pin 关键契约：「断开期间的任务不能丢」—— 通过 get_inbox 拿，不是通过重放 SSE。

## Run

```bash
sg docker -c 'docker build -t anet-qa-hub-07 -f tests/qa-hub-07-sse-reconnect/Dockerfile .'
sg docker -c 'docker run --rm anet-qa-hub-07'
```

预算：cold ~30s，warm ~15s。

## 步骤

| # | 动作 | 断言 |
|---|------|------|
| [0] hub boot | health 200 |
| [1] admin login（retry） | utok_ |
| [2] create network + mint ntok（alias=subscriber-A） | ntok_ |
| [3] subscriber-A `report_status(idle)` via MCP | session 行 |
| [4] SSE #1 connect | 看到 `"type":"connected"` |
| [5] admin 发 task-1（online） | SSE1 收 `"type":"new_task"` push |
| [6] kill SSE #1（模拟网络断） | 进程结束 |
| [7] admin 发 task-2（subscriber-A offline） | response.ok=true，inbox row 落库 |
| [8] SSE #2 reconnect | 看到 `"type":"connected"` |
| [9] **PIN**: SSE #2 不重放 task-2 push | `new_task` **不**出现 |
| [10] `get_inbox` MCP 拉 backlog | messages 含 `offline-task-2` |
| [11] admin 发 task-3（在线） | SSE2 收新 push |

## 抠出的契约（事先不显然）

| 契约 | 描述 | 源码 |
|------|------|------|
| SSE 是 fire-and-forget | 没订阅者时 push 丢，不回放 | [push.ts L76-95](https://github.com/sleep2agi/agent-network/blob/main/server/src/push.ts#L76) `pushEvent` 只 enqueue 给现存 clients |
| Backlog 在 DB（inbox 表） | 重连后用 `get_inbox` 拉回 | [tools.ts get_inbox](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L299) SELECT FROM inbox WHERE acked=0 |
| `connected` 事件不带 inbox_count | 重连后 hub 不主动告知 backlog 大小 | [push.ts L35](https://github.com/sleep2agi/agent-network/blob/main/server/src/push.ts#L35) 只发 {type, session, network_id} |

**SDK 设计含义**：agent-node CLI / 任何 SDK 实现都必须在 SSE 重连后**主动**调 get_inbox，
否则离线期间的任务永远拿不到。

## 资源

- Docker（`sg docker`）
- node:20-slim + bun + jq + unzip
- `@sleep2agi/agent-network@preview` from npm

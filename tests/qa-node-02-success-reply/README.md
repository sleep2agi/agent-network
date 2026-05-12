# qa-node-02-success-reply

**Matrix cell**: [NODE-02](../../docs/qa/test-matrix.md#agent-node-矩阵persona-runtime-adapter) — agent 成功回复路径。

**Layer**: L1 contract（用户视角，黑盒）。

**Why it matters**: [docker-e2e SC05](../../agent-network/tests/docker-e2e/) 已测了「LLM key 错时 reply.status=failed」，
但**成功路径**（status=replied + result 文本回填）没单独测。真 LLM 烧钱不可取，
用 **mock-via-MCP** — 直接 curl 打 `send_reply` MCP 工具，把 agent 当黑盒。

## Run

```bash
sg docker -c 'docker build -t anet-qa-node-02 -f tests/qa-node-02-success-reply/Dockerfile .'
sg docker -c 'docker run --rm anet-qa-node-02'
```

预算：cold ~30s，warm ~13s。

## What it asserts

| 步骤 | 断言 |
|------|------|
| [0] hub boot | health 200 |
| [1] admin login | utok_ |
| [2] admin 建 network | network_id |
| [3] mint ntok for mock-echo agent | ntok_ |
| [4] mock agent `report_status(idle)` via MCP | session 行落库 |
| [5] admin POST /api/task | task_id |
| [6] **PRE: task.status = 'delivered'** | 状态机入口 |
| [7] mock agent `send_reply(replied, in_reply_to=task_id, text)` via MCP | response.ok=true |
| [8] **POST: task.status = 'replied' + result = text + completed_at set** | 状态机出口 |
| [9] /api/messages 能看到 reply 文本 | sender side visibility |

## 关键设计 — Mock via MCP

**不需要真 agent-node CLI**，不需要真 LLM。直接 curl 打 `/mcp` JSON-RPC：
```http
POST /mcp
Authorization: Bearer <ntok>
Accept: application/json, text/event-stream
MCP-Protocol-Version: 2025-03-26

{"jsonrpc":"2.0","id":1,"method":"tools/call",
 "params":{"name":"send_reply",
           "arguments":{"alias":"admin","text":"...","in_reply_to":"<task_id>",
                        "status":"replied","from_session":"mock-echo"}}}
```

Response 是 SSE-framed，用 `sed -n 's/^data: //p' | head -1` 解。

这种 mock 测的是 **commhub 对 agent 行为的契约**，不是 agent CLI 本身 — 后者由 e2e
覆盖（带真 fake-key 跑流程）。两层互补，**不重复**。

## 资源

- Docker（`sg docker`）
- node:20-slim + bun + jq + unzip
- `@sleep2agi/agent-network@preview` （hub 来源）

**不需要**：真 LLM key、agent-node 进程、SSE 长连接订阅（这是「我能回」的测试，
SSE 接收已由 [qa-hub-05](../qa-hub-05-roundtrip/) 覆盖）。

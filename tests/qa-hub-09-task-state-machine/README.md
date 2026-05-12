# qa-hub-09-task-state-machine

**Matrix cell**: [HUB-09](../../docs/qa/test-matrix.md#commhub-矩阵persona-sdk--integration) — task 完整状态机。

**Layer**: L1 contract（用户视角，黑盒）。

**Why it matters**: task 三种 terminal state（replied / failed / cancelled）+ 终态不可逆。
- `replied` 分支：[NODE-02](../qa-node-02-success-reply/) R6 已测
- `failed` 分支：[docker-e2e SC05](../../agent-network/tests/docker-e2e/) 已测
- `cancelled` 分支：**完全没人测过**
- 终态 no-op 契约：R6 在 [tools.ts L613](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L613) 抠出但没单独 pin

HUB-09 一次 pin 全 — 任何 task 状态机改动秒拦截。

## Run

```bash
sg docker -c 'docker build -t anet-qa-hub-09 -f tests/qa-hub-09-task-state-machine/Dockerfile .'
sg docker -c 'docker run --rm anet-qa-hub-09'
```

预算：cold ~30s（含 npm install），warm ~10s。

## 9 步

| # | 动作 | 断言 |
|---|------|------|
| [0-2] | hub + admin + network + ntok + report_status(idle) | session 行 |
| [3] | **delivered → replied**: send + send_reply(replied) | status=replied + result=text + completed_at |
| [4] | **delivered → failed**: send + send_reply(failed) | status=failed + completed_at |
| [5] | **delivered → cancelled**: send + cancel_task | status=cancelled + result 含 reason + completed_at |
| [6] | cancelled → inbox auto-acked | get_inbox 不含 task-cancelled |
| [7] | **PIN: 已 replied 的 task 再 send_reply** | task.result/status 不变（silent no-op） |
| [8] | **PIN: 已 cancelled 的 task 再 cancel_task** | response.ok=false + DB 不变 |
| [9] | 全 3 terminal tasks completed_at + status 正确 | sanity |

## 抠出的额外契约（R14 实测发现）

**cancel_task 需要 network-scoped writer（NTOK）**，UTOK 直接调返回 `{"ok":false,"error":"permission_denied"}`。

[tools.ts L812](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L812)：
```ts
const effectiveNetId = getNetworkId(null);
if (!canWrite(effectiveNetId)) return { ... "permission_denied" };
```

UTOK 没有 inherent network，`getNetworkId(null)` 拿不到 network，`canWrite(null)` false。
**SDK 含义**：admin / dashboard 想取消任务，要么用 NTOK，要么通过 REST 端点（不存在）。
要么 hub 加 UTOK + 显式 network_id 支持。

(这是测试逼出来的真 SDK 设计 gap。)

## 锁住的契约

#### 1. terminal state 三选一

[tools.ts send_reply L595](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L595)：
```ts
status: z.enum(["replied", "failed", "cancelled"]).optional().default("replied")
```

加 [cancel_task](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L802)，三种到达 terminal 的路径都有了。
未来引入新 terminal state（比如 `timeout`）必须同步扩 enum + 状态机检查。

#### 2. terminal 不可逆 — silent + ok:false

- `send_reply` 在终态上 silently 不更新 task 行（不报错）→ SDK 重试会以为成功
- `cancel_task` 在终态上返回 ok:false（hard reject）

不一致的行为，但这是 **当前的真实契约**，pin 住等 maintainer 决定要不要统一。

#### 3. cancelled 自动 ack inbox

[tools.ts L820-826](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L820)：cancel 时也把 inbox 行 `acked=1`，
防止 agent 之后 `get_inbox` 还看到这个 task 误处理。R9 (HUB-07) 测的是 SSE backlog，
HUB-09 补 cancelled 不进 backlog。

## 资源

- Docker（`sg docker`）
- node:20-slim + bun + jq + unzip + procps
- `@sleep2agi/agent-network@preview` from npm
- 0 LLM API calls

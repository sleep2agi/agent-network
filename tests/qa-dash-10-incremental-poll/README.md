# qa-dash-10-incremental-poll

**Matrix cell**: DASH-10（重新定义）— dashboard 增量轮询 `since=` 过滤契约。

**Layer**: L1 contract（黑盒）。

**Why it matters**: dashboard 用 utok 不能直接 SSE 订阅（SSE 需 ntok + network_id）。
所以 dashboard 实际**用增量轮询**：每隔 N 秒打 `?since=<last_seen>` 拿新数据。

如果 `since=` 过滤被忽略 → dashboard 重复展示（每次拉全量）。
如果 `since=` 过滤太狠 → dashboard 丢新消息。

R20 pin **/api/messages** 和 **/api/completions** 的 since 行为，并抠出两端点
**时间戳格式不一致**的 gap。

## Run

```bash
sg docker -c 'docker build -t anet-qa-dash-10 -f tests/qa-dash-10-incremental-poll/Dockerfile .'
sg docker -c 'docker run --rm anet-qa-dash-10'
```

预算：cold ~30s，warm ~14s（包含 2×1.5s sleep 等时钟 tick）。

## 9 步

| # | 动作 | 关键断言 |
|---|------|---------|
| [0-1] | hub + admin + network + agent | setup |
| [2] | send msg-A → 1.5s → 抓 T_BEFORE_B → 1.5s → send msg-B | 时间锚 |
| [3] | `/api/messages` 无 since | A + B 都在 |
| [4] | `/api/messages?since=T_BEFORE_B` | **msg-B 在，msg-A 被过滤**（增量生效） |
| [5] | `/api/messages?since=<2099 future>` | 0 results |
| [6] | send + reply msg-C → 生成 completion | — |
| [7] | `/api/completions` 默认 since | ≥ 1 |
| [8] | `/api/completions?since=<ISO past>` | ≥ 1 ;  `?since=<ISO future>` → 0 |
| [9] | **GAP 文档** | messages 用 SQLite datetime，completions 用 ISO |

## 抠出的 contract gap

**`/api/messages` 跟 `/api/completions` 用不一样的 timestamp 格式**：

```js
// /api/messages (index.ts L937)
const since = url.searchParams.get("since") ?? new Date(...).toISOString().replace("T", " ").slice(0, 19);
// → "YYYY-MM-DD HH:MM:SS"  (SQLite datetime format, NO 'T', NO ms, NO 'Z')

// /api/completions (index.ts L1081)
const since = url.searchParams.get("since") ?? new Date(...).toISOString();
// → "YYYY-MM-DDTHH:MM:SS.sssZ"  (full ISO 8601)
```

SDK 客户端要给每个端点用各自的 format，或要做转换。**待 @通信龙 / Vincent 评是否统一**。

待评 SDK finding +1（累计 10 条）。

### 附 GAP：completions 行只来自 report_completion，**不**来自 send_reply

R20 第一次跑 step [7] 0 行 — 因为我用了 `send_reply`。
[tools.ts L234](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L234) `INSERT INTO completions` 只在 `report_completion` 里。
[tools.ts send_reply L611+](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L611) 只 UPDATE tasks/inbox，**不写 completions**。

**SDK 含义**：agent 用 `send_reply` 回任务，dashboard 看 `/api/completions` 是看不到的（只能看 `/api/tasks?status=replied`）。
如果 agent 要让 dashboard 的 completions 视图工作，**必须**调 `report_completion`。

待评 SDK finding +1（累计 11 条）。

## 锁住的契约

1. `/api/messages?since=` 是真过滤（不是被忽略）
2. `/api/completions?since=` 是真过滤
3. 两者的 timestamp 格式不同（gap 文档）

## 资源

- Docker（`sg docker`）
- node:20-slim + bun + jq + unzip + procps
- `@sleep2agi/agent-network@preview` from npm
- 0 LLM API calls

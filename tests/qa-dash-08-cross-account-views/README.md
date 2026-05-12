# qa-dash-08-cross-account-views

**Matrix cell**: DASH-08（新增）— 跨账号节点 / 聚合视图隔离。

**Layer**: L1 contract（黑盒，多端点跨用户枚举）。

**Why it matters**: Dashboard 展示一堆聚合视图（节点、统计、completion、task 过滤）。
[R17 HUB-06b](../qa-hub-06b-cross-user-isolation/) 覆盖了 `/api/networks` `/api/tasks`（无 filter）`/api/status` `/api/messages`。
**DASH-08 补 dashboard 实际用的其余端点**：

| 端点 | R17 | R19 |
|------|-----|-----|
| /api/networks | ✅ | — |
| /api/tasks（无 filter） | ✅ | — |
| /api/status | ✅ | — |
| /api/messages | ✅ | — |
| **/api/nodes** | — | ✅ |
| **/api/stats** | — | ✅ |
| **/api/completions** | — | ✅ |
| **/api/tasks?to_name=…** | — | ✅ |
| **/api/tasks?from_name=…** | — | ✅ |
| **/api/auth/tokens** | — | ✅ |
| **/api/task_events** | — | ✅ |

R19 = OWASP A01 IDOR class **dashboard 维度**。

## Run

```bash
sg docker -c 'docker build -t anet-qa-dash-08 -f tests/qa-dash-08-cross-account-views/Dockerfile .'
sg docker -c 'docker run --rm anet-qa-dash-08'
```

预算：cold ~30s，warm ~12s。

## 11 步

| # | 探测 | bob 视角断言 |
|---|------|------------|
| [0-2] | setup | alice 建 private + agent + send + reply |
| [3] | `/api/nodes` | 不含 alice-secret-agent |
| [4] | `/api/stats` | recent_tasks 不含 alice / tasks.total=0 |
| [5] | `/api/completions` | 不含 "alice-private" 字串 |
| [6] | `/api/tasks?to_name=alice-secret-agent` | 不返 alice 的 task |
| [7] | `/api/tasks?from_name=alice` | 不返 alice 的 task |
| [8] | `/api/auth/tokens` | 只含 bob 自己的 token |
| [9] | `/api/task_events` | 不返 alice 的 task_id 事件 |
| [10] | 伪造 ntok | 401 |
| [11] | alice sanity | alice 看得到自己的 |

## 锁住的契约

`addNetworkScope` 应用于**所有**列表查询（[index.ts](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts) 各端点 SQL inject）：

```sql
WHERE network_id IN (SELECT network_id FROM network_members WHERE user_id = ?)
```

bob 不是 alice 的任何 network 成员 → 所有 list/agg 查询返空。

显式过滤参数（`?to_name=`, `?from_name=`, `?task_id=`, `?network_id=`）都在 `addNetworkScope` 之后追加 → 不能绕。

## 资源

- Docker（`sg docker`）
- node:20-slim + bun + jq + unzip + procps
- `@sleep2agi/agent-network@preview` from npm
- 0 LLM API calls

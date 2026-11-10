# 0.9.0-preview.184

> 两件只增不改的事：给「拦截率」补上**分母**（#2823 → #525），以及给客户端一份**能不能替你重启**的判断（#1511）。

## 1. `node_tool_calls`：让「0 次拦截」变得可判断

`node_permission_log` 只记 **would-be denial**（`nodeDecide` 里 `if (!verdict) return false`），
所以生产上 30 天 0 行时，分不清「没人越界」和「几乎没人碰过这些工具」——而这两者的结论完全相反。

新增一张**独立的**计数表：

```
node_tool_calls (network_id, node_id, tool, hour, hits)
  · 只在 nodeDecide 入口 +1（那里的入参就是 classified 工具调用）
  · 与拒绝日志同纪律：按 (节点, 工具, 小时) 合并 + hits，30 天保留，20000 行上限
  · **独立成表**：放行样本绝不混进 node_permission_log
```

报表 `GET /api/networks/:id/node-permission-report` 只增一个字段：

```
tool_calls: { total, by_tool: [{ tool, hits }] }
```

`total`（会被拦的次数）语义不变 —— 有测试专门钉住「放行调用不许污染它」。

## 2. `restart_readiness`：客户端能二选一告诉用户

`GET /api/nodes` 每行多一格：

```json
"restart_readiness": { "path": "restart_node", "in_flight": 0, "can_restart_now": true }
```

| `path` | 含义 |
|---|---|
| `restart_node` | 被 created-daemon 监督，exit-75 会被自动拉起 |
| `stop_then_start` | adopt 来的节点：`restart_node` 拒绝，但 daemon 仍能 Stop→Start |
| `manual` | 没人管，必须上机 |

`in_flight` 与 `can_restart_now` 与 `stop_node` / `restart_node` **同一份判据**（`countInFlightTasks` 已抽到
`server/src/node-in-flight-tasks.ts`，三处共用一份 SQL）。`can_restart_now` 是快照，真发起时服务端会重判
（`node_busy_in_flight` / `adopted_restart_requires_daemon`），客户端要按错误码兜底。

## 测试

```
node-permissions-http   19 pass（原 15 + 计数 4）   变异对照：去掉计数 → 3 条新用例全红
restart-readiness-http   5 pass                      变异对照：can_restart_now 忽略在途 → 第 2 条红
回归 stop-delete-node 55 · node-daemon-bindings 9 · node-id-alias 28 · rest-explicit-columns 6
```

## Install

```bash
set -e
npm install -g @sleep2agi/commhub-server@0.9.0-preview.184
commhub-server --version   # 0.9.0-preview.184
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.184
commhub-server --version   # 0.9.0-preview.184
```

版本化运行时目录（`HUB_RUNTIME_DIR`）：依赖版本改 `0.9.0-preview.184` → `npm install` → 指到新目录重启。
上一版目录保留即可回滚；**只增不改**：新表 + 新字段，回滚到 `.183` 安全（旧代码不读它们）。

## 验收

```bash
# 1) 分母开始累积（需要真实节点调用过 classified 工具；一天后再看）
curl -sS http://127.0.0.1:9200/api/networks/<net>/node-permission-report \
  -H "Authorization: Bearer <user-token>" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["tool_calls"]["total"], d["tool_calls"]["by_tool"][:3])'

# 2) 重启判据（每个节点一行）
curl -sS "http://127.0.0.1:9200/api/nodes?network_id=<net>" \
  -H "Authorization: Bearer <user-token>" | python3 -c 'import sys,json;d=json.load(sys.stdin);print([(n["alias"],n["restart_readiness"]["path"],n["restart_readiness"]["in_flight"]) for n in d["nodes"][:5]])'
```

回滚：`HUB_RUNTIME_DIR` 指回 `.183` 目录并重启；无数据迁移。
